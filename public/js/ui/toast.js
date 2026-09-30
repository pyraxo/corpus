// The toast at the bottom of the screen, with Undo or another action.
import { keyHint } from '../app/keymap.js';
import { $, esc } from '../core/dom.js';

export function toast(msg, { undo: withUndo = false, action = null, sticky = false } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${withUndo ? `<button data-undo>Undo ${keyHint('undo')}</button>` : ''}${action ? `<button data-toast-act>${esc(action.label)}</button>` : ''}`;
  t._act = action?.run || null;
  t.hidden = false; clearTimeout(t._h);
  if (!sticky) t._h = setTimeout(() => { t.hidden = true; }, withUndo || action ? 6000 : 2600);
}
