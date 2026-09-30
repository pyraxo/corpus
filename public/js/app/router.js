// Routes (the address picks the view), rendering the current view, and picking up rebuilds.
import { resizeTimer } from './shortcuts.js';
import { $, $$, fmt } from '../core/dom.js';
import { applyPrefs, prefs } from '../core/prefs.js';
import { store, ui } from '../core/state.js';
import { api, loadAll } from '../data/library.js';
import { query, sortRecords } from '../data/query.js';
import { renderAsk } from '../views/ask.js';
import { closeReader, inQueue, libraryLabel, openReader } from '../views/dialog.js';
import { renderHighlights } from '../views/highlights.js';
import { paintResults, renderLibrary, setRail } from '../views/library.js';
import { renderInbox } from '../views/reader/index.js';
import { inboxBase } from '../views/reader/queue.js';
import { renderSettings } from '../views/settings.js';
import { renderTaxonomy } from '../views/taxonomy.js';

export function route() {
  const p = location.pathname;
  const m = p.match(/^\/b\/([\w-]+)/);
  if (m) { if (!$('main').dataset.ready) { ui.view = 'library'; render(); } openReader(m[1]); return; }
  closeReader({ fromPop: true });
  if (p === '/archive' || p === '/trash') ui.status = p === '/archive' ? 'archived' : 'deleted';
  else if (p === '/' && (ui.status === 'archived' || ui.status === 'deleted')) ui.status = 'active';
  const rd = p.match(/^\/read(?:\/([\w-]+))?/);
  if (rd) {
    // A reading list you came to directly (a link, a reload): the library as it's filtered now.
    const id = rd[1] && store.byId.has(rd[1]) ? rd[1] : null;
    if (!ui.readList.length || (id && !ui.readList.includes(id))) { const lib = sortRecords(query(), prefs.sort).map(r => r.id); ui.readList = id && !lib.includes(id) ? [id, ...lib] : lib; ui.readFrom = libraryLabel(); }
    if (id) ui.inboxId = id; else if (!ui.readList.includes(ui.inboxId)) ui.inboxId = ui.readList[0] || null;
  }
  ui.view = rd ? 'read' : p.startsWith('/ask') ? 'ask' : p.startsWith('/inbox') ? 'inbox' : p.startsWith('/highlights') ? 'highlights' : p.startsWith('/taxonomy') ? 'taxonomy' : p.startsWith('/settings') ? 'settings' : 'library';
  render();
}
export function render() {
  $('main').dataset.ready = '1';
  $$('[data-nav]').forEach(a => a.setAttribute('aria-current', a.dataset.nav === (ui.view === 'read' ? 'library' : ui.view) ? 'page' : 'false'));
  $('#search-wrap').hidden = ui.view !== 'library';
  if (ui.view === 'library') renderLibrary();
  else if (inQueue()) renderInbox();
  else if (ui.view === 'taxonomy') renderTaxonomy();
  else if (ui.view === 'highlights') renderHighlights();
  else if (ui.view === 'ask') renderAsk();
  else renderSettings();
}
export function navigate(path) { if (ui.mobileRail) setRail(false); history.pushState({}, '', path); window.scrollTo(0, 0); route(); }
export function updateInboxCount() { const n = inboxBase().length; $('#inbox-count').textContent = n ? fmt.format(n) : ''; }
// Pick up rebuilds from the background worker without a manual refresh.
export async function poll() {
  const s = await api('/api/status').catch(() => null);
  if (!s) return;
  store.status = s;
  if (s.build?.at && store.generatedAt && s.build.at > store.generatedAt && $('#reader').hidden && ui.view !== 'taxonomy') {
    const y = window.scrollY;
    await loadAll(); updateInboxCount();
    if (ui.view === 'library' && window.scrollY < 400) { renderLibrary(); window.scrollTo(0, y); }
    else if (ui.view === 'settings') renderSettings();
  }
}

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupRouter() {
  window.addEventListener('popstate', route);
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (ui.view === 'library' && prefs.layout === 'wall') { const box = $('#results'); const cols = Math.max(1, Math.min(5, Math.floor(((box?.clientWidth || 0) + 20) / 300))); if (box?._cols?.length !== cols) paintResults([], true); } }, 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);
}
