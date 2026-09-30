// Small pieces of markup shared by every view: dates, bylines, tags, media.
import { esc } from '../core/dom.js';
import { prefs } from '../core/prefs.js';
import { store } from '../core/state.js';
import { KIND_NAME, ancestors, facetOf, fileLine, formatOf, isDoc, isFile, isRead, label, progressOf, tagsOf, titleOf } from '../data/library.js';

export const relDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), days = (Date.now() - d) / 864e5;
  if (days < 1 / 24) return days * 1440 < 2 ? 'now' : `${Math.round(days * 1440)}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};
export const fullDate = (iso) => iso ? new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
export const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const img = (url, size = 'small') => /pbs\.twimg\.com\/media\//.test(url || '') ? `${url.split('?')[0]}?name=${size}` : url;
export const avatar = (a) => a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="avatar blank">${esc((a.name || '?')[0])}</span>`;
export function richText(text = '') {
  const parts = esc(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return parts.map(p => `<p>${p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}${u.length > 56 ? '…' : ''}</a>`).replace(/(^|\s)@(\w{1,15})/g, '$1<a href="https://x.com/$2" target="_blank" rel="noopener noreferrer">@$2</a>')}</p>`).join('');
}
export const plain = (text = '') => text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
export function snippet(r, n = 220, { afterTitle = false } = {}) {
  let t = plain(r.article?.preview || r.text) || r.card?.description || '';
  if (afterTitle && r.title && t.startsWith(r.title.replace(/…$/, ''))) t = t.slice(r.title.replace(/…$/, '').length).trim() || r.card?.description || '';
  return t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t;
}
const FORMAT_GLYPH = { 'format:thread': '≡', 'format:article': '¶', 'format:link': '↗', 'format:repo': '{}', 'format:video': '▶', 'format:image': '◐', 'format:quote': '❝', 'format:post': '·' };
export function formatBadge(r) {
  const f = formatOf(r);
  const extra = f === 'format:thread' && r.thread ? ` · ${r.thread.length}` : '';
  return `<span class="fmt">${label(f)}${extra}</span>`;
}
// The n most confident descriptive tags; a parent is dropped when a confident child says more.
export function topTags(r, n = 3) {
  const cands = tagsOf(r).filter(t => ['topic', 'kind', 'label'].includes(facetOf(t.id)))
    .map(t => ({ ...t, rank: t.by === 'you' ? 2 : (t.score ?? 0.5) }))
    .sort((a, b) => b.rank - a.rank);
  const implied = new Set(cands.filter(t => t.rank >= 0.4).flatMap(t => ancestors(t.id)));
  return cands.filter(t => !implied.has(t.id)).slice(0, n);
}
export function tagPills(r, n = 3) {
  return topTags(r, n).map(t => {
    const path = [...ancestors(t.id).reverse().map(label), label(t.id)].join(' / ');
    const conf = t.by === 'you' ? 'added by you' : `${Math.round((t.score ?? 0) * 100)}% · ${(t.sources || [t.by]).join(' + ')}`;
    return `<span class="pill f-${facetOf(t.id)} ${t.by === 'you' ? 'mine' : ''}" title="${esc(`${path} — ${conf}`)}">${esc(label(t.id))}</span>`;
  }).join('');
}
export function visual(r) {
  // A book's or PDF's cover stands like a book: taller than wide.
  if (r.doc?.cover && r.doc.kind !== 'image') return { url: r.doc.cover, w: 2, h: 3, cover: true };
  const m = r.media?.[0];
  if (m && (!r.sensitive || prefs.showSensitive)) return { url: img(m.url), w: m.width, h: m.height, video: m.type === 'video' || m.type === 'gif', count: r.media.length };
  if (r.article?.cover) return { url: r.article.cover, w: 5, h: 2 };
  if (r.card?.image) return { url: r.card.image, w: 1.91, h: 1 };
  return null;
}
export function mediaTile(v, cls = '') {
  if (!v) return '';
  const ratio = v.w && v.h ? Math.max(0.56, Math.min(1.6, v.h / v.w)) : 0.66;
  return `<div class="tile-media ${cls}" style="--ratio:${ratio}"><img src="${esc(v.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${v.video ? '<span class="media-flag">▶</span>' : v.count > 1 ? `<span class="media-flag">${v.count}</span>` : ''}</div>`;
}
// A file's "avatar": its cover, small, or the kind of file.
export const avatarOf = (r) => isFile(r) ? fileAvatar(r) : avatar(r.author);
const fileAvatar = (r) => r.doc?.cover ? `<img class="avatar file" src="${esc(r.doc.cover)}" alt="" loading="lazy">` : `<span class="avatar blank file">${esc((KIND_NAME[r.doc?.kind] || 'F')[0])}</span>`;
export function byline(r, withDate = true) {
  if (isFile(r)) return `<div class="byline">${fileAvatar(r)}${r.author.name ? `<span class="name">${esc(r.author.name)}</span>` : ''}<span class="handle">${esc(fileLine(r))}</span>${withDate ? `<span class="date">${relDate(r.postedAt)}</span>` : ''}</div>`;
  return `<div class="byline">${avatar(r.author)}<span class="name">${esc(r.author.name)}</span><span class="handle">@${esc(r.author.handle)}</span>${withDate ? `<span class="date">${relDate(r.postedAt)}</span>` : ''}</div>`;
}
// How far into a book or PDF you are.
export const progressMark = (r) => { const p = isDoc(r) ? progressOf(r) : 0; return p > 0.005 && !isRead(r) ? `<span class="progress-mark" title="${Math.round(p * 100)}% read"><i style="--p:${p}"></i>${Math.round(p * 100)}%</span>` : ''; };
export const readMark = (r) => isRead(r) ? `<span class="read-mark" title="Read ${esc(fullDate(store.overrides[r.id].readAt))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.4 2.8 2.8 6.2-6.4"/></svg>Read</span>` : '';
export const bytes = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round((n || 0) / 1e3))} KB`;
export const bytesFmt = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round((n || 0) / 1e3)} KB`;
export const shortTitle = (r) => { const t = titleOf(r, 60); return t.length > 44 ? `${t.slice(0, 44).replace(/\s+\S*$/, '')}…` : t; };
