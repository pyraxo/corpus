// MOBI / AZW (PalmDOC-compressed, no DRM): EXTH metadata, cover, images, and the book's
// HTML split into chapters at its page breaks. HUFF/CDIC-compressed and DRM files are refused.
import crypto from 'node:crypto';
import { sanitize, htmlText } from './html.mjs';

function palmdoc(src) {
  const out = [];
  for (let i = 0; i < src.length;) {
    const c = src[i++];
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) out.push(c);
    else if (c >= 0x01 && c <= 0x08) { for (let k = 0; k < c && i < src.length; k++) out.push(src[i++]); }
    else if (c >= 0xc0) out.push(0x20, c ^ 0x80);
    else {
      const pair = (c << 8) | src[i++];
      const dist = (pair >> 3) & 0x7ff, len = (pair & 7) + 3;
      for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
    }
  }
  return Buffer.from(out);
}

// Text records can end with extra data (multibyte overlap, index entries); strip it.
function trailing(rec, flags) {
  let end = rec.length;
  for (let bit = 15; bit >= 1; bit--) {
    if (!(flags & (1 << bit))) continue;
    // Size is a backward-encoded varint in the last bytes.
    let size = 0, shift = 0;
    for (let k = end - 1, n = 0; k >= 0 && n < 4; k--, n++) { const b = rec[k]; size |= (b & 0x7f) << shift; shift += 7; if (b & 0x80) break; }
    end -= size;
  }
  if (flags & 1) end -= (rec[end - 1] & 3) + 1;
  return rec.subarray(0, Math.max(0, end));
}

const IMG = (b) => b[0] === 0xff && b[1] === 0xd8 ? '.jpg' : b.subarray(0, 4).toString('latin1') === '\x89PNG' ? '.png' : b.subarray(0, 3).toString() === 'GIF' ? '.gif' : null;

export function parseMobi(buf, { assetUrl }) {
  if (buf.subarray(60, 68).toString('latin1') !== 'BOOKMOBI' && buf.subarray(60, 68).toString('latin1') !== 'TEXtREAd') throw new Error('Not a MOBI file');
  const n = buf.readUInt16BE(76);
  const offs = Array.from({ length: n }, (_, i) => buf.readUInt32BE(78 + i * 8));
  const record = (i) => buf.subarray(offs[i], i + 1 < n ? offs[i + 1] : buf.length);
  const r0 = record(0);
  const compression = r0.readUInt16BE(0), textRecords = r0.readUInt16BE(8);
  if (r0.readUInt16BE(12) !== 0) throw new Error('This book is DRM-protected, so it can’t be read');
  if (compression === 17480) throw new Error('This MOBI uses HUFF/CDIC compression, which isn’t supported yet. Convert it to EPUB and add that instead.');
  const isMobi = r0.subarray(16, 20).toString('latin1') === 'MOBI';
  const hlen = isMobi ? r0.readUInt32BE(20) : 0;
  const encoding = isMobi ? r0.readUInt32BE(28) : 1252;
  const firstImage = isMobi ? r0.readUInt32BE(108) : 0xffffffff;
  const extraFlags = isMobi && hlen >= 0xe4 ? r0.readUInt16BE(0xf2) : 0;
  const meta = { title: buf.subarray(0, 32).toString('latin1').replace(/\0.*$/s, '').replace(/_/g, ' '), authors: [], subjects: [] };
  if (isMobi) {
    const nameOff = r0.readUInt32BE(84), nameLen = r0.readUInt32BE(88);
    if (nameLen) meta.title = r0.subarray(nameOff, nameOff + nameLen).toString(encoding === 65001 ? 'utf8' : 'latin1');
  }
  let coverIndex = null;
  if (isMobi && (r0.readUInt32BE(128) & 0x40) && r0.subarray(16 + hlen, 20 + hlen).toString('latin1') === 'EXTH') {
    const count = r0.readUInt32BE(24 + hlen);
    let p = 28 + hlen;
    const str = (b) => b.toString(encoding === 65001 ? 'utf8' : 'latin1').trim();
    for (let k = 0; k < count && p + 8 <= r0.length; k++) {
      const type = r0.readUInt32BE(p), len = r0.readUInt32BE(p + 4), data = r0.subarray(p + 8, p + len);
      if (type === 100) meta.authors.push(str(data));
      else if (type === 101) meta.publisher = str(data);
      else if (type === 103) meta.description = htmlText(str(data));
      else if (type === 104) meta.isbn = str(data);
      else if (type === 105) meta.subjects.push(str(data));
      else if (type === 106) meta.published = str(data);
      else if (type === 503) meta.title = str(data);
      else if (type === 524) meta.language = str(data);
      else if (type === 201 && data.length >= 4) coverIndex = data.readUInt32BE(0);
      p += len;
    }
  }

  // The whole text, as one byte string so filepos (a byte offset) indexes straight into it.
  const parts = [];
  for (let i = 1; i <= textRecords && i < n; i++) {
    const rec = trailing(record(i), extraFlags);
    parts.push(compression === 2 ? palmdoc(rec) : rec);
  }
  const bytes = Buffer.concat(parts).toString('latin1');
  const decode = (s) => Buffer.from(s, 'latin1').toString(encoding === 65001 ? 'utf8' : 'latin1');

  // Images by their recindex (1-based from the first image record).
  const assets = new Map(), byIndex = new Map();
  if (firstImage !== 0xffffffff) for (let i = firstImage; i < n; i++) {
    const data = record(i), ext = IMG(data);
    if (!ext) continue;
    const name = `${crypto.createHash('sha1').update(data).digest('hex').slice(0, 12)}${ext}`;
    assets.set(name, Buffer.from(data)); byIndex.set(i - firstImage + 1, name);
  }

  // Chapters at page breaks; every filepos a link points at becomes an anchor.
  const targets = [...new Set([...bytes.matchAll(/filepos\s*=\s*["']?0*(\d+)/gi)].map(m => Number(m[1])))].sort((a, b) => a - b);
  const breaks = [0];
  for (const m of bytes.matchAll(/<mbp:pagebreak\s*\/?>/gi)) if (m.index - breaks.at(-1) > 200) breaks.push(m.index);
  const chapterAt = (pos) => { let lo = 0; for (let i = 0; i < breaks.length; i++) if (breaks[i] <= pos) lo = i; return lo; };
  const chapters = breaks.map((start, i) => {
    const end = breaks[i + 1] ?? bytes.length;
    let piece = '', last = start;
    for (const t of targets) if (t >= start && t < end) { piece += bytes.slice(last, t) + `<a id="fp${t}"></a>`; last = t; }
    const raw = decode(piece + bytes.slice(last, end)).replace(/<mbp:pagebreak\s*\/?>/gi, '');
    const links = [...raw.matchAll(/<a\b[^>]*filepos\s*=\s*["']?0*(\d+)[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ pos: Number(m[1]), text: htmlText(m[2]).replace(/\s+/g, ' ') }));
    // sanitize() reads src and href, so recindex images and filepos links are rewritten into those first.
    const html = sanitize(raw
      // KF8 refers to images as kindle:embed:XXXX (base 32).
      .replace(/(<img\b[^>]*?)src\s*=\s*["']kindle:embed:([0-9A-V]+)[^"']*["']/gi, (m, x, k) => `${x}recindex="${parseInt(k, 32)}"`)
      .replace(/<img\b[^>]*recindex\s*=\s*["']?(\d+)[^>]*>/gi, (m, k) => byIndex.has(Number(k)) ? `<img src="asset:${byIndex.get(Number(k))}">` : '')
      .replace(/<a\b([^>]*?)filepos\s*=\s*["']?0*(\d+)["']?([^>]*)>/gi, (m, x, p, y) => `<a${x} href="filepos:${p}"${y}>`), {
      src: (u) => u.startsWith('asset:') ? assetUrl(u.slice(6)) : null,
      href: (h) => h.startsWith('filepos:') ? { ch: chapterAt(Number(h.slice(8))), anchor: `fp${h.slice(8)}` } : /^[a-z]+:/i.test(h) ? { url: h } : null
    });
    const heading = (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1];
    return { html, text: htmlText(html), links, title: heading ? htmlText(heading).replace(/\s+/g, ' ').slice(0, 120) : null };
  });
  // The table of contents: the chapter that is mostly links to other places in the book.
  const tocChapter = chapters.find(c => c.links.length >= 3 && c.links.length * 40 > c.text.length * 0.5);
  const toc = (tocChapter?.links || []).filter(l => l.text).map(l => ({ title: l.text.slice(0, 140), ch: chapterAt(l.pos), anchor: `fp${l.pos}`, level: 0 }));
  for (const t of toc) if (!chapters[t.ch].title) chapters[t.ch].title = t.title;
  for (const c of chapters) delete c.links;
  const coverName = coverIndex != null ? byIndex.get(coverIndex + 1) : null;
  return { meta, toc, chapters, assets, cover: coverName ? { name: coverName, data: assets.get(coverName) } : null };
}
