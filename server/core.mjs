// The library's moving parts, shared by the HTTP routes, MCP and chat: builds (one at a time,
// with one queued behind), the search index, Jev for new bookmarks, the X capture and media
// archive workers, the source check, and the status Settings shows.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './config/paths.mjs';
import { keysStatus } from './config/keys.mjs';
import { authEnabled } from './http/auth.mjs';
import { build } from './library/build.mjs';
import { readState } from './library/state.mjs';
import { SearchIndex } from './library/search.mjs';
import { Enricher } from './capture/enricher.mjs';
import { Archiver } from './capture/archive.mjs';
import { lockHolder } from './capture/lock.mjs';
import { classifyMany, needsClassification } from './classify/jev.mjs';
import { MODELS } from './agent/chat.mjs';
import { createOps } from './agent/ops/index.mjs';

export function createCore({ log }) {
  let lastBuild = null, building = null, rebuildAgain = null, sourceMtime = 0;

  async function rebuild(reason) {
    // A change made while a build is running (a new file, a tag) needs one more build after it;
    // everyone who asks meanwhile shares that one.
    if (building) return (rebuildAgain ||= building.catch(() => {}).then(() => { rebuildAgain = null; return rebuild(reason); }));
    building = (async () => {
      try {
        const result = await build({ log: (m) => log(`[build:${reason}] ${m}`) });
        lastBuild = { at: result.generatedAt, total: result.total, enriched: result.enriched, threads: result.threads, reason };
        // Every build (new bookmarks, new captures) queues any media not yet saved locally.
        archiver.enqueue(result.records);
        return result;
      } finally { building = null; }
    })();
    return building;
  }

  // New bookmarks: once their thread is captured, classify them with Jev.
  let classifying = false;
  async function classifyNew(result) {
    if (classifying || !process.env.TYPESAFE_API_KEY || lockHolder() || !result?.records) return;
    classifying = true;
    try {
      const ready = [];
      // Files just added are tagged by their upload (with suggested topics); don't race it.
      for (const r of result.records) if (ready.length < 50 && !ops.isTagging(r.id) && await needsClassification(r)) ready.push(r);
      if (!ready.length) return;
      const res = await classifyMany(ready, result.concepts, { concurrency: 4, log });
      log(`[jev] classified ${res.ok} new bookmark(s)`);
      await rebuild('jev');
    } finally { classifying = false; }
  }

  const enricher = new Enricher({ log, onBatch: async () => classifyNew(await rebuild('enrich')) });
  const archiver = new Archiver({ log });

  // Search index for chat, rebuilt whenever the build on disk changes (server or backfill script).
  let index = null, indexAt = null;
  async function getIndex() {
    const meta = JSON.parse(await fs.readFile(path.join(paths.build, 'meta.json'), 'utf8'));
    if (!index || indexAt !== meta.generatedAt) {
      const [data, tax] = await Promise.all(['bookmarks.json', 'taxonomy.json'].map(async f => JSON.parse(await fs.readFile(path.join(paths.build, f), 'utf8'))));
      index = new SearchIndex(data.records, tax.concepts);
      indexAt = meta.generatedAt;
    }
    return index;
  }
  const ops = createOps({ getIndex, rebuild, enricher, log });

  // Rebuild when the FieldTheory export changed (or always, with force), then capture and classify what's new.
  async function checkSource({ force = false } = {}) {
    if (force) sourceMtime = 0;
    try {
      const { mtimeMs } = await fs.stat(paths.source);
      if (mtimeMs === sourceMtime) return null;
      sourceMtime = mtimeMs;
      const result = await rebuild('source');
      const state = await readState();
      if (state.settings.enrich !== false) enricher.enqueue(result.pending);
      classifyNew(result);
      return result;
    } catch (e) { log(`source check failed: ${e.message}`); return null; }
  }

  async function status() {
    const state = await readState();
    let source = null;
    try { const s = await fs.stat(paths.source); source = { path: paths.source, modifiedAt: new Date(s.mtimeMs).toISOString() }; } catch {}
    let meta = null, backfill = null;
    try { meta = JSON.parse(await fs.readFile(path.join(paths.build, 'meta.json'), 'utf8')); } catch {}
    try { backfill = { ...JSON.parse(await fs.readFile(path.join(paths.cache, 'backfill.json'), 'utf8')), running: !!lockHolder() }; } catch {}
    return {
      ok: true,
      service: 'corpus',
      build: meta ? { at: meta.generatedAt, total: meta.total, enriched: meta.enriched, threads: meta.threads, classified: meta.classified } : lastBuild,
      backfill,
      building: !!building,
      source,
      enrichment: { ...enricher.status(), enabled: state.settings.enrich !== false },
      archive: { ...archiver.status(), enabled: state.settings.archive !== false },
      classifiers: { typesafe: !!process.env.TYPESAFE_API_KEY, openrouter: !!process.env.OPENROUTER_API_KEY },
      chat: {
        models: MODELS.filter(m => !state.settings.disabledModels?.includes(m.id)).map(({ id, label, note }) => ({ id, label, note })),
        allModels: MODELS.map(({ id, label, note }) => ({ id, label, note, enabled: !state.settings.disabledModels?.includes(id) })),
        available: !!process.env.OPENROUTER_API_KEY
      },
      keys: await keysStatus(),
      passwordProtected: authEnabled()
    };
  }

  return { log, ops, enricher, archiver, rebuild, getIndex, checkSource, status, lastBuild: () => lastBuild };
}
