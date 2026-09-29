import './lib/env.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { paths, assertSeparateState } from './lib/paths.mjs';
import { purgeTrash } from './lib/trash.mjs';
import { build } from './lib/build.mjs';
import { readState, writeState } from './lib/state.mjs';
import { Enricher } from './lib/enricher.mjs';
import { defaultConcepts } from './lib/taxonomy.mjs';
import { lockHolder } from './lib/lock.mjs';
import { requestPriority } from './lib/priority.mjs';
import { authEnabled, isAuthed, login, logoutCookie } from './lib/auth.mjs';
import { classifyMany, needsClassification, testTypesafeKey } from './lib/jev.mjs';
import { SearchIndex } from './lib/search.mjs';
import { MODELS, runChat, listChats, getChat, deleteChat, setChatArchived, testOpenRouterKey } from './lib/chat.mjs';
import { KEY_NAMES, initKeys, keysStatus, setKey } from './lib/keys.mjs';
import { createOps } from './lib/ops.mjs';
import { handleMcp } from './lib/mcp.mjs';
import { listSkills } from './lib/skills.mjs';
import crypto from 'node:crypto';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const pollMs = Number(process.env.SOURCE_POLL_MS || 5 * 60_000);
const defaultIds = new Set(defaultConcepts().map(c => c.id));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

let lastBuild = null;
let building = null;
let sourceMtime = 0;

async function rebuild(reason) {
  if (building) return building;
  building = (async () => {
    try {
      const result = await build({ log: (m) => log(`[build:${reason}] ${m}`) });
      lastBuild = { at: result.generatedAt, total: result.total, enriched: result.enriched, threads: result.threads, reason };
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
    for (const r of result.records) if (ready.length < 50 && await needsClassification(r)) ready.push(r);
    if (!ready.length) return;
    const res = await classifyMany(ready, result.concepts, { concurrency: 4, log });
    log(`[jev] classified ${res.ok} new bookmark(s)`);
    await rebuild('jev');
  } finally { classifying = false; }
}

const enricher = new Enricher({ log, onBatch: async () => classifyNew(await rebuild('enrich')) });

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
const mcpToken = process.env.CORPUS_MCP_TOKEN || '';
const bearerOk = (req) => { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : ''; return !!mcpToken && t.length === mcpToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(mcpToken)); };
const chatWindow = [];
const chatLimit = Number(process.env.CHAT_LIMIT_PER_HOUR || 200);

async function checkSource() {
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2_000_000) throw new Error('Body too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function originOf(req) {
  if (process.env.CORPUS_PUBLIC_URL) return process.env.CORPUS_PUBLIC_URL.replace(/\/+$/, '');
  const https = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-visitor']?.includes('https');
  return `${https ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`}`;
}

async function serveFile(req, res, file, cache) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('not a file');
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return; }
  const headers = { 'content-type': mime[ext] || 'application/octet-stream', 'cache-control': cache, etag };
  // Lets the service worker tell the app shell from the sign-in page.
  const base = path.basename(file);
  if (base === 'index.html') headers['x-corpus-page'] = 'app';
  if (base === 'login.html') headers['x-corpus-page'] = 'login';
  if (base === 'sw.js') headers['service-worker-allowed'] = '/';
  // Link previews need absolute URLs, so pages carry %ORIGIN% for the public address.
  if (ext === '.html') {
    const html = Buffer.from((await fs.readFile(file, 'utf8')).replaceAll('%ORIGIN%', originOf(req)));
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = gzip ? zlib.gzipSync(html) : html;
    res.writeHead(200, { ...headers, ...(gzip && { 'content-encoding': 'gzip', vary: 'accept-encoding' }), 'content-length': body.length });
    res.end(body);
    return;
  }
  const compressible = ['.json', '.js', '.css', '.html', '.svg'].includes(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (compressible) { res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' }); createReadStream(file).pipe(zlib.createGzip()).pipe(res); }
  else { res.writeHead(200, { ...headers, 'content-length': stat.size }); createReadStream(file).pipe(res); }
}

const within = (dir, rel) => { const f = path.resolve(dir, `.${rel}`); return f.startsWith(dir + path.sep) ? f : null; };

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://local');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'corpus' });
    if (url.pathname === '/mcp') {
      // Agents (Claude Code, Hermes, …) authenticate with the bearer token; the signed-in site works too.
      if (!bearerOk(req) && !isAuthed(req)) return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { 'www-authenticate': 'Bearer realm="corpus"' });
      if (req.method === 'GET') return send(res, 405, { error: 'This server does not stream server-initiated messages; POST JSON-RPC instead.' }, { allow: 'POST, DELETE' });
      if (req.method === 'DELETE') return send(res, 200, { ok: true });
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      let msg; try { msg = await readBody(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const out = await handleMcp(msg, ops, log);
      if (!out) { res.writeHead(202); res.end(); return; }
      return send(res, 200, out, { 'mcp-session-id': req.headers['mcp-session-id'] || 'corpus' });
    }
    if (url.pathname.startsWith('/api/')) {
      if (route === 'POST /api/login') {
        const { password } = await readBody(req);
        const r = login(req, password);
        return send(res, r.status, { ok: r.ok, error: r.error }, r.cookie ? { 'set-cookie': r.cookie } : {});
      }
      if (route === 'POST /api/logout') return send(res, 200, { ok: true }, { 'set-cookie': logoutCookie(req) });
      if (!isAuthed(req)) return send(res, 401, { ok: false, error: 'Sign in required' });
      if (req.method === 'GET' && url.pathname.startsWith('/api/enrichment/')) {
        const id = url.pathname.split('/').pop();
        if (!/^\d+$/.test(id)) return send(res, 400, { ok: false });
        try { return send(res, 200, await fs.readFile(path.join(paths.enrich, `${id}.json`), 'utf8')); }
        catch { return send(res, 404, { ok: false, waitingUntil: enricher.status().waitingUntil }); }
      }
      if (route === 'POST /api/enrich/priority') {
        const { id } = await readBody(req);
        if (!/^\d+$/.test(String(id))) return send(res, 400, { ok: false });
        requestPriority(String(id));
        enricher.kick();
        return send(res, 200, { ok: true, backfill: !!lockHolder() });
      }
      if (route === 'GET /api/status') return send(res, 200, await status());
      if (route === 'GET /api/skills') return send(res, 200, { skills: await listSkills() });
      if (route === 'GET /api/mcp') return send(res, 200, { url: `${req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-visitor'] ? 'https' : 'http'}://${req.headers.host}/mcp`, token: mcpToken || null, tools: ops.tools.length });
      if (route === 'POST /api/ops') { const { tool, args } = await readBody(req); try { return send(res, 200, await ops.call(tool, args)); } catch (e) { return send(res, 400, { ok: false, error: e.message }); } }
      if (route === 'GET /api/chats') return send(res, 200, { chats: await listChats({ scope: url.searchParams.get('scope'), bookmark: url.searchParams.get('bookmark'), archived: url.searchParams.get('archived') === '1' }) });
      if (req.method === 'GET' && url.pathname.startsWith('/api/chats/')) { const c = await getChat(url.pathname.split('/').pop()); return c ? send(res, 200, c) : send(res, 404, { ok: false }); }
      if (req.method === 'PUT' && url.pathname.startsWith('/api/chats/')) {
        const { archived } = await readBody(req);
        const c = await setChatArchived(url.pathname.split('/').pop(), archived);
        return c ? send(res, 200, { ok: true, chat: c }) : send(res, 404, { ok: false });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/chats/')) { await deleteChat(url.pathname.split('/').pop()); return send(res, 200, { ok: true }); }
      if (route === 'GET /api/keys') return send(res, 200, { keys: await keysStatus() });
      if (route === 'PUT /api/keys') {
        const { name, value } = await readBody(req);
        if (!KEY_NAMES.includes(name)) return send(res, 400, { ok: false, error: 'Unknown key' });
        await setKey(name, value);
        return send(res, 200, { ok: true, keys: await keysStatus() });
      }
      if (route === 'POST /api/keys/test') {
        const { name, value } = await readBody(req);
        if (!KEY_NAMES.includes(name)) return send(res, 400, { ok: false, error: 'Unknown key' });
        const apiKey = value || process.env[name];
        if (!apiKey) return send(res, 400, { ok: false, error: 'No key to test' });
        try {
          if (name === 'OPENROUTER_API_KEY') await testOpenRouterKey(apiKey);
          else await testTypesafeKey(apiKey);
          return send(res, 200, { ok: true });
        } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      }
      if (route === 'POST /api/chat') {
        const now = Date.now();
        while (chatWindow.length && chatWindow[0] < now - 3600_000) chatWindow.shift();
        if (chatWindow.length >= chatLimit) return send(res, 429, { ok: false, error: 'Chat limit reached for this hour' });
        chatWindow.push(now);
        const body = await readBody(req);
        if (!String(body.message || '').trim()) return send(res, 400, { ok: false, error: 'Empty message' });
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
        const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        try { await runChat({ ix: await getIndex(), ops, ...body, message: String(body.message).slice(0, 8000) }, emit); }
        catch (e) { log(`[chat] ${e.message}`); emit('error', { message: e.message }); }
        res.end();
        return;
      }
      if (route === 'GET /api/state') { const s = await readState(); return send(res, 200, { overrides: s.overrides, taxonomy: s.taxonomy, settings: s.settings, updatedAt: s.updatedAt || null }); }
      if (route === 'PUT /api/overrides') {
        // body: { ids: [..], patch: { add?, remove?, labels?, triaged?, archived?, note? } } — null values clear a field
        const { ids = [], patch = {} } = await readBody(req);
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
        return send(res, 200, { ok: true, overrides: Object.fromEntries(ids.map(id => [id, s.overrides[id]])) });
      }
      if (route === 'PUT /api/overrides/restore') {
        // Undo/redo: set each bookmark's override to an exact earlier snapshot (null = none).
        const { entries = {} } = await readBody(req);
        await writeState(st => { for (const [id, o] of Object.entries(entries).slice(0, 5000)) { if (o && Object.keys(o).length) st.overrides[id] = o; else delete st.overrides[id]; } });
        return send(res, 200, { ok: true });
      }
      if (route === 'PUT /api/taxonomy') {
        // body: { id, patch } where patch null deletes a user concept / retires a default one
        const { id, patch } = await readBody(req);
        if (!/^[a-z]+:[\p{L}\p{N}/_.-]+$/u.test(id || '')) return send(res, 400, { ok: false, error: 'Invalid concept id' });
        await writeState(st => {
          if (patch !== null) st.taxonomy.concepts[id] = { ...(st.taxonomy.concepts[id] || {}), ...patch };
          else if (defaultIds.has(id)) st.taxonomy.concepts[id] = { deleted: true };
          else delete st.taxonomy.concepts[id];
        });
        await rebuild('taxonomy');
        return send(res, 200, { ok: true });
      }
      if (route === 'DELETE /api/taxonomy') {
        const { id } = await readBody(req);
        await writeState(st => { delete st.taxonomy.concepts[id]; });
        await rebuild('taxonomy');
        return send(res, 200, { ok: true });
      }
      if (route === 'PUT /api/settings') {
        const patch = await readBody(req);
        if (patch.disabledModels && patch.disabledModels.length >= MODELS.length) return send(res, 400, { ok: false, error: 'At least one model must stay enabled' });
        const s = await writeState(st => { Object.assign(st.settings, patch); });
        if ('enrich' in patch) { enricher.paused = patch.enrich === false; if (!enricher.paused) enricher.kick(); }
        return send(res, 200, { ok: true, settings: s.settings });
      }
      if (route === 'POST /api/backfill') {
        if (lockHolder()) return send(res, 200, { ok: false, error: 'Backfill already running' });
        const child = spawn(process.execPath, [path.join(paths.root, 'scripts', 'backfill.mjs')], { detached: true, stdio: 'ignore', cwd: paths.root, env: process.env });
        child.unref();
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /api/refresh') {
        sourceMtime = 0;
        const result = await checkSource();
        return send(res, 200, { ok: true, build: lastBuild, pending: result?.pending.length ?? 0 });
      }
      return send(res, 404, { ok: false, error: 'Unknown endpoint' });
    }
    // Everything below requires a session, except the sign-in page and its stylesheet.
    // Installable without a session: manifest, service worker, icons, the sign-in page's stylesheet,
    // and the link-preview image.
    if (url.pathname === '/og.png') return await serveFile(req, res, path.join(paths.public, 'og.png'), 'public, max-age=86400');
    if (url.pathname === '/connect.md') { const body = await fs.readFile(path.join(paths.root || process.cwd(), 'docs', 'connect.md'), 'utf8'); return send(res, 200, body, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' }); }
    const publicAsset = ['/styles.css', '/manifest.webmanifest', '/sw.js', '/favicon.ico'].includes(url.pathname) || url.pathname.startsWith('/icons/');
    if (!isAuthed(req) && !publicAsset) {
      if (url.pathname.startsWith('/data/')) return send(res, 401, { ok: false, error: 'Sign in required' });
      return await serveFile(req, res, path.join(paths.public, 'login.html'), 'no-store');
    }
    if (url.pathname === '/login') { res.writeHead(302, { location: '/' }); res.end(); return; }
    if (url.pathname.startsWith('/data/')) {
      const file = within(paths.build, url.pathname.slice(5));
      if (!file) return send(res, 400, { error: 'bad path' });
      return await serveFile(req, res, file, 'no-cache');
    }
    if (url.pathname === '/favicon.ico') return await serveFile(req, res, path.join(paths.public, 'icons', 'favicon-32.png'), 'public, max-age=86400');
    const rel = url.pathname === '/' || !path.extname(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname);
    const file = within(paths.public, rel);
    if (!file) return send(res, 400, { error: 'bad path' });
    return await serveFile(req, res, file, 'no-cache');
  } catch (e) {
    if (!res.headersSent) send(res, e.code === 'ENOENT' || e.message === 'not a file' ? 404 : 500, { ok: false, error: e.code === 'ENOENT' ? 'Not found' : e.message });
  }
});

assertSeparateState();
await initKeys();
await enricher.init();
await purgeTrash({ log });
setInterval(() => purgeTrash({ log }).catch(e => log(`[trash] ${e.message}`)), 6 * 3600_000).unref();
const state = await readState();
if (state.settings.enrich === false) enricher.paused = true;
await checkSource();
setInterval(checkSource, pollMs).unref();
server.listen(port, host, () => log(`Corpus listening at http://${host}:${port}`));
