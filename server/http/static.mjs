// Serving files from disk: pages and app code (gzip, etags), and media with byte ranges.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FILE_TYPES } from '../files/store.mjs';
import { MEDIA_TYPES } from '../capture/archive.mjs';
import { originOf } from './respond.mjs';

export const mime = { ...FILE_TYPES, ...MEDIA_TYPES, '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// A path under dir, or null when rel would leave it.
export const within = (dir, rel) => { const f = path.resolve(dir, `.${rel}`); return f.startsWith(dir + path.sep) ? f : null; };

export async function serveFile(req, res, file, cache) {
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

// Archived images and added files (byte ranges too, for clients that ask, like pdf.js).
export async function serveMedia(req, res, file, extra = {}) {
  const { size } = await fs.stat(file);
  const headers = { 'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable', 'accept-ranges': 'bytes', ...extra };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}
