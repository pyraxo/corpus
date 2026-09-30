// Corpus keeps its own copy of every post's images, so nothing is lost when a post is
// deleted on X: data/archive/media/<sha1>.<ext> holds post images, video posters,
// avatars, link-card and article images. Video itself isn't kept. FieldTheory keeps the
// bookmarked post's text; captured threads, articles and quoted posts are in data/enrich/.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { paths } from './paths.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const MAX_BYTES = Number(process.env.ARCHIVE_MAX_MB || 50) * 1e6;
const RETRIES = 5;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };
export const MEDIA_TYPES = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

// ── media ─────────────────────────────────────────────────────────────────
// One key per asset: X media without its size query (?name=small etc.), anything else as is.
const isXMedia = (u) => /^https:\/\/pbs\.twimg\.com\/media\//.test(u);
export const mediaKey = (url) => { const u = String(url || ''); return isXMedia(u) ? u.split('?')[0] : u; };
export const hashOf = (url) => crypto.createHash('sha1').update(mediaKey(url)).digest('hex');

// Every image a record shows: its posts' images and video posters, avatar, link card and
// article images, and the same for the quoted post.
export function assetsOf(r) {
  if (r.provider && r.provider !== 'twitter') return [];
  const out = new Map();
  const add = (url, kind) => { if (/^https?:\/\//.test(url || '') && !out.has(mediaKey(url))) out.set(mediaKey(url), { url, kind }); };
  const post = (p) => {
    if (!p) return;
    add(p.author?.avatar, 'avatar');
    for (const t of [p, ...(p.thread || [])]) {
      for (const m of t.media || []) add(m.url, 'image');
      add(t.card?.image, 'image');
    }
    add(p.article?.cover, 'image');
    for (const b of p.article?.blocks || []) if (b.type === 'image') add(b.url, 'image');
  };
  post(r); post(r.quoted);
  return [...out.values()];
}

export class Archiver {
  constructor({ log = console.log, concurrency = 3 } = {}) {
    this.log = (m) => log(`[archive] ${m}`);
    this.concurrency = concurrency;
    this.files = new Map(); // hash -> file name
    this.failed = {};       // hash -> { url, status, error, tries, at, gone }
    this.queue = [];
    this.queued = new Set();
    this.bytes = 0;
    this.active = 0;
    this.paused = false;
    this.lastError = null;
    this.failedFile = path.join(paths.archive, 'failed.json');
  }

  async init() {
    await fs.mkdir(paths.archiveMedia, { recursive: true });
    for (const name of await fs.readdir(paths.archiveMedia)) {
      if (name.startsWith('.')) continue;
      this.files.set(name.split('.')[0], name);
      try { this.bytes += (await fs.stat(path.join(paths.archiveMedia, name))).size; } catch {}
    }
    try { this.failed = JSON.parse(await fs.readFile(this.failedFile, 'utf8')); } catch {}
  }

  has(url) { return this.files.has(hashOf(url)); }
  fileFor(url) { const f = this.files.get(hashOf(url)); return f ? path.join(paths.archiveMedia, f) : null; }
  isGone(url) { return !!this.failed[hashOf(url)]?.gone; }

  // Records newest first; anything already saved, queued or known to be gone is skipped.
  enqueue(records) {
    const now = Date.now();
    for (const r of records) for (const a of assetsOf(r)) {
      const h = hashOf(a.url);
      if (this.files.has(h) || this.queued.has(h)) continue;
      const f = this.failed[h];
      if (f && (f.gone || f.tries >= RETRIES || now - Date.parse(f.at) < 3600_000 * f.tries)) continue;
      this.queued.add(h);
      this.queue.push({ ...a, hash: h });
    }
    this.kick();
  }

  kick() {
    while (!this.paused && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.fetchOne(job).finally(() => { this.active--; this.queued.delete(job.hash); setTimeout(() => this.kick(), 150); });
    }
  }

  async fetchOne({ url, kind, hash }) {
    // X media at original resolution; other URLs exactly as shown.
    const src = isXMedia(url) ? `${mediaKey(url)}?name=orig` : url;
    try {
      const res = await fetch(src, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'image/*,*/*' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw Object.assign(new Error('larger than ARCHIVE_MAX_MB'), { status: 413 });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (type && !type.startsWith('image/')) throw Object.assign(new Error(`not an image (${type})`), { status: 415 });
      const ext = EXT[type] || path.extname(new URL(src).pathname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      const name = `${hash}${ext}`, tmp = path.join(paths.archiveMedia, `.${hash}.${process.pid}.tmp`);
      let bytes = 0;
      const cap = new Transform({ transform(chunk, _, done) { bytes += chunk.length; done(bytes > MAX_BYTES ? Object.assign(new Error('larger than ARCHIVE_MAX_MB'), { status: 413 }) : null, chunk); } });
      try { await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(tmp)); await fs.rename(tmp, path.join(paths.archiveMedia, name)); }
      catch (e) { await fs.rm(tmp, { force: true }); throw e; }
      this.files.set(hash, name);
      this.bytes += bytes;
      if (this.failed[hash]) { delete this.failed[hash]; this.saveFailed(); }
    } catch (e) {
      const prev = this.failed[hash];
      // 404 / 410: the post (or its media) is already gone from X; nothing left to save.
      const gone = e.status === 404 || e.status === 410 || e.status === 413 || e.status === 415;
      this.failed[hash] = { url, kind, status: e.status || null, error: String(e.message || e).slice(0, 200), tries: (prev?.tries || 0) + 1, at: new Date().toISOString(), ...(gone && { gone: true }) };
      this.lastError = `${url.slice(0, 80)}: ${this.failed[hash].error}`;
      if (!gone) this.log(this.lastError);
      this.saveFailed();
    }
  }

  saveFailed() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      const tmp = `${this.failedFile}.${process.pid}.tmp`;
      try { await fs.writeFile(tmp, JSON.stringify(this.failed)); await fs.rename(tmp, this.failedFile); } catch (e) { this.log(`failed.json: ${e.message}`); }
    }, 2000);
    this.saveTimer.unref?.();
  }

  // Saved / total files for one record, and how many were already gone from X.
  recordStatus(r) {
    const assets = assetsOf(r);
    return { files: assets.filter(a => this.has(a.url)).length, of: assets.length, gone: assets.filter(a => !this.has(a.url) && this.isGone(a.url)).length };
  }

  status() {
    const failed = Object.values(this.failed);
    return { saved: this.files.size, bytes: this.bytes, queued: this.queue.length + this.active, gone: failed.filter(f => f.gone).length, retrying: failed.filter(f => !f.gone).length, paused: this.paused, lastError: this.lastError };
  }
}
