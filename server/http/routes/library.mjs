// The library itself: status, your overrides (tags, triage, scratchpads, highlights), the
// taxonomy, settings, and rebuilding. Capture of a single bookmark and its archive status too.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from '../../config/paths.mjs';
import { readState, writeState } from '../../library/state.mjs';
import { defaultConcepts } from '../../library/taxonomy.mjs';
import { lockHolder } from '../../capture/lock.mjs';
import { requestPriority } from '../../capture/priority.mjs';
import { MODELS } from '../../agent/chat.mjs';
import { fetchPage, isXUrl } from '../../capture/pages.mjs';
import { send, readJson } from '../respond.mjs';

const defaultIds = new Set(defaultConcepts().map(c => c.id));
// Pages that are never articles, whatever their text says.
const NOT_ARTICLES = /^https?:\/\/([\w-]+\.)*(youtube\.com|youtu\.be|vimeo\.com|open\.spotify\.com|music\.apple\.com|apps\.apple\.com|play\.google\.com|tiktok\.com|instagram\.com)\//i;
const linkedUrl = (rec) => { const u = rec.card?.url || rec.links?.find(l => !isXUrl(l)); return u && !isXUrl(u) && !NOT_ARTICLES.test(u) ? u : null; };

export function libraryRoutes(r) {
  r.get('/api/status', async ({ res, core }) => send(res, 200, await core.status()));
  r.get('/api/state', async ({ res }) => { const s = await readState(); send(res, 200, { overrides: s.overrides, taxonomy: s.taxonomy, settings: s.settings, updatedAt: s.updatedAt || null }); });

  // body: { ids: [..], patch: { add?, remove?, triaged?, scratchpad?, highlights?, … } }; null values clear a field
  r.put('/api/overrides', async ({ req, res }) => {
    const { ids = [], patch = {} } = await readJson(req);
    const s = await writeState(st => {
      for (const id of ids.slice(0, 5000)) {
        const next = { ...(st.overrides[id] || {}) };
        for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
        if (patch.deleted === true && !next.deletedAt) next.deletedAt = new Date().toISOString();
        if (patch.deleted === null || patch.deleted === false) { delete next.deleted; delete next.deletedAt; }
        next.updatedAt = new Date().toISOString();
        st.overrides[id] = next;
      }
    });
    send(res, 200, { ok: true, overrides: Object.fromEntries(ids.map(id => [id, s.overrides[id]])) });
  });
  // Undo/redo: set each bookmark's override to an exact earlier snapshot (null = none).
  r.put('/api/overrides/restore', async ({ req, res }) => {
    const { entries = {} } = await readJson(req);
    await writeState(st => { for (const [id, o] of Object.entries(entries).slice(0, 5000)) { if (o && Object.keys(o).length) st.overrides[id] = o; else delete st.overrides[id]; } });
    send(res, 200, { ok: true });
  });

  // body: { id, patch } where patch null deletes a user concept / retires a default one
  r.put('/api/taxonomy', async ({ req, res, core }) => {
    const { id, patch } = await readJson(req);
    if (!/^[a-z]+:[\p{L}\p{N}/_.-]+$/u.test(id || '')) return send(res, 400, { ok: false, error: 'Invalid concept id' });
    await writeState(st => {
      if (patch !== null) st.taxonomy.concepts[id] = { ...(st.taxonomy.concepts[id] || {}), ...patch };
      else if (defaultIds.has(id)) st.taxonomy.concepts[id] = { deleted: true };
      else delete st.taxonomy.concepts[id];
    });
    await core.rebuild('taxonomy');
    send(res, 200, { ok: true });
  });
  r.delete('/api/taxonomy', async ({ req, res, core }) => {
    const { id } = await readJson(req);
    await writeState(st => { delete st.taxonomy.concepts[id]; });
    await core.rebuild('taxonomy');
    send(res, 200, { ok: true });
  });

  r.put('/api/settings', async ({ req, res, core }) => {
    const patch = await readJson(req);
    if (patch.disabledModels && patch.disabledModels.length >= MODELS.length) return send(res, 400, { ok: false, error: 'At least one model must stay enabled' });
    const s = await writeState(st => { Object.assign(st.settings, patch); });
    if ('enrich' in patch) { core.enricher.paused = patch.enrich === false; if (!core.enricher.paused) core.enricher.kick(); }
    if ('archive' in patch) { core.archiver.paused = patch.archive === false; if (!core.archiver.paused) core.archiver.enqueue((await core.getIndex()).records); }
    send(res, 200, { ok: true, settings: s.settings });
  });

  r.post('/api/refresh', async ({ res, core }) => {
    const result = await core.checkSource({ force: true });
    send(res, 200, { ok: true, build: core.lastBuild(), pending: result?.pending.length ?? 0 });
  });
  r.post('/api/backfill', ({ res }) => {
    if (lockHolder()) return send(res, 200, { ok: false, error: 'Backfill already running' });
    const child = spawn(process.execPath, [path.join(paths.root, 'scripts', 'backfill.mjs')], { detached: true, stdio: 'ignore', cwd: paths.root, env: process.env });
    child.unref();
    send(res, 200, { ok: true });
  });

  // One bookmark's capture from X: fetched on request (opened in the reader), then polled for.
  r.get('/api/enrichment/:id', async ({ res, params, core }) => {
    if (!/^\d+$/.test(params.id)) return send(res, 400, { ok: false });
    try { send(res, 200, await fs.readFile(path.join(paths.enrich, `${params.id}.json`), 'utf8')); }
    catch { send(res, 404, { ok: false, waitingUntil: core.enricher.status().waitingUntil }); }
  });
  r.post('/api/enrich/priority', async ({ req, res, core }) => {
    const { id } = await readJson(req);
    if (!/^\d+$/.test(String(id))) return send(res, 400, { ok: false });
    requestPriority(String(id));
    core.enricher.kick();
    send(res, 200, { ok: true, backfill: !!lockHolder() });
  });
  // The article a post links to, read the first time it's opened (then cached), for the reader to
  // show under the post. Only pages that read as articles come back.
  r.get('/api/linked/:id', async ({ res, params, core }) => {
    const rec = (await core.getIndex()).byId.get(params.id);
    if (!rec || rec.provider !== 'twitter') return send(res, 404, { ok: false });
    const url = linkedUrl(rec);
    const page = url && await fetchPage(url);
    const a = page?.article;
    if (!page?.ok || !a?.isArticle) return send(res, 200, { ok: false, url });
    send(res, 200, { ok: true, url: page.url, article: { title: a.title, byline: a.byline, site: a.site, siteName: a.siteName, published: a.published, cover: a.cover, words: a.words, blocks: a.blocks } });
  });
  r.get('/api/archive/:id', async ({ res, params, core }) => {
    const rec = (await core.getIndex()).byId.get(params.id);
    if (!rec) return send(res, 404, { ok: false });
    send(res, 200, { ok: true, captured: rec.enrichment === 'ok', ...core.archiver.recordStatus(rec) });
  });
}
