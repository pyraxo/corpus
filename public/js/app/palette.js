// The command palette (⌘K): bookmarks, pages, filters and actions.
import { hideHelp, keyHint, showHelp } from './keymap.js';
import { installApp, isStandalone } from './pwa.js';
import { navigate, render } from './router.js';
import { toggleTheme } from './theme.js';
import { $, $$, copyText, esc } from '../core/dom.js';
import { prefs, savePrefs } from '../core/prefs.js';
import { PAGE, store, ui } from '../core/state.js';
import { redo, redoStack, undo, undoStack } from '../data/history.js';
import { api, formatOf, isRead, label, loadAll, who } from '../data/library.js';
import { FORMAT_TABS, SORTS, matchesQuery, query, reshuffleRandomSort, sortRecords } from '../data/query.js';
import { sendChat, session } from '../features/chat.js';
import { toggleRead, toggleStack } from '../features/marks.js';
import { openAddDialog } from '../views/add-dialog.js';
import { avatarOf, snippet } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { closeReader, focusTagInput, libraryLabel, openBookmark, restoreReader, showReaderTab, triageReader } from '../views/dialog.js';
import { clearAll, renderLibrary, syncUrl } from '../views/library.js';

export const palette = { open: false, items: [], active: 0 };
const recent = () => (prefs.recent || []).map(id => store.byId.get(id)).filter(Boolean);
export function rememberOpened(id) { savePrefs({ recent: [id, ...(prefs.recent || []).filter(x => x !== id)].slice(0, 8) }); }
const fuzzy = (text, q) => {
  // every query token must appear; prefix matches rank higher
  const t = text.toLowerCase(); let score = 0;
  for (const tok of q) { const i = t.indexOf(tok); if (i < 0) return -1; score += i === 0 || /\W/.test(t[i - 1]) ? 2 : 1; }
  return score;
};
function commands() {
  const r = ui.readerId && store.byId.get(ui.readerId);
  const go = (label, path, id) => ({ group: 'Go to', label, hint: id, run: () => { closeReader(); navigate(path); } });
  const lib = (fn) => () => { closeReader(); if (ui.view !== 'library') navigate('/'); fn(); renderLibrary(); syncUrl(); };
  const list = [
    ...(r ? [
      { group: 'This bookmark', label: 'Chat about this bookmark', hint: 'reader.chat', run: () => showReaderTab('chat') },
      { group: 'This bookmark', label: 'Open original', hint: 'reader.open', run: () => window.open(r.url, '_blank', 'noopener') },
      { group: 'This bookmark', label: 'Add a tag', hint: 'reader.tag', run: () => focusTagInput() },
      { group: 'This bookmark', label: 'Keep', hint: 'reader.keep', run: () => triageReader('kept') },
      { group: 'This bookmark', label: 'Archive', hint: 'reader.archive', run: () => triageReader('archived') },
      { group: 'This bookmark', label: store.overrides[r.id]?.stackedAt ? 'Take off the stack' : 'Add to stack', hint: 'reader.stack', run: () => toggleStack(r.id) },
      ...(store.overrides[r.id]?.deleted ? [] : [{ group: 'This bookmark', label: isRead(r) ? 'Mark unread' : 'Mark as read', hint: 'reader.done', run: () => toggleRead(r.id) }]),
      store.overrides[r.id]?.deleted ? { group: 'This bookmark', label: 'Restore from Trash', run: restoreReader } : { group: 'This bookmark', label: 'Move to Trash', hint: 'reader.delete', run: () => triageReader('deleted') },
      ...(r.provider !== 'file' ? [{ group: 'This bookmark', label: r.provider === 'web' ? 'Copy link to the page' : 'Copy link to the post on X', run: () => copyText(r.url) }] : []),
      { group: 'This bookmark', label: 'Copy Corpus link', run: () => copyText(`${location.origin}/b/${r.id}`) }
    ] : []),
    go('Library', '/', 'go.library'), go('Inbox', '/inbox', 'go.inbox'), go('Highlights', '/highlights', 'go.highlights'), go('Ask', '/ask', 'go.ask'), go('Taxonomy', '/taxonomy', 'go.taxonomy'), go('Settings', '/settings', 'go.settings'), go('Archive', '/archive', 'go.archive'), go('Trash', '/trash', 'go.trash'),
    { group: 'Actions', label: undoStack.length ? `Undo: ${undoStack.at(-1).label}` : 'Undo', hint: 'undo', run: undo },
    { group: 'Actions', label: redoStack.length ? `Redo: ${redoStack.at(-1).label}` : 'Redo', hint: 'redo', run: redo },
    { group: 'Actions', label: 'Add files or links: images, PDFs, books, text, web pages', hint: 'add', run: () => openAddDialog() },
    { group: 'Actions', label: 'Open in Reader: the library as it’s filtered now', run: () => { closeReader(); const list = sortRecords(query(), prefs.sort); if (list[0]) { const was = prefs.openIn; prefs.openIn = 'reader'; openBookmark(list[0].id, list, libraryLabel()); prefs.openIn = was; } } },
    { group: 'Actions', label: 'Triage the inbox', run: () => { closeReader(); navigate('/inbox'); } },
    { group: 'Actions', label: 'Open the inbox scratchpad', hint: 'inbox.pad', run: () => { closeReader(); ui.inboxPad = true; navigate('/inbox'); } },
    { group: 'Actions', label: 'New chat', run: () => { const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } closeReader(); navigate('/ask'); } },
    { group: 'Actions', label: 'Wall layout', hint: 'lib.wall', run: lib(() => savePrefs({ layout: 'wall' })) },
    { group: 'Actions', label: 'Grid layout', hint: 'lib.grid', run: lib(() => savePrefs({ layout: 'grid' })) },
    { group: 'Actions', label: 'List layout', hint: 'lib.list', run: lib(() => savePrefs({ layout: 'list' })) },
    { group: 'Actions', label: 'Clear search and filters', hint: 'lib.clear', run: lib(clearAll) },
    { group: 'Actions', label: 'Show untriaged', run: lib(() => { ui.status = 'inbox'; }) },
    ...[['newest', 'bookmarked', 'Sort: recently saved'], ['saves', 'saves', 'Sort: most saved'], ['longest', 'longest', 'Sort: longest reads']].map(([, v, l]) => ({ group: 'Actions', label: l, run: lib(() => savePrefs({ sort: v })) })),
    ...SORTS.map(([v, l]) => ({ group: 'Inbox', label: `Triage by: ${l}`, run: () => { closeReader(); if (v === 'random') reshuffleRandomSort(); savePrefs({ inboxSort: v }); ui.inboxId = null; navigate('/inbox'); } })),
    ...FORMAT_TABS.map(([v, l]) => ({ group: 'Inbox', label: v === 'all' ? 'Triage: all types' : `Triage only: ${l}`, run: () => { closeReader(); savePrefs({ inboxFormat: v }); ui.inboxId = null; navigate('/inbox'); } })),
    { group: 'Actions', label: `Toggle dark mode`, hint: 'theme', run: toggleTheme },
    { group: 'Actions', label: 'Rebuild index from FieldTheory', run: async () => { toast('Rebuilding…'); await api('/api/refresh', { method: 'POST' }).catch(e => toast(e.message)); await loadAll(); render(); toast('Rebuilt'); } },
    { group: 'Actions', label: 'Keyboard shortcuts', hint: 'help', run: showHelp },
    ...(isStandalone() ? [] : [{ group: 'Actions', label: 'Install Corpus as an app', run: installApp }]),
    { group: 'Actions', label: 'Sign out', run: async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; } }
  ];
  return list;
}
function paletteItems(qRaw) {
  const q = qRaw.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const out = [];
  const cmds = commands();
  if (!q.length) {
    out.push(...recent().slice(0, 5).map(r => bookmarkItem(r, 'Recent')));
    out.push(...cmds.filter(c => c.group === 'This bookmark' || c.group === 'Go to'));
    out.push(...cmds.filter(c => c.group === 'Actions').slice(0, 5));
    return out;
  }
  const scored = (arr, text) => arr.map(x => [x, fuzzy(text(x), q)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([x]) => x);
  out.push(...scored(cmds, c => `${c.group} ${c.label}`).slice(0, 6));
  // Bookmarks: title/author first, then full text.
  const hits = [];
  for (const r of store.records) {
    const head = `${r.title} ${r.author.name} @${r.author.handle}`;
    const s = fuzzy(head, q);
    if (s >= 0) hits.push([r, 10 + s]);
    else if (hits.length < 400 && matchesQuery(r, qRaw)) hits.push([r, 0]);
  }
  hits.sort((a, b) => b[1] - a[1] || b[0].order - a[0].order);
  out.push(...hits.slice(0, 8).map(([r]) => bookmarkItem(r, 'Bookmarks')));
  const concepts = scored(store.concepts.filter(c => ['topic', 'kind', 'format', 'label'].includes(c.facet)), c => `${c.label} ${c.parent ? label(c.parent) : ''}`).slice(0, 5);
  out.push(...concepts.map(c => ({ group: 'Filter by', label: c.parent ? `${label(c.parent)} / ${c.label}` : c.label, hint: c.facet, run: () => { closeReader(); ui.filters = new Set([c.id]); ui.query = ''; $('#search').value = ''; ui.visible = PAGE; navigate(`/?t=${encodeURIComponent(c.id)}`); } })));
  out.push({ group: 'Ask', label: `Ask Corpus: “${qRaw.trim()}”`, hint: 'enter', run: async () => { closeReader(); const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } navigate('/ask'); await sendChat(s, qRaw); } });
  out.push({ group: 'Ask', label: `Search the library for “${qRaw.trim()}”`, run: () => { closeReader(); ui.query = qRaw.trim(); $('#search').value = ui.query; ui.visible = PAGE; navigate(`/?q=${encodeURIComponent(ui.query)}`); } });
  return out;
}
function bookmarkItem(r, group) {
  return { group, label: (r.title || snippet(r, 80)).slice(0, 90) || who(r), meta: `${who(r)} · ${label(formatOf(r))}`, avatarHtml: avatarOf(r), run: () => { closeReader(); openBookmark(r.id, ui.view === 'library' && ui.results?.length ? ui.results : undefined); } };
}
export function openPalette() {
  let el = $('#palette');
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', `<div id="palette" class="overlay palette" hidden><div class="overlay-scrim" data-pclose></div><div class="palette-box" role="dialog" aria-label="Command palette"><div class="palette-input"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg><input id="palette-input" placeholder="Search bookmarks, jump to a page, run an action…" autocomplete="off" spellcheck="false" role="combobox" aria-controls="palette-list"><kbd>esc</kbd></div><div id="palette-list" class="palette-list" role="listbox"></div><div class="palette-foot"><span>${keyHint('↑ ↓')} navigate</span><span>${keyHint('enter')} open</span><span>${keyHint('?')} all shortcuts</span></div></div></div>`);
    el = $('#palette');
  }
  palette.open = true;
  el.hidden = false;
  const input = $('#palette-input');
  input.value = '';
  paintPalette('');
  input.focus();
}
export function closePalette() { palette.open = false; const el = $('#palette'); if (el) el.hidden = true; }
function paintPalette(q) {
  palette.items = paletteItems(q);
  palette.active = 0;
  let group = null;
  $('#palette-list').innerHTML = palette.items.map((it, i) => {
    const head = it.group !== group ? `<div class="p-group">${esc(it.group)}</div>` : '';
    group = it.group;
    return `${head}<button class="p-item ${i === 0 ? 'on' : ''}" data-pi="${i}" role="option">${it.avatarHtml || ''}<span class="p-label">${esc(it.label)}</span>${it.meta ? `<span class="p-meta">${esc(it.meta)}</span>` : ''}${it.hint ? `<span class="p-hint">${keyHint(it.hint)}</span>` : ''}</button>`;
  }).join('') || '<p class="p-empty">No matches</p>';
}
export function movePalette(d) {
  const n = palette.items.length;
  if (!n) return;
  palette.active = (palette.active + d + n) % n;
  $$('.p-item').forEach((b, i) => b.classList.toggle('on', i === palette.active));
  $(`.p-item[data-pi="${palette.active}"]`)?.scrollIntoView({ block: 'nearest' });
}
export async function runPalette(i = palette.active) { const it = palette.items[i]; if (!it) return; closePalette(); await it.run(); }

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupPalette() {
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-pclose]')) closePalette();
    if (ev.target.closest('[data-hclose]')) hideHelp();
    const pi = ev.target.closest('[data-pi]'); if (pi) runPalette(Number(pi.dataset.pi));
    if (ev.target.closest('[data-palette]')) openPalette();
  });
  document.addEventListener('input', (ev) => { if (ev.target.id === 'palette-input') paintPalette(ev.target.value); });
  document.addEventListener('mousemove', (ev) => { const pi = ev.target.closest?.('[data-pi]'); if (pi && Number(pi.dataset.pi) !== palette.active) { palette.active = Number(pi.dataset.pi); $$('.p-item').forEach((b, i) => b.classList.toggle('on', i === palette.active)); } });
}
