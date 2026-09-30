// The taxonomy page: concepts per facet, and editing one.
import { $, $$, esc, num } from '../core/dom.js';
import { store, ui, view } from '../core/state.js';
import { ancestors, descendants, facetOf, label, tagIds, who } from '../data/library.js';
import { sortRecords } from '../data/query.js';
import { snippet } from '../ui/format.js';

function conceptCounts() {
  const counts = new Map();
  for (const r of store.records) { const seen = new Set(); for (const id of tagIds(r)) for (const a of [id, ...ancestors(id)]) if (!seen.has(a)) { seen.add(a); counts.set(a, (counts.get(a) || 0) + 1); } }
  return counts;
}
export function renderTaxonomy() {
  const counts = conceptCounts();
  const facet = ui.taxFacet;
  const q = ui.taxQuery.toLowerCase();
  const inFacet = store.concepts.filter(c => c.facet === facet);
  const max = Math.max(1, ...inFacet.map(c => counts.get(c.id) || 0));
  const matches = (c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q) || (c.aliases || []).some(a => a.includes(q));
  const visibleIds = new Set();
  for (const c of inFacet) if (matches(c)) { visibleIds.add(c.id); ancestors(c.id).forEach(a => visibleIds.add(a)); }
  const rows = (parent, depth) => inFacet.filter(c => (c.parent || null) === parent && visibleIds.has(c.id)).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)).map(c => {
    const n = counts.get(c.id) || 0;
    return `<div class="t-row ${ui.taxSelected === c.id ? 'on' : ''} ${depth ? 'child' : ''}" data-concept="${esc(c.id)}" style="--depth:${depth}" tabindex="0">
      <span class="t-label">${esc(c.label)}${c.origin === 'user' ? '<span class="dot" title="Added by you"></span>' : ''}</span>
      <span class="t-id">${esc(c.id)}</span>
      <span class="t-alias">${(c.aliases || []).length || ''}</span>
      <span class="t-count"><span class="bar" style="--w:${(n / max) * 100}%"></span>${num.format(n)}</span>
    </div>${rows(c.id, depth + 1)}`;
  }).join('');
  const untagged = store.records.filter(r => !tagIds(r).some(id => facetOf(id) === 'topic')).length;
  view().className = 'view taxonomy';
  view().innerHTML = `
    <div class="page-head"><h1 class="serif">Taxonomy</h1>
      <div class="page-actions"><input class="field" id="tax-search" placeholder="Filter concepts" value="${esc(ui.taxQuery)}"><button class="primary" data-new-concept>New concept</button></div></div>
    <nav class="tabs">${store.facets.filter(f => f.id !== 'source').map(f => `<button data-facet="${f.id}" aria-pressed="${facet === f.id}">${f.label}<span>${store.concepts.filter(c => c.facet === f.id).length}</span></button>`).join('')}</nav>
    <div class="t-layout">
      <div class="t-table">
        <div class="t-row head"><span>Concept</span><span class="t-id">ID</span><span class="t-alias">Aliases</span><span class="t-count">Bookmarks</span></div>
        ${rows(null, 0) || '<p class="muted pad">No concepts yet. Add one, or create labels from any bookmark.</p>'}
        ${facet === 'topic' && untagged ? `<button class="t-untagged" data-view-untagged>${num.format(untagged)} bookmarks have no topic →</button>` : ''}
      </div>
      <aside class="t-detail" id="t-detail">${conceptDetail(ui.taxSelected, counts)}</aside>
    </div>`;
}
function conceptDetail(id, counts) {
  const isNew = id === '__new';
  const c = isNew ? { id: '', label: '', facet: ui.taxFacet, parent: null, aliases: [] } : store.conceptById.get(id);
  if (!c) return `<div class="t-empty"><p class="muted">Select a concept to rename it, move it under another, or edit the keywords that route bookmarks to it.</p></div>`;
  const parents = store.concepts.filter(p => p.facet === c.facet && p.id !== c.id && !descendants(c.id).includes(p.id));
  const samples = isNew ? [] : sortRecords(store.records.filter(r => tagIds(r).some(t => descendants(c.id).includes(t))), 'bookmarked').slice(0, 5);
  return `<form class="t-form" data-concept-form="${esc(c.id)}">
    <h2 class="serif">${isNew ? 'New concept' : esc(c.label)}</h2>
    ${isNew ? '' : `<p class="mono muted small">${esc(c.id)} · ${num.format(counts.get(c.id) || 0)} bookmarks</p>`}
    <label>Name<input class="field" name="label" value="${esc(c.label)}" required></label>
    <label>Facet<select class="field" name="facet" ${isNew ? '' : 'disabled'}>${store.facets.filter(f => f.id !== 'source').map(f => `<option value="${f.id}" ${f.id === c.facet ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
    <label>Parent<select class="field" name="parent"><option value="">None (top level)</option>${parents.map(p => `<option value="${esc(p.id)}" ${p.id === c.parent ? 'selected' : ''}>${esc(p.parent ? `${label(p.parent)} / ${p.label}` : p.label)}</option>`).join('')}</select></label>
    <label>Keywords<textarea class="field" name="aliases" rows="4" placeholder="comma separated — bookmarks mentioning these get this tag">${esc((c.aliases || []).join(', '))}</textarea></label>
    <div class="t-form-actions"><button class="primary" type="submit">${isNew ? 'Create' : 'Save'}</button>${isNew ? '<button class="ghost" type="button" data-cancel-concept>Cancel</button>' : `<button class="ghost" type="button" data-browse="${esc(c.id)}">View bookmarks</button><button class="ghost danger" type="button" data-delete-concept="${esc(c.id)}">${c.origin === 'user' ? 'Delete' : 'Retire'}</button>`}</div>
    ${samples.length ? `<div class="t-samples"><h4>Recent</h4>${samples.map(r => `<button type="button" class="t-sample" data-open="${r.id}"><span>${esc((r.title || snippet(r, 80)).slice(0, 80))}</span><span class="muted">${esc(who(r))}</span></button>`).join('')}</div>` : ''}
  </form>`;
}
export function moveTaxonomy(d) {
  const rows = $$('.t-row[data-concept]');
  if (!rows.length) return;
  const i = rows.findIndex(r => r.dataset.concept === ui.taxSelected);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))];
  ui.taxSelected = next.dataset.concept;
  renderTaxonomy();
  const el = $(`.t-row[data-concept="${CSS.escape(ui.taxSelected)}"]`);
  el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest' });
}
