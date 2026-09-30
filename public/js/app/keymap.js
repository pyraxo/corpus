// The keymap: one list drives shortcuts, the ? sheet, palette hints and Settings → Shortcuts.
import { esc } from '../core/dom.js';
import { prefs } from '../core/prefs.js';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl ';
// [id, group, label, default bindings]. A binding is "Mod+Shift+Z", "#", "Space", or a chord "G L".
export const KEYMAP = [
  ['palette', 'Anywhere', 'Command palette', ['Mod+K']],
  ['undo', 'Anywhere', 'Undo', ['Mod+Z']],
  ['redo', 'Anywhere', 'Redo', ['Mod+Shift+Z', 'Mod+Y']],
  ['search', 'Anywhere', 'Search the library', ['/']],
  ['help', 'Anywhere', 'Keyboard shortcuts', ['?']],
  ['theme', 'Anywhere', 'Toggle dark mode', ['Shift+D']],
  ['add', 'Anywhere', 'Add files or links', ['Shift+A']],
  ['go.library', 'Go to', 'Library', ['G L']],
  ['go.inbox', 'Go to', 'Inbox', ['G I']],
  ['go.ask', 'Go to', 'Ask', ['G A']],
  ['go.taxonomy', 'Go to', 'Taxonomy', ['G T']],
  ['go.settings', 'Go to', 'Settings', ['G S']],
  ['go.archive', 'Go to', 'Archive', ['G E']],
  ['go.trash', 'Go to', 'Trash', ['G D']],
  ['go.highlights', 'Go to', 'Highlights', ['G H']],
  ['lib.wall', 'Library', 'Wall layout', ['1']],
  ['lib.grid', 'Library', 'Grid layout', ['2']],
  ['lib.list', 'Library', 'List layout', ['3']],
  ['lib.clear', 'Library', 'Clear search and filters', ['X']],
  ['reader.next', 'Reader', 'Next bookmark', ['J', 'ArrowRight']],
  ['reader.prev', 'Reader', 'Previous bookmark', ['K', 'ArrowLeft']],
  ['reader.read', 'Reader', 'Read tab', ['R']],
  ['reader.chat', 'Reader', 'Chat tab', ['C']],
  ['reader.tag', 'Reader', 'Add a tag', ['T']],
  ['reader.note', 'Reader', 'Write in the scratchpad', ['N']],
  ['reader.highlight', 'Reader', 'Highlight the selected text', ['H']],
  ['reader.open', 'Reader', 'Open original', ['O']],
  ['reader.keep', 'Reader', 'Keep', ['M']],
  ['reader.archive', 'Reader', 'Archive', ['E']],
  ['reader.delete', 'Reader', 'Move to Trash', ['#']],
  ['reader.stack', 'Reader', 'Add to / take off the stack', ['S']],
  ['reader.done', 'Reader', 'Mark read / unread', ['D']],
  ['reader.contents', 'Reader', 'Contents and notes (books, PDFs)', ['Shift+C']],
  ['reader.nextSection', 'Reader', 'Next chapter or page', [']']],
  ['reader.prevSection', 'Reader', 'Previous chapter or page', ['[']],
  ['read.next', 'Read', 'Next in the list', ['J', 'ArrowDown']],
  ['read.prev', 'Read', 'Previous in the list', ['K', 'ArrowUp']],
  ['read.done', 'Read', 'Done reading / unread', ['D']],
  ['read.stack', 'Read', 'Add to / take off the stack', ['S']],
  ['read.keep', 'Read', 'Keep', ['M']],
  ['read.archive', 'Read', 'Archive', ['E']],
  ['read.delete', 'Read', 'Move to Trash', ['#']],
  ['read.tag', 'Read', 'Add a tag', ['T']],
  ['read.note', 'Read', 'Write in the scratchpad', ['N']],
  ['read.highlight', 'Read', 'Highlight the selected text', ['H']],
  ['read.open', 'Read', 'Open original', ['O']],
  ['read.ask', 'Read', 'Ask AI about this', ['A']],
  ['read.pad', 'Read', 'Inbox scratchpad', ['P']],
  ['read.contents', 'Read', 'Contents and notes (books, PDFs)', ['Shift+C']],
  ['read.nextSection', 'Read', 'Next chapter or page', [']']],
  ['read.prevSection', 'Read', 'Previous chapter or page', ['[']],
  ['read.mode.triage', 'Read', 'Switch to Triage', ['I']],
  ['inbox.keep', 'Inbox', 'Keep', ['Enter']],
  ['inbox.archive', 'Inbox', 'Archive', ['E']],
  ['inbox.delete', 'Inbox', 'Move to Trash', ['#']],
  ['inbox.next', 'Inbox', 'Skip to next', ['S', 'J', 'ArrowDown']],
  ['inbox.prev', 'Inbox', 'Previous', ['K', 'ArrowUp']],
  ['inbox.open', 'Inbox', 'Open in reader', ['O', 'Space']],
  ['inbox.ask', 'Inbox', 'Ask AI about this entry', ['A']],
  ['inbox.pad', 'Inbox', 'Inbox scratchpad', ['P']],
  ['inbox.highlight', 'Inbox', 'Highlight the selected text', ['H']],
  ['read.mode.read', 'Inbox', 'Switch to Read (go through the queue without triaging)', ['R']],
  ['tax.new', 'Taxonomy', 'New concept', ['N']],
  ['ask.new', 'Ask', 'New chat', ['N']]
];
const FIXED_KEYS = [
  ['Library', '← ↑ ↓ →  h j k l', 'Move between cards'], ['Library', '⏎  o', 'Open the focused card'],
  ['Taxonomy', '↑ ↓', 'Move between concepts'], ['Ask', '⇧ ⏎', 'New line in a message'], ['Anywhere', 'esc', 'Close or step back']
];
export const keyDef = new Map(KEYMAP.map(k => [k[0], k]));
export const bindingsOf = (id) => prefs.keys?.[id] || keyDef.get(id)?.[3] || [];
// Normalize a keydown to a binding string. Letters are upper-case; Shift is explicit
// for letters and named keys, and implied by symbols like ? and #.
export function comboOf(ev) {
  const k = ev.key;
  if (!k || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead'].includes(k)) return null;
  const mods = [];
  if (ev.metaKey || ev.ctrlKey) mods.push('Mod');
  if (ev.altKey) mods.push('Alt');
  let key = k === ' ' ? 'Space' : k;
  if (key.length === 1) {
    if (/\p{L}/u.test(key)) { if (ev.shiftKey) mods.push('Shift'); key = key.toUpperCase(); }
    else if (mods.includes('Mod') && ev.shiftKey && /[0-9]/.test(key)) mods.push('Shift');
  } else if (ev.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}
const CAP = { Mod: isMac ? '⌘' : 'Ctrl', Shift: '⇧', Alt: isMac ? '⌥' : 'Alt', Enter: '⏎', Escape: 'esc', ArrowDown: '↓', ArrowUp: '↑', ArrowLeft: '←', ArrowRight: '→', Space: 'space', Backspace: '⌫', Tab: 'tab' };
export const capsOf = (binding) => binding.split(' ').map(step => step.split('+').map(p => `<kbd>${esc(CAP[p] || (p.length === 1 ? (step.includes('Shift') ? p : p.toLowerCase()) : p))}</kbd>`).join('')).join('');
// keyHint(actionId) shows the current bindings; keyHint("a b  c") keeps the old literal form.
// A binding as plain text, for tooltips.
export const capsText = (id) => bindingsOf(id).map(b => b.split(' ').map(step => step.split('+').map(p => CAP[p] || (p.length === 1 ? p.toLowerCase() : p)).join('')).join(' ')).join(' / ');
export const keyHint = (k) => keyDef.has(k)
  ? bindingsOf(k).map(capsOf).join('<span class="key-or">or</span>')
  : k.trim().split(/\s{2,}/).map(g => g.split(' ').filter(Boolean).map(x => `<kbd>${esc(x)}</kbd>`).join('')).join('<span class="key-or">or</span>');
export function showHelp() {
  document.getElementById('help')?.remove();
  const groups = [...new Set([...KEYMAP.map(k => k[1]), ...FIXED_KEYS.map(k => k[0])])];
  document.body.insertAdjacentHTML('beforeend', `<div id="help" class="overlay"><div class="overlay-scrim" data-hclose></div><div class="help-box" role="dialog" aria-label="Keyboard shortcuts"><div class="help-head"><h2 class="serif">Keyboard</h2><a class="ghost small" href="/settings/shortcuts" data-link data-hclose>Customize</a></div><div class="help-grid">${groups.map(g => `<section><h4>${g}</h4>${KEYMAP.filter(k => k[1] === g).map(([id, , l]) => `<div class="help-row"><span>${esc(l)}</span><span class="keys">${keyHint(id)}</span></div>`).join('')}${FIXED_KEYS.filter(k => k[0] === g).map(([, k, l]) => `<div class="help-row"><span>${esc(l)}</span><span class="keys">${keyHint(k)}</span></div>`).join('')}</section>`).join('')}</div></div></div>`);
}
export const hideHelp = () => document.getElementById('help')?.remove();
