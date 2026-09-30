// Loading the library and reading it: tags with your edits, formats, the stack, files.
import { num } from '../core/dom.js';
import { store } from '../core/state.js';
import { readLen } from './query.js';
import { relDate, snippet } from '../ui/format.js';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && path !== '/api/logout') { location.reload(); throw new Error('Signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}
export async function loadAll() {
  const [data, tax, state] = await Promise.all([
    fetch('/data/bookmarks.json', { cache: 'no-cache' }).then(r => { if (r.status === 401) location.reload(); return r.json(); }),
    fetch('/data/taxonomy.json', { cache: 'no-cache' }).then(r => r.json()),
    api('/api/state').catch(() => ({ overrides: {}, settings: {} }))
  ]);
  store.records = data.records;
  store.generatedAt = data.generatedAt;
  store.byId = new Map(data.records.map(r => [r.id, r]));
  setTaxonomy(tax);
  store.overrides = state.overrides || {};
  store.settings = state.settings || {};
  store.tagCache.clear(); store.hay.clear();
}
export function setTaxonomy(tax) {
  store.facets = tax.facets;
  store.concepts = tax.concepts;
  store.conceptById = new Map(tax.concepts.map(c => [c.id, c]));
  store.children = new Map();
  for (const c of tax.concepts) if (c.parent) { if (!store.children.has(c.parent)) store.children.set(c.parent, []); store.children.get(c.parent).push(c.id); }
}
export const label = (id) => store.conceptById.get(id)?.label || id.split(':').slice(1).join(':').split('/').pop().replace(/-/g, ' ');
export const facetOf = (id) => store.conceptById.get(id)?.facet || id.split(':')[0];
export function descendants(id) { const out = [id]; for (const c of store.children.get(id) || []) out.push(...descendants(c)); return out; }
export function ancestors(id) { const out = []; let c = store.conceptById.get(id); while (c?.parent) { out.push(c.parent); c = store.conceptById.get(c.parent); } return out; }
export function tagsOf(r) {
  let t = store.tagCache.get(r.id);
  if (t) return t;
  const o = store.overrides[r.id] || {};
  const removed = new Set(o.remove || []);
  const set = new Map();
  for (const tag of r.tags) if (!removed.has(tag.id)) set.set(tag.id, tag);
  for (const id of o.add || []) set.set(id, { id, by: 'you', score: 1, sources: ['you'] });
  // Manual format override replaces the machine format.
  if ((o.add || []).some(id => facetOf(id) === 'format')) for (const [id, tag] of set) if (facetOf(id) === 'format' && tag.by !== 'you') set.delete(id);
  t = [...set.values()];
  store.tagCache.set(r.id, t);
  return t;
}
export const tagIds = (r) => tagsOf(r).map(t => t.id);
export const formatOf = (r) => tagIds(r).find(id => facetOf(id) === 'format') || r.format;
export const triage = (r) => store.overrides[r.id]?.triaged || null;
// Read is a label on a bookmark, not a triage status; deleted bookmarks don't carry it.
export const isRead = (r) => { const o = store.overrides[r.id]; return !!o?.read && !o.deleted; };
// The stack: a short reading list of at most five, first in first out — adding a sixth lets the oldest go.
export const STACK_MAX = 5;
export const stackAll = () => Object.entries(store.overrides)
  .filter(([id, o]) => o.stackedAt && !o.deleted && store.byId.has(id))
  .sort((a, b) => a[1].stackedAt.localeCompare(b[1].stackedAt))
  .map(([id]) => store.byId.get(id));
export const stackList = () => stackAll().slice(-STACK_MAX);
// Media-only posts have no text to title them by.
export const titleOf = (r, n) => r.article?.title || r.title || snippet(r, n) || r.card?.title || `${label(formatOf(r))} from @${r.author.handle}`;
export const minutes = (r) => Math.max(1, Math.round(readLen(r) / 1100));
export const readTime = (m) => m >= 90 ? `${Math.round(m / 60)} h` : `${m} min`;
// Files you added (images, PDFs, books, text) have a document instead of an author on X.
export const isFile = (r) => r.provider === 'file';
export const isDoc = (r) => isFile(r) && r.doc?.kind !== 'image';
export const KIND_NAME = { pdf: 'PDF', epub: 'EPUB', mobi: 'MOBI', text: 'Text', image: 'Image' };
// What stands in for "@handle": the file's type and size.
export function fileLine(r) {
  const d = r.doc || {};
  return [KIND_NAME[d.kind], d.pages ? `${num.format(d.pages)} pages` : d.chapters > 1 ? `${d.chapters} chapters` : '', d.width && d.height ? `${d.width}×${d.height}` : ''].filter(Boolean).join(' · ');
}
export const who = (r) => isFile(r) ? (r.author.name || fileLine(r)) : `@${r.author.handle}`;
export const progressOf = (r) => store.overrides[r.id]?.progress || 0;
export const readWhen = (iso) => { const d = relDate(iso); return d === 'now' ? 'just now' : /^\d+[mhd]$/.test(d) ? `${d} ago` : d; };
export async function loadStatus() { store.status = await api('/api/status').catch(() => null); }
