// Files added by hand (dropped, pasted or picked): images, PDFs, EPUB and MOBI books, text
// and Markdown. Each lives in data/files/<id>/: the original, doc.json (metadata, contents,
// chapter list), chapters as reader-safe HTML (ch/<n>.html), book images (a/), a cover, and
// for PDFs the text of every page (text.json). The build merges them in as bookmarks.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './paths.mjs';
import { readManual } from './manual.mjs';
import { parseEpub } from './epub.mjs';
import { parseMobi } from './mobi.mjs';
import { parsePdf } from './pdf.mjs';
import { sanitize, htmlText, markdownHtml } from './html.mjs';

export const FILE_ID = /^file-[a-f0-9]{12}$/;
export const FILE_TYPES = {
  '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.mobi': 'application/x-mobipocket-ebook', '.azw': 'application/vnd.amazon.ebook', '.azw3': 'application/vnd.amazon.ebook',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml'
};
const TEXT_EXT = new Set(['.txt', '.text', '.md', '.markdown', '.mdown', '.rst', '.org', '.log', '.csv', '.html', '.htm']);
const KIND_LABEL = { pdf: 'PDF', epub: 'EPUB', mobi: 'MOBI', text: 'Text', image: 'Image' };
const dirOf = (id) => path.join(paths.files, id);
const writeJson = async (file, data) => { const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data)); await fs.rename(tmp, file); };

export async function readDoc(id) {
  if (!FILE_ID.test(id)) return null;
  try { return JSON.parse(await fs.readFile(path.join(dirOf(id), 'doc.json'), 'utf8')); } catch { return null; }
}
export async function updateDoc(id, patch) {
  const doc = await readDoc(id);
  if (!doc) return null;
  Object.assign(doc, patch);
  await writeJson(path.join(dirOf(id), 'doc.json'), doc);
  return doc;
}
export async function readFiles() {
  let names = [];
  try { names = await fs.readdir(paths.files); } catch { return []; }
  return (await Promise.all(names.filter(n => FILE_ID.test(n)).map(readDoc))).filter(Boolean);
}
export async function removeFile(id) { if (FILE_ID.test(id)) await fs.rm(dirOf(id), { recursive: true, force: true }); }
// A path inside a file's folder, for serving (null when it would leave it).
export function filePath(id, rel) {
  if (!FILE_ID.test(id)) return null;
  const dir = dirOf(id), f = path.resolve(dir, `.${path.posix.normalize(`/${rel}`)}`);
  return f.startsWith(dir + path.sep) ? f : null;
}

// Hand-added items sort just after the newest bookmark at the time they're saved.
export async function maxSortIndex() {
  let max = 0n;
  const raw = await fs.readFile(paths.source, 'utf8').catch(() => '');
  for (const m of raw.matchAll(/"sortIndex":"(\d+)"/g)) { const v = BigInt(m[1]); if (v > max) max = v; }
  for (const m of [...await readManual(), ...await readFiles()]) { const v = BigInt(m.sortIndex || 0); if (v > max) max = v; }
  return max;
}

// ── detection ─────────────────────────────────────────────────────────────
function imageInfo(b) {
  if (b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return { ext: '.png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return { ext: '.gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const f = b.subarray(12, 16).toString('latin1');
    if (f === 'VP8X') return { ext: '.webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (f === 'VP8L') { const v = b.readUInt32LE(21); return { ext: '.webp', width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
    return { ext: '.webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let p = 2; p + 9 < b.length;) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1], len = b.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { ext: '.jpg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      p += 2 + len;
    }
    return { ext: '.jpg', width: null, height: null };
  }
  if (b.subarray(4, 12).toString('latin1') === 'ftypavif') return { ext: '.avif', width: null, height: null };
  const head = b.subarray(0, 512).toString('utf8');
  if (/<svg[\s>]/i.test(head) && !/<html/i.test(head)) { const vb = head.match(/viewBox\s*=\s*"[\d.\s-]*?([\d.]+)\s+([\d.]+)"/); return { ext: '.svg', width: vb ? Number(vb[1]) : null, height: vb ? Number(vb[2]) : null }; }
  return null;
}
function kindOf(buf, name) {
  const ext = path.extname(name || '').toLowerCase();
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.subarray(0, 2).toString('latin1') === 'PK' && (buf.subarray(30, 58).toString('latin1') === 'mimetypeapplication/epub+zip' || ext === '.epub')) return 'epub';
  if (['BOOKMOBI', 'TEXtREAd'].includes(buf.subarray(60, 68).toString('latin1'))) return 'mobi';
  if (imageInfo(buf)) return 'image';
  if (TEXT_EXT.has(ext) || (!buf.subarray(0, 8000).includes(0) && buf.length < 20e6)) return 'text';
  return null;
}

// Very long chapters with no contents (KF8, single-file HTML, long Markdown) are split at headings.
function splitLong(chapters, toc) {
  if (toc.length || chapters.length > 3 || !chapters.some(c => c.text.length > 60000)) return { chapters, toc };
  const out = [];
  for (const c of chapters) {
    const pieces = c.html.split(/(?=<h[12][\s>])/i).filter(p => htmlText(p).length);
    if (pieces.length < 3) { out.push(c); continue; }
    // Headings with almost nothing under them join the next section.
    let acc = '';
    for (const [i, p] of pieces.entries()) {
      acc += p;
      if (htmlText(acc).length < 400 && i < pieces.length - 1) continue;
      const h = (acc.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1];
      out.push({ html: acc, text: htmlText(acc), title: h ? htmlText(h).replace(/\s+/g, ' ').slice(0, 120) : null });
      acc = '';
    }
  }
  return { chapters: out, toc: out.map((c, ch) => c.title && { title: c.title, ch, anchor: null, level: 0 }).filter(Boolean) };
}

// Something to read that stands for the whole: description, contents, and passages from the
// start and middle (skipping front matter that's only a few lines long).
function excerptOf(texts, n = 3000) {
  const body = texts.filter(t => t.length > 1500);
  const first = (body[0] || texts.join('\n\n')).replace(/\s+/g, ' ').trim();
  return first.slice(0, n);
}
export async function docText(id, max = 10000) {
  const doc = await readDoc(id);
  if (!doc) return '';
  const texts = await chapterTexts(doc);
  const body = texts.filter(t => t.length > 1500);
  const pick = [body[0], body[Math.floor(body.length / 2)]].filter((t, i, a) => t && a.indexOf(t) === i).map(t => t.replace(/\s+/g, ' ').slice(0, Math.floor(max / 2.5)));
  const lines = [
    `${KIND_LABEL[doc.kind]}: ${doc.title}${doc.authors?.length ? ` by ${doc.authors.join(', ')}` : ''}`,
    doc.publisher && `Publisher: ${doc.publisher}`, doc.subjects?.length && `Subjects: ${doc.subjects.join('; ')}`,
    doc.description && `Description: ${doc.description}`,
    doc.toc?.length && `Contents: ${doc.toc.slice(0, 60).map(t => t.title).join(' · ')}`,
    ...(pick.length ? pick : [doc.excerpt || ''])
  ].filter(Boolean);
  return lines.join('\n\n').slice(0, max);
}
async function chapterTexts(doc) {
  const dir = dirOf(doc.id);
  if (doc.kind === 'pdf') return JSON.parse(await fs.readFile(path.join(dir, 'text.json'), 'utf8').catch(() => '[]'));
  const out = [];
  for (let i = 0; i < (doc.chapters?.length || 0); i++) out.push(htmlText(await fs.readFile(path.join(dir, 'ch', `${i}.html`), 'utf8').catch(() => '')));
  return out;
}
// Chapter or page range as plain text, for agents.
export async function readSections(id, { from = 0, to = from } = {}) {
  const doc = await readDoc(id);
  if (!doc) return null;
  const texts = await chapterTexts(doc);
  return { doc, texts: texts.slice(from, to + 1).map((text, k) => ({ index: from + k, title: doc.kind === 'pdf' ? `Page ${from + k + 1}` : doc.chapters[from + k]?.title || null, text })), total: texts.length };
}

// ── ingest ────────────────────────────────────────────────────────────────
export async function ingestFile({ data, name = 'file', sortIndex }) {
  const kind = kindOf(data, name);
  if (!kind) throw new Error('Corpus can add images, PDFs, EPUB and MOBI books, and text or Markdown files');
  const id = `file-${crypto.createHash('sha1').update(data).digest('hex').slice(0, 12)}`;
  const existing = await readDoc(id);
  if (existing) return { ...existing, duplicate: true };
  const dir = dirOf(id), tmp = path.join(paths.files, `.${id}.${process.pid}.tmp`);
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(path.join(tmp, 'ch'), { recursive: true });
  const assetUrl = (n) => `/files/${id}/a/${n}`;
  const base = { id, kind, name: path.basename(name).slice(0, 200), size: data.length, addedAt: new Date().toISOString(), sortIndex: String(sortIndex ?? (await maxSortIndex()) + 1n) };
  let doc;
  try {
    const stem = path.basename(name, path.extname(name)).replace(/[_]+/g, ' ').trim();
    if (kind === 'image') {
      const info = imageInfo(data);
      await fs.writeFile(path.join(tmp, `original${info.ext}`), data);
      doc = { ...base, file: `original${info.ext}`, title: stem || 'Image', width: info.width, height: info.height, cover: `original${info.ext}` };
    } else if (kind === 'pdf') {
      const p = await parsePdf(data);
      await fs.writeFile(path.join(tmp, 'original.pdf'), data);
      await writeJson(path.join(tmp, 'text.json'), p.pages);
      doc = { ...base, file: 'original.pdf', ...p.meta, title: p.meta.title || stem, pages: p.pageCount, toc: p.toc, cover: null, excerpt: excerptOf(p.pages), words: p.pages.join(' ').split(/\s+/).length };
    } else {
      let parsed;
      if (kind === 'epub') parsed = parseEpub(data, { assetUrl });
      else if (kind === 'mobi') parsed = parseMobi(data, { assetUrl });
      else {
        const ext = path.extname(name).toLowerCase();
        const text = data.toString('utf8').replace(/^﻿/, '');
        const html = /\.html?$/.test(ext) ? sanitize(text, { href: (h) => /^[a-z]+:/i.test(h) ? { url: h } : null }) : markdownHtml(text);
        const heading = (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1];
        const htmlTitle = /\.html?$/.test(ext) && (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
        parsed = { meta: { title: (htmlTitle && htmlText(htmlTitle)) || (heading && htmlText(heading)) || null, authors: [], subjects: [] }, toc: [], chapters: [{ html, text: htmlText(html), title: null }], assets: new Map(), cover: null };
      }
      const { chapters, toc } = splitLong(parsed.chapters, parsed.toc);
      if (!chapters.some(c => c.text.trim() || /<img/.test(c.html))) throw new Error('There’s no readable text in this file');
      const ext = kind === 'text' ? (/\.html?$/i.test(name) ? '.html' : /\.(md|markdown|mdown)$/i.test(name) ? '.md' : '.txt') : kind === 'epub' ? '.epub' : path.extname(name).toLowerCase() || '.mobi';
      await fs.writeFile(path.join(tmp, `original${ext}`), data);
      for (const [i, c] of chapters.entries()) await fs.writeFile(path.join(tmp, 'ch', `${i}.html`), c.html);
      if (parsed.assets.size) { await fs.mkdir(path.join(tmp, 'a'), { recursive: true }); for (const [n, b] of parsed.assets) await fs.writeFile(path.join(tmp, 'a', n), b); }
      let cover = null;
      if (parsed.cover) { cover = `cover${path.extname(parsed.cover.name)}`; await fs.writeFile(path.join(tmp, cover), parsed.cover.data); }
      const texts = chapters.map(c => c.text);
      doc = {
        ...base, file: `original${ext}`, ...parsed.meta, title: parsed.meta.title || stem, toc, cover,
        chapters: chapters.map(c => ({ title: c.title, chars: c.text.length })),
        excerpt: excerptOf(texts), words: texts.join(' ').split(/\s+/).filter(Boolean).length
      };
    }
    doc.title = String(doc.title || stem || KIND_LABEL[kind]).replace(/\s+/g, ' ').trim().slice(0, 300);
    await writeJson(path.join(tmp, 'doc.json'), doc);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
  } catch (e) { await fs.rm(tmp, { recursive: true, force: true }); throw e; }
  return doc;
}

export async function setCover(id, data, ext = '.jpg') {
  const doc = await readDoc(id);
  if (!doc || doc.kind === 'image') return null;
  const name = `cover${ext}`;
  await fs.writeFile(path.join(dirOf(id), name), data);
  return updateDoc(id, { cover: name });
}

// An uploaded image as a data: URL, for the vision model (it can't fetch our /files URLs).
export async function fileDataUrl(url) {
  const m = /^\/files\/(file-[a-f0-9]{12})\/(.+)$/.exec(url || '');
  const f = m && filePath(m[1], m[2]);
  if (!f) return null;
  const type = FILE_TYPES[path.extname(f).toLowerCase()];
  if (!type?.startsWith('image/') || type === 'image/svg+xml') return null;
  return `data:${type};base64,${(await fs.readFile(f)).toString('base64')}`;
}

// Shaped like a FieldTheory line plus its capture, so the build treats it like any bookmark.
export function fileSource(doc) {
  const url = `/files/${doc.id}/${doc.file}`;
  const media = doc.kind === 'image' ? [{ type: 'image', url, width: doc.width || null, height: doc.height || null }] : [];
  const summary = doc.kind === 'image' ? '' : (doc.description || doc.excerpt || '').slice(0, 600);
  return {
    line: {
      id: doc.id, tweetId: doc.id, provider: 'file', url, text: summary, title: doc.title,
      authorHandle: '', authorName: doc.authors?.join(', ') || '', authorProfileImageUrl: null,
      postedAt: doc.addedAt, syncedAt: doc.addedAt, links: [], sortIndex: doc.sortIndex, engagement: {},
      format: doc.kind === 'image' ? 'format:image' : doc.kind === 'text' ? 'format:note' : doc.kind === 'pdf' && (doc.pages || 0) < 100 ? 'format:document' : 'format:book',
      doc: {
        kind: doc.kind, file: doc.file, name: doc.name, size: doc.size, cover: doc.cover ? `/files/${doc.id}/${doc.cover}` : null,
        pages: doc.pages || null, chapters: doc.chapters?.length || null, words: doc.words || null,
        authors: doc.authors || [], publisher: doc.publisher || null, published: doc.published || null, language: doc.language || null, isbn: doc.isbn || null,
        description: doc.description || null, subjects: doc.subjects || [], excerpt: (doc.excerpt || '').slice(0, 2000), width: doc.width || null, height: doc.height || null
      }
    },
    enrichment: { id: doc.id, status: 'ok', fetchedAt: doc.addedAt, thread: [{ id: doc.id, text: summary, links: [], media }], article: null, card: null, quoted: null }
  };
}
