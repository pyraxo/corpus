// Corpus in the browser: library, reader and inbox, highlights, Ask, taxonomy and settings,
// over the built bookmark index. This file only starts things; everything else is in its module.
import './ui/dropdown.js';
import { setupEvents } from './app/events.js';
import { isMac } from './app/keymap.js';
import { setupPalette } from './app/palette.js';
import { setupPwa } from './app/pwa.js';
import { poll, route, setupRouter, updateInboxCount } from './app/router.js';
import { setupShortcuts } from './app/shortcuts.js';
import { $, esc } from './core/dom.js';
import { applyPrefs } from './core/prefs.js';
import { ui, view } from './core/state.js';
import { loadAll, loadStatus } from './data/library.js';
import { setupHighlights } from './features/highlights.js';
import { setupMediaArchive } from './features/media-archive.js';
import { loadPad, pad, setupScratchpad } from './features/scratchpad.js';
import { setupSidebar } from './features/sidebar.js';
import { setupUploads } from './features/uploads.js';
import { inQueue } from './views/dialog.js';

// Every listener, in the order they've always been added (several share an event).
setupHighlights();
setupScratchpad();
setupSidebar();
setupMediaArchive();
setupUploads();
setupEvents();
setupShortcuts();
setupPalette();
setupRouter();
setupPwa();

(async function init() {
  applyPrefs();
  $('.mod-k').textContent = isMac ? '⌘K' : 'Ctrl K';
  const params = new URLSearchParams(location.search);
  ui.query = params.get('q') || '';
  ui.filters = new Set(params.getAll('t'));
  $('#search').value = ui.query;
  view().innerHTML = '<div class="loading"><span class="mono muted">Loading</span></div>';
  try { await Promise.all([loadAll(), loadStatus()]); }
  catch (e) { view().innerHTML = `<div class="empty"><p class="serif">Couldn’t load the index.</p><p class="muted">${esc(e.message)}</p></div>`; return; }
  updateInboxCount();
  route();
  setInterval(poll, 60_000);
  // Agents write to the inbox scratchpad too; pick up their changes while it's open.
  setInterval(() => { if (inQueue() && ui.inboxPad && !document.hidden && !pad.saving && pad.draft == null) loadPad(); }, 15_000);
})();
