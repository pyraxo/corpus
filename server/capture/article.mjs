// A web page as an article: its metadata (title, author, date, site, cover) and its main content
// as blocks, the same shape as X articles (p, h2–h4, li/oli, quote, code, image, divider), so the
// reader shows both alike. The content is found the way reader modes do: the element whose
// paragraphs carry the most text, with little of it in links, after dropping navigation, ads,
// comments and the like. `isArticle` says whether the page reads as one (a landing page doesn't).
import { parseHtml, walk, find, findAll, textOf, squash } from './dom.mjs';

const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'button', 'input', 'select', 'textarea', 'nav', 'footer', 'aside', 'dialog', 'canvas', 'object', 'embed', 'audio', 'video', 'map', 'menu']);
const UNLIKELY = /(^|[\s_-])(comment|share|sharing|social|related|recommend|promo|newsletter|subscribe|signup|advert|ads?|sponsor|cookie|consent|banner|sidebar|footer|masthead|nav|navbar|menu|breadcrumb|pagination|popup|modal|toolbar|widget|author-bio|byline-share|tags?-list|disqus|outbrain|taboola)([\s_-]|$)/i;
const LIKELY = /(article|post|entry|content|story|body|main|prose|markdown|text|blog)/i;
const EXPLICIT = /(post-content|entry-content|article-body|article__body|article-content|story-body|post-body|postbody|single-content|blog-post|markdown-body|available-content|body-text|rich-text)/i;
const INLINE = new Set(['a', 'span', 'em', 'i', 'strong', 'b', 'u', 's', 'code', 'sup', 'sub', 'small', 'mark', 'abbr', 'time', 'q', 'cite', 'label', 'font', 'kbd', 'var', 'del', 'ins', 'bdi', 'wbr']);
const ARTICLE_TYPES = /^(Article|NewsArticle|BlogPosting|Report|TechArticle|ScholarlyArticle|AnalysisNewsArticle|OpinionNewsArticle|Essay|SocialMediaPosting)$/;

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const absolute = (u, base) => { try { return u ? new URL(u, base).href : null; } catch { return null; } };
const classId = (n) => `${n.attrs.class || ''} ${n.attrs.id || ''} ${n.attrs.role || ''}`;
const attr = (n, k) => n?.attrs?.[k] || null;

// ── metadata ─────────────────────────────────────────────────────────────
function jsonLd(doc) {
  const out = [];
  for (const s of findAll(doc, n => n.tag === 'script' && /ld\+json/i.test(n.attrs.type || ''))) {
    try {
      const v = JSON.parse(textOf(s).trim());
      const flat = (x) => Array.isArray(x) ? x.flatMap(flat) : x && typeof x === 'object' ? [x, ...flat(x['@graph'] || [])] : [];
      out.push(...flat(v));
    } catch {}
  }
  return out;
}
const names = (a) => (Array.isArray(a) ? a : [a]).map(x => typeof x === 'string' ? x : x?.name).filter(Boolean).map(squash);
function readMeta(doc, url) {
  const metas = findAll(doc, n => n.tag === 'meta');
  const meta = (...keys) => { for (const k of keys) { const m = metas.find(n => (n.attrs.property || n.attrs.name || '').toLowerCase() === k); if (m?.attrs.content) return squash(m.attrs.content); } return null; };
  const ld = jsonLd(doc);
  const art = ld.find(x => [].concat(x['@type'] || []).some(t => ARTICLE_TYPES.test(t))) || null;
  const siteName = meta('og:site_name', 'application-name') || names(art?.publisher)[0] || host(url);
  let title = squash(art?.headline) || meta('og:title', 'twitter:title') || squash(textOf(find(doc, n => n.tag === 'title') || { children: [] })) || null;
  // "Post title | Site" in <title> keeps just the post title.
  if (title) {
    const parts = title.split(/\s+[|·–—]\s+/);
    const brand = (p) => p.length < 50 && [siteName, host(url).split('.').slice(-2, -1)[0]].some(x => x && p.toLowerCase().includes(x.toLowerCase()));
    if (parts.length > 1 && brand(parts.at(-1))) title = parts.slice(0, -1).join(' | ');
  }
  const authorEl = find(doc, n => n.attrs.rel === 'author' || /(^|\s)(byline|author-name|author__name|post-author|article-author)(\s|$)/i.test(n.attrs.class || '') || n.attrs.itemprop === 'author');
  const byline = names(art?.author).join(', ') || meta('author', 'article:author', 'parsely-author') || (authorEl && squash(textOf(authorEl)).length < 80 ? squash(textOf(authorEl)).replace(/^by\s+/i, '') : null);
  const time = find(doc, n => n.tag === 'time' && n.attrs.datetime);
  const published = art?.datePublished || meta('article:published_time', 'og:published_time', 'date', 'parsely-pub-date', 'dc.date') || time?.attrs.datetime || null;
  const image = [].concat(art?.image || [])[0];
  const cover = absolute(meta('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src') || (typeof image === 'string' ? image : image?.url), url);
  return {
    title, siteName, byline: byline && !/^https?:/.test(byline) && !/^@/.test(byline) ? byline : byline?.replace(/^@/, '') || null,
    published: published && !isNaN(Date.parse(published)) ? new Date(published).toISOString() : null,
    cover, description: meta('og:description', 'description', 'twitter:description'),
    lang: attr(find(doc, n => n.tag === 'html'), 'lang'),
    canonical: absolute(attr(find(doc, n => n.tag === 'link' && /(^|\s)canonical(\s|$)/i.test(n.attrs.rel || '')), 'href'), url),
    typed: !!art || meta('og:type') === 'article'
  };
}

// ── finding the content ──────────────────────────────────────────────────
function prune(n) {
  n.children = n.children.filter(c => {
    if (typeof c === 'string') return true;
    if (DROP.has(c.tag)) return false;
    if (c.attrs.hidden !== undefined || c.attrs['aria-hidden'] === 'true' || /display:\s*none|visibility:\s*hidden/i.test(c.attrs.style || '')) return false;
    const ci = classId(c);
    if (ci.trim() && UNLIKELY.test(ci) && !LIKELY.test(ci) && !['body', 'article', 'main'].includes(c.tag)) return false;
    // Page headers: keep one only when it's inside the article (it often holds the title and byline).
    if (c.tag === 'header' && !c.parent?.tag.match(/article/)) return false;
    prune(c);
    return true;
  });
}
const linkText = (n) => [...walk(n)].filter(e => e.tag === 'a').reduce((s, a) => s + squash(textOf(a)).length, 0);
function score(n) {
  const scores = new Map();
  for (const p of walk(n)) {
    if (!['p', 'pre', 'blockquote', 'li', 'td'].includes(p.tag)) continue;
    const t = squash(textOf(p));
    if (t.length < 25) continue;
    const s = 1 + t.split(',').length + Math.min(3, t.length / 100);
    let a = p.parent, k = 1;
    for (let depth = 0; a && depth < 3; depth++, a = a.parent, k /= 2) scores.set(a, (scores.get(a) || 0) + s * k);
  }
  let best = null, bestScore = 0;
  for (const [el, s] of scores) {
    const len = squash(textOf(el)).length || 1;
    const adj = s * (1 - Math.min(0.9, linkText(el) / len)) * (LIKELY.test(classId(el)) ? 1.25 : 1);
    if (adj > bestScore) { best = el; bestScore = adj; }
  }
  return best;
}
function content(body) {
  const scored = score(body);
  const explicit = find(body, n => n.attrs.itemprop === 'articleBody' || EXPLICIT.test(n.attrs.class || ''))
    || findAll(body, n => n.tag === 'article').sort((a, b) => textOf(b).length - textOf(a).length)[0]
    || find(body, n => n.tag === 'main' || n.attrs.role === 'main');
  const len = (n) => n ? squash(textOf(n)).length : 0;
  if (explicit && len(explicit) >= 0.5 * len(scored)) return explicit;
  return scored || explicit || body;
}

// ── into blocks ──────────────────────────────────────────────────────────
function imageOf(img, base) {
  const src = img.attrs['data-src'] || img.attrs['data-lazy-src'] || img.attrs['data-original'] || img.attrs.src;
  // The largest candidate in srcset, when there is one.
  const set = (img.attrs.srcset || img.attrs['data-srcset'] || '').split(',').map(s => s.trim().split(/\s+/)).filter(p => p[0]).map(([u, w]) => [u, parseFloat(w) || 0]).sort((a, b) => b[1] - a[1])[0]?.[0];
  const url = absolute(set || src, base);
  if (!url || /^data:/.test(url) || /\.svg(\?|$)/i.test(url)) return null;
  const w = Number(img.attrs.width), h = Number(img.attrs.height);
  if ((w && w < 80) || (h && h < 60)) return null; // icons, avatars, tracking pixels
  return url;
}
function toBlocks(root, base) {
  const blocks = [];
  let buf = '';
  const flush = () => { const t = squash(buf); if (t) blocks.push({ type: 'p', text: t }); buf = ''; };
  const inline = (n) => typeof n === 'string' ? n : n.tag === 'br' ? '\n' : n.tag === 'img' ? '' : n.children.map(inline).join('');
  const block = (n, type) => { const t = squash(inline(n)); if (t) blocks.push({ type, text: t }); };
  const visit = (n) => {
    for (const c of n.children) {
      if (typeof c === 'string') { buf += c; continue; }
      if (INLINE.has(c.tag) && !find(c, e => e.tag === 'img' || !INLINE.has(e.tag) && e.tag !== 'br')) { buf += inline(c); continue; }
      if (c.tag === 'br') { buf += '\n'; continue; }
      flush();
      if (/^h[1-6]$/.test(c.tag)) block(c, c.tag <= 'h2' ? 'h2' : c.tag === 'h3' ? 'h3' : 'h4');
      else if (c.tag === 'p') { for (const img of findAll(c, e => e.tag === 'img')) { const u = imageOf(img, base); if (u) blocks.push({ type: 'image', url: u }); } block(c, 'p'); }
      else if (c.tag === 'ul' || c.tag === 'ol') for (const li of findAll(c, e => e.tag === 'li' && e.parent === c)) block(li, c.tag === 'ul' ? 'li' : 'oli');
      else if (c.tag === 'blockquote') { const t = squash(textOf(c)); if (t) blocks.push({ type: 'quote', text: t }); }
      else if (c.tag === 'pre') { const t = textOf(c).replace(/^\n+|\s+$/g, ''); if (t) blocks.push({ type: 'code', text: t }); }
      else if (c.tag === 'hr') blocks.push({ type: 'divider' });
      else if (c.tag === 'img') { const u = imageOf(c, base); if (u) blocks.push({ type: 'image', url: u }); }
      else if (c.tag === 'figure' || c.tag === 'picture') {
        const img = find(c, e => e.tag === 'img'); const u = img && imageOf(img, base);
        if (u) blocks.push({ type: 'image', url: u });
        const cap = find(c, e => e.tag === 'figcaption'); if (cap) block(cap, 'caption');
      }
      else if (c.tag === 'table') for (const tr of findAll(c, e => e.tag === 'tr')) { const t = findAll(tr, e => e.tag === 'td' || e.tag === 'th').map(td => squash(textOf(td))).filter(Boolean).join(' · '); if (t) blocks.push({ type: 'p', text: t }); }
      else visit(c);
      flush();
    }
  };
  visit(root);
  flush();
  return blocks;
}
const DATE_ONLY = /^(\w{3,9}\.? \d{1,2},? \d{4}|\d{1,2} \w{3,9} \d{4}|\d{4}-\d{2}-\d{2}|(updated|published|posted)[: ].{0,40})$/i;
function tidy(blocks, meta) {
  const out = [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  // The page's own title heading near the top: it and the short labels above it (section, date) go.
  const t = blocks.slice(0, 8).findIndex(b => b.text && norm(b.text) === norm(meta.title));
  if (t >= 0 && blocks.slice(0, t).every(b => !b.text || b.text.length < 120)) blocks = blocks.slice(t + 1);
  // Dates, reading times and bylines just under it.
  while (blocks.length && blocks[0].text && blocks[0].text.length < 60 && (DATE_ONLY.test(blocks[0].text) || /\d+\s*min(ute)?s?\s+read/i.test(blocks[0].text) || (meta.byline && norm(blocks[0].text).includes(norm(meta.byline))))) blocks = blocks.slice(1);
  for (const b of blocks) {
    // The title and byline are shown above the article; don't repeat them at its top.
    if (!out.some(x => x.type === 'p') && b.text && (norm(b.text) === norm(meta.title) || (meta.byline && norm(b.text).length < 80 && norm(b.text).includes(norm(meta.byline))))) continue;
    if (b.type === 'image' && (b.url === meta.cover && !out.length || out.some(x => x.url === b.url))) continue;
    if (b.text && /^(share|tweet|email|copy link|subscribe|sign up|advertisement|related( posts| articles)?|read more|continue reading)[\s:.!]*$/i.test(b.text)) continue;
    const prev = out.at(-1);
    if (prev && prev.type === b.type && b.type !== 'p' && prev.text === b.text) continue;
    out.push(b);
  }
  while (out.length && out[0].type === 'divider') out.shift();
  while (out.length && (out.at(-1).type === 'divider' || out.at(-1).type === 'image' && out.length > 1 && out.at(-2).type !== 'p')) out.pop();
  return out;
}

export function extractArticle(html, url) {
  const doc = parseHtml(html);
  const meta = readMeta(doc, url);
  const body = find(doc, n => n.tag === 'body') || doc;
  prune(body);
  const blocks = tidy(toBlocks(content(body), url), meta);
  const text = blocks.filter(b => b.text).map(b => b.text).join('\n\n');
  const words = text.split(/\s+/).filter(Boolean).length;
  const paragraphs = blocks.filter(b => b.type === 'p' && b.text.length > 80).length;
  // A landing page has many words in many tiny pieces; an article has paragraphs.
  const typed = meta.typed || /\/(blog|news|posts?|articles?|p|essays?|writing|notes)\/[^/]+/i.test(new URL(url).pathname);
  const dense = words / Math.max(1, blocks.filter(b => b.text).length) >= 12;
  return { ...meta, site: host(url), blocks, text, words, isArticle: words >= 150 && paragraphs >= 2 && (typed || (words >= 300 && paragraphs >= 4 && dense)) };
}
