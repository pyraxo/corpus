// EPUB 2 and 3: metadata, cover, table of contents, and the spine as reader-safe chapters.
import path from 'node:path/posix';
import crypto from 'node:crypto';
import { readZip } from './zip.mjs';
import { sanitize, htmlText, decodeEntities } from './html.mjs';

const tagText = (xml, name) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}\\b([^>]*)>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'gi'))].map(m => ({ attrs: m[1], text: htmlText(m[2]) })).filter(x => x.text);
const attrOf = (attrs, name) => (attrs.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}\\s*=\\s*"([^"]*)"`, 'i')) || attrs.match(new RegExp(`(?:^|\\s)(?:\\w+:)?${name}\\s*=\\s*'([^']*)'`, 'i')) || [])[1];
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };

export function parseEpub(buf, { assetUrl }) {
  const zip = readZip(buf);
  const container = zip.text('META-INF/container.xml');
  const opfPath = container && attrOf((container.match(/<rootfile\b([^>]*)>/i) || [])[1] || '', 'full-path');
  const opf = opfPath && zip.text(opfPath);
  if (!opf) throw new Error('This EPUB has no package document');
  if (zip.names.includes('META-INF/encryption.xml') && /EncryptedData/.test(zip.text('META-INF/encryption.xml') || '') && !/obfuscation/i.test(zip.text('META-INF/encryption.xml'))) throw new Error('This EPUB is DRM-protected, so it can’t be read');
  const base = path.dirname(opfPath);
  const resolve = (from, href) => path.normalize(path.join(path.dirname(from), decode(href.split('#')[0]))).replace(/^(\.\/)+/, '');

  // Metadata (Dublin Core).
  const md = (opf.match(/<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/i) || [''])[0];
  const one = (n) => tagText(md, n)[0]?.text || null;
  const ids = tagText(md, 'identifier').map(x => x.text);
  const meta = {
    title: one('title'),
    authors: tagText(md, 'creator').map(x => x.text),
    publisher: one('publisher'),
    published: one('date'),
    language: one('language'),
    description: one('description'),
    subjects: tagText(md, 'subject').map(x => x.text),
    isbn: ids.map(s => s.replace(/^urn:isbn:/i, '')).find(s => /^(97[89])?\d{9}[\dX]$/i.test(s.replace(/-/g, ''))) || null
  };

  // Manifest and spine.
  const manifest = new Map();
  for (const m of opf.matchAll(/<(?:\w+:)?item\b([^>]*?)\/?>/gi)) {
    const a = m[1], id = attrOf(a, 'id'), href = attrOf(a, 'href');
    if (id && href) manifest.set(id, { id, href: resolve(opfPath, href), type: attrOf(a, 'media-type') || '', props: attrOf(a, 'properties') || '' });
  }
  const spineTag = (opf.match(/<(?:\w+:)?spine\b([^>]*)>/i) || [])[1] || '';
  const spine = [...opf.matchAll(/<(?:\w+:)?itemref\b([^>]*?)\/?>/gi)].map(m => manifest.get(attrOf(m[1], 'idref'))).filter(x => x && /html|xml/.test(x.type));

  // Images: every one in the manifest, stored under a short content hash.
  const assets = new Map(), byHref = new Map();
  for (const it of manifest.values()) {
    const ext = IMG_EXT[it.type];
    if (!ext) continue;
    const data = zip.get(it.href);
    if (!data) continue;
    const name = `${crypto.createHash('sha1').update(data).digest('hex').slice(0, 12)}${ext}`;
    assets.set(name, data); byHref.set(it.href, name);
  }
  const coverMeta = attrOf((md.match(/<meta\b([^>]*name\s*=\s*"cover"[^>]*)>/i) || [])[1] || '', 'content');
  const coverItem = [...manifest.values()].find(x => /cover-image/.test(x.props)) || manifest.get(coverMeta) || [...manifest.values()].find(x => IMG_EXT[x.type] && /cover/i.test(x.id + x.href));
  const coverName = coverItem && byHref.get(coverItem.href);

  // Table of contents: the EPUB 3 nav document, else the NCX.
  const chapterOf = new Map(spine.map((s, i) => [s.href, i]));
  const target = (from, href) => { const file = resolve(from, href); const ch = chapterOf.get(file); return ch == null ? null : { ch, anchor: href.includes('#') ? decode(href.split('#')[1]) : null }; };
  let toc = [];
  const nav = [...manifest.values()].find(x => /\bnav\b/.test(x.props));
  const navHtml = nav && zip.text(nav.href);
  if (navHtml) {
    const tocNav = (navHtml.match(/<nav\b[^>]*(?:epub:)?type\s*=\s*"toc"[^>]*>([\s\S]*?)<\/nav>/i) || navHtml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i) || [])[1] || '';
    let level = 0;
    for (const m of tocNav.matchAll(/<(\/?)(ol|ul)\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (m[2]) { level += m[1] ? -1 : 1; continue; }
      const t = target(nav.href, attrOf(m[3], 'href') || '');
      if (t) toc.push({ title: htmlText(m[4]).replace(/\s+/g, ' '), ...t, level: Math.max(0, level - 1) });
    }
  }
  if (!toc.length) {
    const ncx = manifest.get(attrOf(spineTag, 'toc')) || [...manifest.values()].find(x => /ncx/.test(x.type));
    const xml = ncx && zip.text(ncx.href);
    if (xml) {
      let level = -1;
      for (const m of xml.matchAll(/<(\/?)navPoint\b[^>]*>|<navLabel>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\b([^>]*)\/?>/gi)) {
        if (m[0].toLowerCase().startsWith('<navpoint')) { level++; continue; }
        if (m[1] !== undefined && m[0].toLowerCase().startsWith('</navpoint')) { level--; continue; }
        const t = m[3] && target(ncx.href, attrOf(m[3], 'src') || '');
        if (t) toc.push({ title: decodeEntities(m[2]).trim(), ...t, level: Math.max(0, level) });
      }
    }
  }

  // Chapters: each spine document, sanitized. Images point at stored assets; links between
  // chapters become chapter jumps.
  const chapters = spine.map((s, i) => {
    const raw = zip.text(s.href) || '';
    const html = sanitize(raw, {
      src: (src) => { const name = byHref.get(resolve(s.href, src)); return name ? assetUrl(name) : null; },
      href: (h) => /^[a-z]+:/i.test(h) ? { url: h } : (h.startsWith('#') ? { ch: i, anchor: h.slice(1) } : target(s.href, h))
    });
    const text = htmlText(html);
    const heading = (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || [])[1];
    const title = toc.find(t => t.ch === i && !t.anchor)?.title || toc.find(t => t.ch === i)?.title || (heading && htmlText(heading).replace(/\s+/g, ' ').slice(0, 120)) || null;
    return { title, html, text };
  });
  return { meta, toc, chapters, assets, cover: coverName ? { name: coverName, data: assets.get(coverName) } : null };
}
