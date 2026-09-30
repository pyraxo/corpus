// The inbox scratchpad: one running document shared with Ask and agents; saves as you type.
import { navigate } from '../app/router.js';
import { $, esc } from '../core/dom.js';
import { prefs, savePrefs } from '../core/prefs.js';
import { ui } from '../core/state.js';
import { api, readWhen } from '../data/library.js';
import { md } from './chat.js';
import { GRIP } from './sidebar.js';
import { toast } from '../ui/toast.js';
import { closeReader, inQueue } from '../views/dialog.js';
import { renderInbox } from '../views/reader/index.js';

// One running document for the whole inbox, shared with Ask and MCP agents.
// Edits save as you type; an agent's addition made meanwhile is kept (the server merges it).
export const pad = { text: '', updatedAt: null, updatedBy: null, draft: null, loaded: false, saving: false, fetchedAt: 0, timer: 0 };
const padWho = (by) => by === 'you' ? 'you' : by === 'assistant' ? 'Ask' : by ? 'an agent' : '';
function padMeta() {
  if (!pad.loaded) return 'Loading…';
  if (pad.saving) return 'Saving…';
  if (pad.draft != null && pad.draft !== pad.text) return 'Editing…';
  return pad.updatedAt ? `Saved ${readWhen(pad.updatedAt)} by ${padWho(pad.updatedBy)}` : 'Shared with Ask and agents connected over MCP. Markdown; cite bookmarks as [[id]].';
}
// canAsk: there's an entry on screen, so Ask AI can open alongside.
export function inboxPadHtml({ canAsk = false } = {}) {
  const preview = prefs.padMode === 'preview';
  const text = pad.draft ?? pad.text;
  return `<section class="side-panel inbox-pad" data-panel="pad" aria-label="Inbox scratchpad">
    <div class="tc-head">${GRIP}<span class="kicker">Inbox scratchpad</span>${canAsk && !ui.inboxChat ? '<button class="ghost small side-add" data-inbox-ask title="Ask AI about this entry">+ Ask AI</button>' : ''}<div class="segmented pad-mode" role="group" aria-label="Mode"><button data-pad-mode="edit" aria-pressed="${!preview}">Edit</button><button data-pad-mode="preview" aria-pressed="${preview}">Preview</button></div><button class="x" data-inbox-pad-close aria-label="Close" title="Close (esc)">×</button></div>
    <p class="pad-meta muted small" id="pad-meta">${esc(padMeta())}</p>
    ${preview ? `<div class="pad-preview msg-body" id="pad-preview">${padPreview(text)}</div>` : `<textarea class="pad-text" id="pad-text" placeholder="Plans, questions, lists, what to read next. Anything you or an agent writes here stays with the inbox.">${esc(text)}</textarea>`}
  </section>`;
}
const padPreview = (text) => text.trim() ? md(text, []) : '<p class="muted">Nothing here yet.</p>';
function setPadText(text) {
  const ta = $('#pad-text');
  if (ta && ta.value !== text) { const { selectionStart: a, selectionEnd: b } = ta; ta.value = text; if (document.activeElement === ta) ta.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length)); }
  const pv = $('#pad-preview'); if (pv) pv.innerHTML = padPreview(text);
}
function paintPadMeta() { const m = $('#pad-meta'); if (m) m.textContent = padMeta(); }
export async function loadPad() {
  pad.fetchedAt = Date.now();
  const p = await api('/api/scratchpad').catch(() => null);
  if (!p) return;
  Object.assign(pad, { text: p.text, updatedAt: p.updatedAt, updatedBy: p.updatedBy, loaded: true });
  if (pad.draft === p.text) pad.draft = null;
  if (pad.draft == null) setPadText(pad.text);
  paintPadMeta();
}
async function savePad() {
  clearTimeout(pad.timer);
  if (pad.draft == null || pad.saving) return;
  if (pad.draft === pad.text) { pad.draft = null; paintPadMeta(); return; }
  const text = pad.draft;
  pad.saving = true; paintPadMeta();
  try {
    const p = await api('/api/scratchpad', { method: 'PUT', body: { text, base: pad.updatedAt } });
    Object.assign(pad, { text: p.text, updatedAt: p.updatedAt, updatedBy: p.updatedBy });
    if (pad.draft === text) pad.draft = null;
    if (p.merged) {
      // Someone appended while you were editing: their part now follows yours.
      const extra = p.text.slice(text.replace(/\s+$/, '').length);
      if (pad.draft != null) pad.draft = pad.draft.replace(/\s+$/, '') + extra;
      setPadText(pad.draft ?? pad.text);
      toast('Kept what an agent added meanwhile, at the end');
    }
  } catch (e) { toast(`Scratchpad not saved: ${e.message}`); }
  pad.saving = false; paintPadMeta();
  if (pad.draft != null && pad.draft !== pad.text) pad.timer = setTimeout(savePad, 800);
}
export function toggleInboxPad(open = !ui.inboxPad) {
  ui.inboxPad = open;
  if (!inQueue()) { closeReader(); navigate('/inbox'); } else renderInbox();
  if (open) requestAnimationFrame(() => $('#pad-text')?.focus());
}

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupScratchpad() {
  document.addEventListener('input', (ev) => {
    if (ev.target.id !== 'pad-text') return;
    pad.draft = ev.target.value; paintPadMeta();
    clearTimeout(pad.timer); pad.timer = setTimeout(savePad, 800);
  });
  document.addEventListener('focusout', (ev) => { if (ev.target.id === 'pad-text') savePad(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePad(); });
  window.addEventListener('pagehide', () => {
    if (pad.draft == null || pad.draft === pad.text) return;
    fetch('/api/scratchpad', { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: pad.draft, base: pad.updatedAt }) });
  });
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-inbox-pad], [data-inbox-pad-close], [data-pad-mode]');
    if (!t) return;
    if (t.dataset.padMode) { savePad(); savePrefs({ padMode: t.dataset.padMode }); renderInbox(); if (t.dataset.padMode === 'edit') $('#pad-text')?.focus(); return; }
    toggleInboxPad(t.dataset.inboxPadClose === undefined ? undefined : false);
  });
}
