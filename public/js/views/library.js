// The library: filters rail, the stack, and the wall, grid and list of bookmarks.
import { capsText } from '../app/keymap.js';
import { $, $$, esc, num } from '../core/dom.js';
import { prefs, savePrefs } from '../core/prefs.js';
import { PAGE, store, ui, view } from '../core/state.js';
import { STACK_MAX, ancestors, facetOf, formatOf, label, minutes, stackList, tagIds, titleOf, triage } from '../data/library.js';
import { SORTS, TRASH_DAYS, query, sortRecords } from '../data/query.js';
import { estimateHeight, gridItem, listItem, wallItem } from '../ui/cards.js';

export function renderLibrary() {
  const results = sortRecords(query(), prefs.sort);
  ui.results = results;
  const shown = results.slice(0, ui.visible);
  const chips = [...ui.filters].map(id => `<button class="chip" data-unfilter="${esc(id)}">${esc(label(id))}<span aria-hidden="true">×</span></button>`).join('');
  view().className = 'view library';
  view().innerHTML = `
    <div class="rail-scrim ${ui.mobileRail ? 'open' : ''}" data-rail-close></div>
    <aside class="rail ${ui.mobileRail ? 'open' : ''}" aria-label="Filters">${renderRail()}</aside>
    <section class="stage">
      ${ui.status === 'active' && !ui.query && !ui.filters.size ? stackHtml() : ''}
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="count">${num.format(results.length)}</span>
          ${ui.status !== 'active' ? `<button class="chip status-chip" data-status="active">${{ inbox: 'Untriaged', kept: 'Kept', archived: 'Archive', deleted: 'Trash' }[ui.status]}<span aria-hidden="true">×</span></button>` : ''}${chips}${ui.filters.size || ui.query ? '<button class="ghost small" data-clear>Clear</button>' : ''}
          ${ui.status === 'deleted' ? `<span class="muted small">Deleted for good after ${TRASH_DAYS} days</span>` : ''}
        </div>
        <div class="toolbar-right">
          <button class="ghost add-files" data-add-files title="Add files or links (${esc(capsText('add'))}). You can also drop or paste them anywhere."><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg><span>Add</span></button>
          ${results.length ? `<button class="ghost read-these" data-read-all title="Go through these one by one in the Reader"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.2C6.6 3.2 4.7 2.8 2.5 3v9.3c2.2-.2 4.1.2 5.5 1.2 1.4-1 3.3-1.4 5.5-1.2V3c-2.2-.2-4.1.2-5.5 1.2zM8 4.2v9.3"/></svg><span>Open in Reader</span></button>` : ''}
          <button class="ghost rail-toggle" data-rail aria-expanded="${ui.mobileRail}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M4.5 8h7M6.5 12h3"/></svg>Filter${ui.filters.size ? `<span class="badge">${ui.filters.size}</span>` : ''}</button>
          <select id="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}" ${prefs.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="segmented" role="group" aria-label="Layout">${[['wall', 'Wall'], ['grid', 'Grid'], ['list', 'List']].map(([v, l]) => `<button data-layout="${v}" aria-pressed="${prefs.layout === v}">${l}</button>`).join('')}</div>
        </div>
      </div>
      <div id="results" class="results ${prefs.layout}"></div>
      ${results.length ? '' : `<div class="empty"><p class="serif">Nothing here.</p><button class="ghost" data-clear>Clear search and filters</button></div>`}
      <div id="sentinel" class="sentinel"></div>
    </section>`;
  paintResults(shown, true);
  observeSentinel();
}
export function paintResults(items, reset) {
  const box = $('#results');
  if (!box) return;
  if (prefs.layout === 'wall') {
    const width = box.clientWidth || window.innerWidth;
    const cols = Math.max(1, Math.min(5, Math.floor((width + 20) / 300)));
    if (reset || !box._cols || box._cols.length !== cols) {
      box.innerHTML = Array.from({ length: cols }, () => '<div class="col"></div>').join('');
      box._cols = $$('.col', box); box._heights = new Array(cols).fill(0); box._painted = 0;
      items = ui.results.slice(0, ui.visible);
    }
    const colWidth = width / cols;
    const buckets = box._cols.map(() => []);
    for (const r of items) { const i = box._heights.indexOf(Math.min(...box._heights)); buckets[i].push(wallItem(r)); box._heights[i] += estimateHeight(r, colWidth) + 16; }
    buckets.forEach((html, i) => box._cols[i].insertAdjacentHTML('beforeend', html.join('')));
  } else {
    const tpl = prefs.layout === 'grid' ? gridItem : listItem;
    const html = items.map(tpl).join('');
    if (reset) box.innerHTML = html; else box.insertAdjacentHTML('beforeend', html);
  }
}
let sentinelObserver;
function observeSentinel() {
  sentinelObserver?.disconnect();
  const s = $('#sentinel');
  if (!s) return;
  sentinelObserver = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || ui.visible >= (ui.results?.length || 0)) return;
    const next = ui.results.slice(ui.visible, ui.visible + PAGE);
    ui.visible += PAGE;
    paintResults(next, false);
  }, { rootMargin: '1200px' });
  sentinelObserver.observe(s);
}
export function setRail(open) {
  ui.mobileRail = open;
  $('.rail')?.classList.toggle('open', open);
  $('.rail-scrim')?.classList.toggle('open', open);
  $('.rail-toggle')?.setAttribute('aria-expanded', open);
  document.body.classList.toggle('rail-locked', open);
}
// Up to five chosen reads, oldest first; empty places stay as quiet outlines.
function stackHtml() {
  const stack = stackList();
  if (!stack.length) return '';
  const full = stack.length === STACK_MAX;
  const items = stack.map((r, i) => `<li class="stack-item" data-open="${r.id}" tabindex="0">
      <span class="stack-n">${i + 1}</span>
      <div class="stack-body">
        <span class="stack-by">${esc(r.author.name)}</span>
        <h3>${esc(titleOf(r, 90))}</h3>
        <span class="stack-meta">${label(formatOf(r))}${r.thread ? ` · ${r.thread.length}` : ''} · ${minutes(r)} min${full && i === 0 ? '<em>next to go</em>' : ''}</span>
      </div>
      <button class="stack-x" data-unstack="${r.id}" aria-label="Take off the stack" title="Take off the stack">×</button>
    </li>`).join('');
  const slots = Array.from({ length: STACK_MAX - stack.length }, () => '<li class="stack-slot" aria-hidden="true"></li>').join('');
  return `<section class="stack" aria-label="Reading stack">
    <header class="stack-head"><h2 class="serif">The stack</h2><span class="stack-count">${stack.length}<span>/${STACK_MAX}</span></span><p class="muted small">${full ? 'Full — the next one you add lets the oldest go.' : 'Read these next.'}</p></header>
    <ol class="stack-list">${items}${slots}</ol>
  </section>`;
}
export function renderRail() {
  const counts = new Map();
  // Facet counts respect everything except the facet's own selection, so choices stay visible.
  const perFacet = new Map();
  for (const f of ['topic', 'kind', 'format', 'contains', 'label']) perFacet.set(f, query({ except: f }));
  for (const [f, list] of perFacet) for (const r of list) {
    const seen = new Set();
    for (const id of tagIds(r)) { if (facetOf(id) !== f) continue; for (const a of [id, ...ancestors(id)]) if (!seen.has(a)) { seen.add(a); counts.set(a, (counts.get(a) || 0) + 1); } }
  }
  const statusCounts = { active: 0, inbox: 0, kept: 0, archived: 0, deleted: query({ status: 'deleted' }).length };
  for (const r of query({ status: 'all' })) { const t = triage(r); if (t !== 'archived') statusCounts.active++; if (!t) statusCounts.inbox++; if (t === 'kept') statusCounts.kept++; if (t === 'archived') statusCounts.archived++; }
  const item = (id, depth = 0) => {
    const c = store.conceptById.get(id);
    const kids = (store.children.get(id) || []).filter(k => counts.get(k) || ui.filters.has(k));
    const n = counts.get(id) || 0;
    if (!n && !ui.filters.has(id)) return '';
    const open = ui.railOpen.has(id) || kids.some(k => ui.filters.has(k));
    return `<li class="${ui.filters.has(id) ? 'on' : ''}" style="--depth:${depth}">
      <div class="rail-row">${kids.length ? `<button class="caret ${open ? 'open' : ''}" data-caret="${esc(id)}" aria-label="Expand">›</button>` : '<span class="caret-space"></span>'}<button class="rail-item" data-filter="${esc(id)}"><span>${esc(c?.label || label(id))}</span><span class="n">${num.format(n)}</span></button></div>
      ${kids.length && open ? `<ul>${kids.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0)).map(k => item(k, depth + 1)).join('')}</ul>` : ''}</li>`;
  };
  const section = (facet, title) => {
    const roots = store.concepts.filter(c => c.facet === facet && !c.parent).map(c => c.id).sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    const html = roots.map(id => item(id)).join('');
    return html ? `<section class="rail-group"><h4>${title}</h4><ul>${html}</ul></section>` : '';
  };
  return `<div class="rail-head"><strong>Filters</strong>${ui.filters.size ? '<button class="ghost small" data-clear>Clear</button>' : ''}<button class="primary small-btn" data-rail-close>Done</button></div><section class="rail-group"><h4>Status</h4><ul>${[['active', 'All'], ['inbox', 'Untriaged'], ['kept', 'Kept'], ['archived', 'Archived'], ['deleted', 'Trash']].map(([v, l]) => `<li class="${ui.status === v ? 'on' : ''}"><div class="rail-row"><span class="caret-space"></span><button class="rail-item" data-status="${v}"><span>${l}</span><span class="n">${num.format(statusCounts[v])}</span></button></div></li>`).join('')}</ul></section>
    ${section('topic', 'Topic')}${section('kind', 'Kind')}${section('format', 'Format')}${section('contains', 'Contains')}${section('label', 'Labels')}`;
}
export function refreshCards() {
  // Re-render in place after tag edits so the grid reflects overrides.
  if (ui.view !== 'library') return;
  const y = window.scrollY;
  renderLibrary();
  window.scrollTo(0, y);
}
export function clearAll() { ui.filters.clear(); ui.query = ''; $('#search').value = ''; ui.status = 'active'; ui.visible = PAGE; }
function focusCard(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect(), top = 120, bottom = window.innerHeight - 24;
  if (r.top < top || r.bottom > bottom) el.scrollIntoView({ block: r.height > bottom - top ? 'start' : 'center', behavior: 'smooth' });
}
// Spatial navigation works for every layout: wall columns, grid, and list.
export function moveCard(dir) {
  const cards = $$('#results [data-open]');
  if (!cards.length) return;
  const cur = document.activeElement?.closest?.('#results [data-open]');
  if (!cur) return focusCard(cards.find(c => c.getBoundingClientRect().bottom > 130) || cards[0]);
  const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const c of cards) {
    if (c === cur) continue;
    const b = c.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let primary, secondary;
    if (dir === 'down') { if (b.top < a.bottom - 4) continue; primary = b.top - a.bottom; secondary = Math.abs(bx - ax); }
    else if (dir === 'up') { if (b.bottom > a.top + 4) continue; primary = a.top - b.bottom; secondary = Math.abs(bx - ax); }
    else if (dir === 'right') { if (b.left < a.right - 4) continue; primary = b.left - a.right; secondary = Math.abs(by - ay); }
    else { if (b.right > a.left + 4) continue; primary = a.left - b.right; secondary = Math.abs(by - ay); }
    const score = primary + secondary * 3;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (best) return focusCard(best);
  if (dir === 'down' && ui.visible < (ui.results?.length || 0)) {
    // Past the last painted card: load the next page, then continue.
    const next = ui.results.slice(ui.visible, ui.visible + PAGE); ui.visible += PAGE; paintResults(next, false);
    requestAnimationFrame(() => moveCard(dir));
  }
}
export function focusCardById(id) {
  if (ui.view !== 'library' || !id) return;
  const idx = ui.results?.findIndex(r => r.id === id) ?? -1;
  if (idx >= ui.visible) { const next = ui.results.slice(ui.visible, idx + PAGE); ui.visible = idx + PAGE; paintResults(next, false); }
  requestAnimationFrame(() => focusCard($(`#results [data-open="${CSS.escape(id)}"]`)));
}
export const setLayout = (layout) => { const focused = document.activeElement?.dataset?.open; savePrefs({ layout }); renderLibrary(); focusCardById(focused); };
export function syncUrl() {
  if (ui.view !== 'library') return;
  const p = new URLSearchParams();
  if (ui.query) p.set('q', ui.query);
  for (const f of ui.filters) p.append('t', f);
  const base = ui.status === 'archived' ? '/archive' : ui.status === 'deleted' ? '/trash' : '/';
  const next = `${base}${p.toString() ? `?${p}` : ''}`;
  if (next !== location.pathname + location.search) history.replaceState({}, '', next);
}
