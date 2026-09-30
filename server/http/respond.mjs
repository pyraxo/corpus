// Small helpers for answering requests and reading their bodies.
export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// A JSON body, up to 2 MB.
export async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2_000_000) throw new Error('Body too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// A file upload's raw bytes (not JSON), up to UPLOAD_MAX_MB.
const uploadMax = Number(process.env.UPLOAD_MAX_MB || 300) * 1e6;
export async function readRaw(req, max = uploadMax) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error(`Files are limited to ${Math.round(max / 1e6)} MB`), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

// This server's public address, for links and link previews.
export function originOf(req) {
  if (process.env.CORPUS_PUBLIC_URL) return process.env.CORPUS_PUBLIC_URL.replace(/\/+$/, '');
  const https = req.headers['x-forwarded-proto'] === 'https' || !!req.headers['cf-visitor']?.includes('https');
  return `${https ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || `localhost:${process.env.PORT || 4173}`}`;
}
