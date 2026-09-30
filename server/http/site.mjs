// The whole HTTP surface, in the order requests are checked: health, MCP (its own bearer token),
// sign-in, the API (signed in), then pages, the index, archived media and added files.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config/paths.mjs';
import { filePath } from '../files/store.mjs';
import { handleMcp } from '../agent/mcp.mjs';
import { isAuthed, login, logoutCookie } from './auth.mjs';
import { createRouter } from './router.mjs';
import { send, readJson } from './respond.mjs';
import { serveFile, serveMedia, within } from './static.mjs';
import { libraryRoutes } from './routes/library.mjs';
import { agentRoutes } from './routes/agent.mjs';
import { fileRoutes } from './routes/files.mjs';
import { keyRoutes } from './routes/keys.mjs';

const mcpToken = process.env.CORPUS_MCP_TOKEN || '';
const bearerOk = (req) => { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : ''; return !!mcpToken && t.length === mcpToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(mcpToken)); };
// Installable without a session: manifest, service worker, icons, the sign-in page's stylesheets.
const isPublicAsset = (p) => ['/manifest.webmanifest', '/sw.js', '/favicon.ico'].includes(p) || p.startsWith('/icons/') || p.startsWith('/css/');
// Added files are served sandboxed: nothing in them runs.
const FILE_HEADERS = { 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' };

export function createSite(core) {
  const api = createRouter();
  for (const add of [libraryRoutes, agentRoutes, fileRoutes, keyRoutes]) add(api);

  async function handleMcpRequest(req, res) {
    // Agents (Claude Code, Hermes, …) authenticate with the bearer token; the signed-in site works too.
    if (!bearerOk(req) && !isAuthed(req)) return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { 'www-authenticate': 'Bearer realm="corpus"' });
    if (req.method === 'GET') return send(res, 405, { error: 'This server does not stream server-initiated messages; POST JSON-RPC instead.' }, { allow: 'POST, DELETE' });
    if (req.method === 'DELETE') return send(res, 200, { ok: true });
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    let msg; try { msg = await readJson(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const out = await handleMcp(msg, core.ops, core.log);
    if (!out) { res.writeHead(202); res.end(); return; }
    send(res, 200, out, { 'mcp-session-id': req.headers['mcp-session-id'] || 'corpus' });
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /api/login') {
      const { password } = await readJson(req);
      const r = login(req, password);
      return send(res, r.status, { ok: r.ok, error: r.error }, r.cookie ? { 'set-cookie': r.cookie } : {});
    }
    if (route === 'POST /api/logout') return send(res, 200, { ok: true }, { 'set-cookie': logoutCookie(req) });
    if (!isAuthed(req)) return send(res, 401, { ok: false, error: 'Sign in required' });
    const hit = api.match(req.method, url.pathname);
    if (!hit) return send(res, 404, { ok: false, error: 'Unknown endpoint' });
    return hit.handler({ req, res, url, params: hit.params, core });
  }

  async function handlePage(req, res, url) {
    const p = url.pathname;
    if (p === '/og.png') return serveFile(req, res, path.join(paths.public, 'og.png'), 'public, max-age=86400');
    if (p === '/connect.md') return send(res, 200, await fs.readFile(path.join(paths.root, 'docs', 'connect.md'), 'utf8'), { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' });
    if (!isAuthed(req) && !isPublicAsset(p)) {
      if (p.startsWith('/data/') || p.startsWith('/files/') || p === '/media') return send(res, 401, { ok: false, error: 'Sign in required' });
      return serveFile(req, res, path.join(paths.public, 'login.html'), 'no-store');
    }
    if (p === '/login') { res.writeHead(302, { location: '/' }); res.end(); return; }
    if (p.startsWith('/data/')) {
      const file = within(paths.build, p.slice(5));
      return file ? serveFile(req, res, file, 'no-cache') : send(res, 400, { error: 'bad path' });
    }
    if (p === '/media') {
      // The local copy of a post's image, used when X no longer serves it.
      const file = core.archiver.fileFor(url.searchParams.get('u') || '');
      return file ? serveMedia(req, res, file) : send(res, 404, { ok: false, error: 'Not archived' });
    }
    if (p.startsWith('/files/')) {
      // A file's original, cover, chapters and book images.
      const [, , id, ...rest] = p.split('/');
      let rel = rest.join('/'); try { rel = decodeURIComponent(rel); } catch {}
      const file = filePath(id, rel);
      if (!file) return send(res, 404, { ok: false, error: 'Not found' });
      return serveMedia(req, res, file, { ...FILE_HEADERS, ...(/\/(doc\.json|cover\.\w+)$/.test(file) && { 'cache-control': 'no-cache' }) });
    }
    if (p === '/favicon.ico') return serveFile(req, res, path.join(paths.public, 'icons', 'favicon-32.png'), 'public, max-age=86400');
    // Anything without an extension is a page of the app.
    let rel = p === '/' || !path.extname(p) ? '/index.html' : p;
    try { rel = decodeURIComponent(rel); } catch {}
    const file = within(paths.public, rel);
    return file ? serveFile(req, res, file, 'no-cache') : send(res, 400, { error: 'bad path' });
  }

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://local');
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'corpus' });
      if (url.pathname === '/mcp') return await handleMcpRequest(req, res);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await handlePage(req, res, url);
    } catch (e) {
      if (!res.headersSent) send(res, e.code === 'ENOENT' || e.message === 'not a file' ? 404 : 500, { ok: false, error: e.code === 'ENOENT' ? 'Not found' : e.message });
    }
  };
}
