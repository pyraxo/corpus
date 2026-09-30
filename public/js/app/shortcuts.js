// Keyboard shortcuts: what each action does, and the dispatcher that runs them.
import { KEYMAP, bindingsOf, comboOf, hideHelp, keyDef, showHelp } from './keymap.js';
import { closePalette, movePalette, openPalette, palette, runPalette } from './palette.js';
import { navigate } from './router.js';
import { toggleTheme } from './theme.js';
import { $, $$ } from '../core/dom.js';
import { prefs, savePrefs } from '../core/prefs.js';
import { store, ui } from '../core/state.js';
import { redo, undo } from '../data/history.js';
import { stackList } from '../data/library.js';
import { messageAction, sessions, toggleInboxChat } from '../features/chat.js';
import { hidePop, highlightSelection } from '../features/highlights.js';
import { toggleRead, toggleStack } from '../features/marks.js';
import { toggleInboxPad } from '../features/scratchpad.js';
import { pickSuggestion } from '../features/tags.js';
import { toast } from '../ui/toast.js';
import { closeReader, focusTagInput, inQueue, openBookmark, openReader, showReaderTab, stepReader, triageReader } from '../views/dialog.js';
import { openHighlight } from '../views/highlights.js';
import { clearAll, moveCard, renderLibrary, setLayout, setRail, syncUrl } from '../views/library.js';
import { currentDoc } from '../views/post.js';
import { inboxStep, readDelete, readTriage, setMode, triageCurrent } from '../views/reader/index.js';
import { renderSettings } from '../views/settings.js';
import { moveTaxonomy, renderTaxonomy } from '../views/taxonomy.js';
import { openAddDialog } from '../views/add-dialog.js';
import { bodyFor, startEdit } from '../features/edit.js';

const ARROWS = { ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right', J: 'down', K: 'up', H: 'left', L: 'right' };
const GO = { 'go.library': '/', 'go.inbox': '/inbox', 'go.highlights': '/highlights', 'go.ask': '/ask', 'go.taxonomy': '/taxonomy', 'go.settings': '/settings', 'go.archive': '/archive', 'go.trash': '/trash' };
const ACTIONS = {
  palette: () => (palette.open ? closePalette() : openPalette()),
  undo, redo,
  search: () => { if (ui.view !== 'library') navigate('/'); $('#search').focus(); $('#search').select(); },
  help: showHelp,
  theme: toggleTheme,
  add: () => openAddDialog(),
  // Edit the entry in front of you: in the dialog, else in the reader view.
  'reader.edit': () => startEdit(bodyFor(ui.readerId), store.byId.get(ui.readerId)),
  'read.edit': () => startEdit(bodyFor(ui.inboxId), store.byId.get(ui.inboxId)),
  'inbox.edit': () => startEdit(bodyFor(ui.inboxId), store.byId.get(ui.inboxId)),
  ...Object.fromEntries(Object.entries(GO).map(([id, path]) => [id, () => { closeReader(); navigate(path); }])),
  'lib.wall': () => setLayout('wall'), 'lib.grid': () => setLayout('grid'), 'lib.list': () => setLayout('list'),
  'lib.clear': () => { clearAll(); syncUrl(); renderLibrary(); },
  'reader.next': () => stepReader(1), 'reader.prev': () => stepReader(-1),
  'reader.read': () => showReaderTab('read'), 'reader.chat': () => showReaderTab('chat'),
  'reader.tag': focusTagInput,
  'reader.note': () => { showReaderTab('read'); const n = $('#reader [data-scratchpad]'); n?.scrollIntoView({ block: 'center' }); n?.focus(); },
  'reader.open': () => { const r = store.byId.get(ui.readerId); if (r) window.open(r.url, '_blank', 'noopener'); },
  'reader.keep': () => triageReader('kept'), 'reader.archive': () => triageReader('archived'), 'reader.delete': () => triageReader('deleted'),
  'reader.stack': () => ui.readerId && toggleStack(ui.readerId), 'reader.done': () => ui.readerId && toggleRead(ui.readerId),
  'inbox.keep': () => triageCurrent('kept'), 'inbox.archive': () => triageCurrent('archived'), 'inbox.delete': () => triageCurrent('deleted'),
  'inbox.next': () => inboxStep(1), 'inbox.prev': () => inboxStep(-1),
  'inbox.open': () => ui.inboxId && openReader(ui.inboxId, ui.inboxQueue),
  'inbox.ask': () => ui.inboxId && toggleInboxChat(),
  'inbox.pad': () => toggleInboxPad(),
  'reader.highlight': () => highlightSelection(), 'inbox.highlight': () => highlightSelection(),
  'reader.contents': () => currentDoc()?.toggleContents(), 'reader.nextSection': () => currentDoc()?.step(1), 'reader.prevSection': () => currentDoc()?.step(-1),
  'read.contents': () => currentDoc()?.toggleContents(), 'read.nextSection': () => currentDoc()?.step(1), 'read.prevSection': () => currentDoc()?.step(-1),
  'read.next': () => inboxStep(1), 'read.prev': () => inboxStep(-1),
  'read.done': () => ui.inboxId && toggleRead(ui.inboxId), 'read.stack': () => ui.inboxId && toggleStack(ui.inboxId),
  'read.keep': () => readTriage('kept'), 'read.archive': () => readTriage('archived'), 'read.delete': readDelete,
  'read.tag': () => { const i = $('.triage-dock [data-tag-input]'); i?.focus(); },
  'read.note': () => { const n = $('.triage-dock [data-scratchpad]'); n?.focus(); },
  'read.highlight': () => highlightSelection(),
  'read.open': () => { const r = store.byId.get(ui.inboxId); if (r) window.open(r.url, '_blank', 'noopener'); },
  'read.ask': () => ui.inboxId && toggleInboxChat(), 'read.pad': () => toggleInboxPad(),
  'read.mode.triage': () => setMode('triage'), 'read.mode.read': () => setMode('read'),
  'tax.new': () => { ui.taxSelected = '__new'; renderTaxonomy(); $('.t-form input[name=label]')?.focus(); },
  'ask.new': () => $('[data-new-chat]')?.click()
};
export let pendingChord = null, pendingAt = 0, recordingKey = null;
// Settings → Shortcuts: record a new binding (one combo, or a two-key chord like "g l").
export function startRecording(id) {
  recordingKey = { id, first: null, timer: null };
  renderSettings();
}
export let resizeTimer;

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupShortcuts() {
  document.addEventListener('keydown', async (ev) => {
    if (recordingKey) return; // Settings is capturing a new binding
    const t = ev.target;
    const combo = comboOf(ev);
    if (!combo) return;
    // The palette opens from anywhere, even while typing.
    if (bindingsOf('palette').includes(combo)) { ev.preventDefault(); ACTIONS.palette(); return; }
    if (palette.open) {
      if (ev.key === 'ArrowDown' || (ev.ctrlKey && ev.key === 'n')) { ev.preventDefault(); movePalette(1); }
      else if (ev.key === 'ArrowUp' || (ev.ctrlKey && ev.key === 'p')) { ev.preventDefault(); movePalette(-1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); await runPalette(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closePalette(); }
      return;
    }
    if ($('#help')) { if (ev.key === 'Escape' || bindingsOf('help').includes(combo)) { ev.preventDefault(); hideHelp(); } return; }
  
    if (t.matches('.composer textarea, .msg-edit textarea') && ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); t.form.requestSubmit(); return; }
    if (t.matches('.msg-edit textarea') && ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); messageAction(sessions.get(t.closest('[data-chat]').dataset.chat), 'cancel-edit'); return; }
    if (t.matches('[data-tag-input]')) {
      const list = $('.suggest', t.closest('.tag-add'));
      const btns = $$('button', list); const i = btns.findIndex(b => b.classList.contains('hi'));
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); btns[i]?.classList.remove('hi'); btns[(i + (ev.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.classList.add('hi'); }
      // Enter picks the highlighted suggestion; so does Tab, as in most autocompletes.
      if ((ev.key === 'Enter' || (ev.key === 'Tab' && !ev.shiftKey)) && btns[i] && !list.hidden) { ev.preventDefault(); await pickSuggestion(btns[i]); }
      else if (ev.key === 'Enter') ev.preventDefault();
      if (ev.key === 'Escape') { list.hidden = true; t.blur(); ev.stopPropagation(); }
      return;
    }
    const readerOpen = !$('#reader').hidden;
    // A focused button or link takes Enter and Space itself (e.g. a tag suggestion), not the Inbox's Keep.
    if ((combo === 'Enter' || combo === 'Space') && t.matches('button, a[href], [role="button"]')) return;
    // Text fields keep their own keys (including the browser's text undo).
    if (t.matches('input, textarea, select, [contenteditable]')) {
      if (ev.key === 'Escape') { t.blur(); if (t.id === 'search' && ui.view === 'library') moveCard('down'); }
      if (t.id === 'search' && (ev.key === 'ArrowDown' || ev.key === 'Enter')) { ev.preventDefault(); t.blur(); moveCard('down'); }
      return;
    }
    if (ev.key === 'Escape' && currentDoc() && !currentDoc().el.querySelector('.doc-panel').hidden) { currentDoc().toggleContents(false); return; }
    if (ev.key === 'Escape' && readerOpen) { closeReader(); return; }
    if (ev.key === 'Escape' && ui.mobileRail) { setRail(false); return; }
    if (ev.key === 'Escape' && inQueue() && ui.inboxChat) { toggleInboxChat(false); return; }
    if (ev.key === 'Escape' && inQueue() && ui.inboxPad) { toggleInboxPad(false); return; }
    if (ev.key === 'Escape' && !$('#hl-pop')?.hidden) { hidePop(); return; }
    if (ev.key === 'Escape' && ui.view === 'read') { navigate(ui.readBack && !ui.readBack.startsWith('/read') ? ui.readBack : '/'); return; }
  
    const ctx = readerOpen ? 'Reader' : { library: 'Library', inbox: 'Inbox', read: 'Read', highlights: 'Highlights', taxonomy: 'Taxonomy', ask: 'Ask', settings: 'Settings' }[ui.view];
    const active = KEYMAP.filter(([, g]) => g === 'Anywhere' || g === 'Go to' || g === ctx);
    let seq = combo;
    if (pendingChord && Date.now() - pendingAt < 1200) seq = `${pendingChord} ${combo}`;
    pendingChord = null;
    const hit = active.find(([id]) => bindingsOf(id).includes(seq));
    if (hit) { ev.preventDefault(); await ACTIONS[hit[0]]?.(); return; }
    if (seq === combo && active.some(([id]) => bindingsOf(id).some(b => b.startsWith(`${combo} `)))) { pendingChord = combo; pendingAt = Date.now(); ev.preventDefault(); return; }
  
    // Fixed navigation keys.
    if (ctx === 'Library') {
      if (ARROWS[combo]) { ev.preventDefault(); moveCard(ARROWS[combo]); return; }
      if ((combo === 'Enter' || combo === 'O') && t.dataset?.open) { ev.preventDefault(); if (t.closest('.stack')) openBookmark(t.dataset.open, stackList(), 'The stack'); else openBookmark(t.dataset.open, ui.results); return; }
    }
    if (ctx === 'Highlights' && (combo === 'Enter' || combo === 'O') && t.dataset?.hlOpen) { ev.preventDefault(); openHighlight(t.dataset.hlOpen, t.dataset.hlId); return; }
    if (ctx === 'Taxonomy') {
      if (combo === 'ArrowDown' || combo === 'J') { ev.preventDefault(); moveTaxonomy(1); }
      else if (combo === 'ArrowUp' || combo === 'K') { ev.preventDefault(); moveTaxonomy(-1); }
      else if (combo === 'Enter' && ui.taxSelected) { ev.preventDefault(); $('.t-form input[name=label]')?.focus(); }
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (!recordingKey) return;
    ev.preventDefault(); ev.stopPropagation();
    if (ev.key === 'Escape') { clearTimeout(recordingKey.timer); recordingKey = null; renderSettings(); return; }
    const combo = comboOf(ev);
    if (!combo) return;
    const finish = (binding) => {
      const { id } = recordingKey; recordingKey = null;
      const group = keyDef.get(id)[1];
      const clash = KEYMAP.find(([other, g]) => other !== id && bindingsOf(other).includes(binding) && (g === group || ['Anywhere', 'Go to'].includes(g) || ['Anywhere', 'Go to'].includes(group)));
      savePrefs({ keys: { ...(prefs.keys || {}), [id]: [binding] } });
      renderSettings();
      toast(clash ? `Saved — also used by “${clash[2]}”` : 'Shortcut saved');
    };
    if (recordingKey.first) { clearTimeout(recordingKey.timer); finish(`${recordingKey.first} ${combo}`); return; }
    // A bare letter might start a chord; wait briefly for a second key.
    if (/^[A-Z]$/.test(combo)) { recordingKey.first = combo; renderSettings(); recordingKey.timer = setTimeout(() => finish(combo), 800); return; }
    finish(combo);
  }, true);
}
