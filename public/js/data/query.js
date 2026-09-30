// Search, filters, triage status and sort orders over the loaded library.
import { store, ui } from '../core/state.js';
import { descendants, facetOf, label, tagIds, triage } from './library.js';

function haystack(r) {
  let h = store.hay.get(r.id);
  if (h) return h;
  h = [r.title, r.text, r.author.name, r.author.handle, ...(r.thread || []).map(t => t.text), r.article?.title, ...(r.article?.blocks || []).slice(0, 60).map(b => b.text || ''), r.card?.title, r.card?.description, r.card?.domain, r.quoted?.text, ...(r.quoted?.thread || []).map(t => t.text), r.quoted?.article?.title, ...(r.quoted?.article?.blocks || []).slice(0, 60).map(b => b.text || ''),...tagIds(r).map(label), store.overrides[r.id]?.scratchpad, ...(store.overrides[r.id]?.highlights || []).flatMap(h => [h.quote || h.text, h.note]), r.doc?.name, r.doc?.description, ...(r.doc?.subjects || []), r.doc?.publisher, r.doc?.excerpt, ...(r.media || []).map(m => m.description)].filter(Boolean).join(' ').toLowerCase();
  store.hay.set(r.id, h);
  return h;
}
export function matchesQuery(r, q) {
  if (!q) return true;
  const h = haystack(r);
  for (const term of q.toLowerCase().match(/"[^"]+"|\S+/g) || []) {
    if (term.startsWith('from:')) { if (r.author.handle.toLowerCase() !== term.slice(5).replace('@', '')) return false; continue; }
    if (!h.includes(term.replace(/"/g, ''))) return false;
  }
  return true;
}
// OR within a facet, AND across facets; parents include their descendants.
function filterGroups(filters) {
  const groups = new Map();
  for (const id of filters) { const f = facetOf(id); if (!groups.has(f)) groups.set(f, new Set()); for (const d of descendants(id)) groups.get(f).add(d); }
  return [...groups.values()];
}
export const TRASH_DAYS = 30;
export function daysLeft(r) { const o = store.overrides[r.id]; if (!o?.deleted) return null; return Math.max(0, TRASH_DAYS - Math.floor((Date.now() - Date.parse(o.deletedAt || o.updatedAt || Date.now())) / 864e5)); }
export function statusOk(r, status) {
  const o = store.overrides[r.id];
  if (o?.purged) return false;
  if (o?.deleted) return status === 'deleted';
  if (status === 'deleted') return false;
  const t = triage(r);
  if (status === 'active') return t !== 'archived';
  if (status === 'inbox') return !t;
  if (status === 'kept') return t === 'kept';
  if (status === 'archived') return t === 'archived';
  return true;
}
export const SORTS = [['bookmarked', 'Recently saved'], ['oldest', 'Oldest saved'], ['posted', 'Newest posted'], ['posted-old', 'Oldest posted'], ['saves', 'Most saved'], ['likes', 'Most liked'], ['longest', 'Longest reads'], ['shortest', 'Quickest reads'], ['read', 'Recently read'], ['random', 'Random']];
export const FORMAT_TABS = [['all', 'All'], ['format:thread', 'Threads'], ['format:article', 'Articles'], ['format:link', 'Links'], ['format:repo', 'Repos'], ['format:video', 'Video'], ['format:image', 'Images'], ['format:quote', 'Quotes'], ['format:post', 'Posts'], ['format:book', 'Books'], ['format:document', 'Documents'], ['format:note', 'Notes']];
export const WINDOWS = [['all', 'Any time'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['older', 'Older than 30 days']];
// Rough reading length in characters: whole thread, article body, or the post.
export function readLen(r) {
  if (r._len != null) return r._len;
  // A book or PDF: its word count, at about six characters a word.
  if (r.doc?.words) return (r._len = r.doc.words * 6);
  let n =r.thread ? r.thread.reduce((s, t) => s + (t.text?.length || 0), 0) : (r.text?.length || 0);
  if (r.article) n += r.article.blocks.reduce((s, b) => s + (b.text?.length || 0), 0);
  // A fully captured quoted thread or article is part of the read.
  const q = r.quoted;
  if (q?.thread) n += q.thread.reduce((s, t) => s + (t.text?.length || 0), 0);
  if (q?.article) n += q.article.blocks.reduce((s, b) => s + (b.text?.length || 0), 0);
  return (r._len = n);
}
// Stable per-record random keys: reshuffled on demand (reshuffleRandomSort), otherwise cached
// so re-renders (search, pagination, filters) don't jump the order around under the reader.
let randomOrder = new Map();
export function reshuffleRandomSort() { randomOrder.clear(); }
function randomKey(r) {
  let k = randomOrder.get(r.id);
  if (k == null) { k = Math.random(); randomOrder.set(r.id, k); }
  return k;
}
export function sortRecords(list, sort) {
  const eng = (r, k) => r.engagement?.[k] || 0;
  const by = {
    bookmarked: (a, b) => b.order - a.order,
    oldest: (a, b) => a.order - b.order,
    posted: (a, b) => String(b.postedAt).localeCompare(String(a.postedAt)),
    'posted-old': (a, b) => String(a.postedAt).localeCompare(String(b.postedAt)),
    saves: (a, b) => eng(b, 'bookmarkCount') - eng(a, 'bookmarkCount'),
    likes: (a, b) => eng(b, 'likeCount') - eng(a, 'likeCount'),
    longest: (a, b) => readLen(b) - readLen(a) || b.order - a.order,
    shortest: (a, b) => readLen(a) - readLen(b) || b.order - a.order,
    read: (a, b) => String(store.overrides[b.id]?.readAt || '').localeCompare(String(store.overrides[a.id]?.readAt || '')) || b.order - a.order,
    random: (a, b) => randomKey(a) - randomKey(b)
  }[sort] || ((a, b) => b.order - a.order);
  return list.sort(by);
}
export function query({ q = ui.query, filters = ui.filters, status = ui.status, except } = {}) {
  const groups = filterGroups([...filters].filter(id => facetOf(id) !== except));
  return store.records.filter(r => {
    if (!statusOk(r, status) || !matchesQuery(r, q)) return false;
    if (!groups.length) return true;
    const ids = tagIds(r);
    return groups.every(g => ids.some(id => g.has(id)));
  });
}
