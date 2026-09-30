// Adding tags: suggestions as you type, new concepts on the fly, and accepting Jev's suggested topics.
import { $, $$ } from '../core/dom.js';
import { store } from '../core/state.js';
import { setTags } from '../data/history.js';
import { api, label, loadAll, setTaxonomy, tagIds } from '../data/library.js';
import { toast } from '../ui/toast.js';
import { tagEditor } from '../views/post.js';

export function suggestions(q, r) {
  const have = new Set(tagIds(r));
  const lq = q.toLowerCase().trim();
  const out = store.concepts.filter(c => !have.has(c.id) && c.facet !== 'source' && (!lq || c.label.toLowerCase().includes(lq) || c.id.includes(lq) || (c.aliases || []).some(a => a.startsWith(lq))))
    .sort((a, b) => (a.label.toLowerCase().startsWith(lq) ? 0 : 1) - (b.label.toLowerCase().startsWith(lq) ? 0 : 1) || a.label.length - b.label.length)
    .slice(0, 8).map(c => ({ id: c.id, text: c.parent ? `${label(c.parent)} / ${c.label}` : c.label, facet: c.facet }));
  if (lq && !store.concepts.some(c => c.label.toLowerCase() === lq)) {
    out.push({ create: 'label', text: `New label “${q.trim()}”` }, { create: 'topic', text: `New topic “${q.trim()}”` });
  }
  return out;
}
const slug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
export async function createConcept({ facet, labelText, parent = null, aliases = [] }) {
  const id = `${facet}:${parent ? `${parent.split(':')[1]}/` : ''}${slug(labelText)}`;
  const concept = { label: labelText.trim(), facet, parent, aliases };
  await api('/api/taxonomy', { method: 'PUT', body: { id, patch: concept } });
  const c = { id, ...concept, origin: 'user' };
  if (!store.conceptById.has(id)) setTaxonomy({ facets: store.facets, concepts: [...store.concepts, c] });
  return id;
}
// Jev's suggested topic, accepted: create it (or use one that now exists) and tag this file.
export async function acceptSuggestion(btn) {
  const r = store.byId.get(btn.closest('[data-tags]')?.dataset.tags);
  if (!r) return;
  const name = btn.dataset.suggest, parent = btn.dataset.parent || null;
  const existing = store.concepts.find(c => c.facet !== 'source' && c.label.toLowerCase() === name.toLowerCase());
  const id = existing?.id || await createConcept({ facet: 'topic', labelText: name, parent: parent && store.conceptById.has(parent) ? parent : null });
  await setTags(r, { add: [id] });
  rerenderTags(r);
  toast(existing ? `Tagged ${label(id)}` : `New topic “${name}”${parent && store.conceptById.has(parent) ? ` under ${label(parent)}` : ''}, tagged`, { undo: true });
}
export async function reloadTaxonomy() {
  // Keyword edits change machine tags, so reload the rebuilt index too.
  await loadAll();
}
export function rerenderTags(r) {
  for (const box of $$(`[data-tags="${r.id}"]`)) box.innerHTML = tagEditor(r);
}
export async function pickSuggestion(el) {
  const box = el.closest('[data-tags]');
  const r = store.byId.get(box.dataset.tags);
  const input = $('[data-tag-input]', box);
  let id = el.dataset.sid;
  if (el.dataset.create) id = await createConcept({ facet: el.dataset.create, labelText: input.value });
  await setTags(r, { add: [id] });
  rerenderTags(r);
  $('[data-tag-input]', box)?.focus();
}
