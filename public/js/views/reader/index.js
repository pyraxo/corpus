// The reader (the inbox layout) in its two modes: Triage (/inbox) and Read (/read/<id>).
import { capsText, keyHint } from '../../app/keymap.js';
import { rememberOpened } from '../../app/palette.js';
import { navigate, updateInboxCount } from '../../app/router.js';
import { $, esc, num } from '../../core/dom.js';
import { prefs } from '../../core/prefs.js';
import { store, ui, view } from '../../core/state.js';
import { saveOverride } from '../../data/history.js';
import { isDoc, readWhen } from '../../data/library.js';
import { daysLeft, statusOk } from '../../data/query.js';
import { loadInboxChat } from '../../features/chat.js';
import { inboxPadHtml, loadPad, pad } from '../../features/scratchpad.js';
import { sideDock } from '../../features/sidebar.js';
import { toast } from '../../ui/toast.js';
import { captureNow } from '../dialog.js';
import { afterPaint, fitScratchpads, readerContent, tagEditor } from '../post.js';
import { queueRowH, ensureQueueVisible, handleQueueScroll, inboxBase, inboxControls, inboxQueue, renderQueueRows } from './queue.js';

// Triage (/inbox): the untriaged queue; keep, archive or delete each one and move on.
// Read (/read/<id>): the list you opened a bookmark from; read, tag, highlight and annotate,
// mark it read or stack it, then go to the next. Both share the queue, dock and sidebar.
const readQueue = () => ui.readList.map(id => store.byId.get(id)).filter(r => r && !store.overrides[r.id]?.purged);
function modeToggle(reading) {
  return `<div class="segmented mode-toggle" role="group" aria-label="Mode"><button data-mode="read" aria-pressed="${reading}" title="Read through the list (${esc(capsText('read.mode.read'))})">Read</button><button data-mode="triage" aria-pressed="${!reading}" title="Keep, archive or delete (${esc(capsText('read.mode.triage'))})">Triage</button></div>`;
}
function dockBar(current, reading, idx, total) {
  const o = store.overrides[current.id] || {};
  if (!reading) return `<div class="triage-bar">
        <button class="primary" data-triage="kept">Keep ${keyHint('inbox.keep')}</button>
        <button class="ghost" data-triage="archived">Archive ${keyHint('inbox.archive')}</button>
        <button class="ghost" data-skip>Skip ${keyHint('inbox.next')}</button>
        <button class="ghost danger" data-triage="deleted">Delete ${keyHint('inbox.delete')}</button>
        <button class="ghost ask-ai" data-inbox-ask aria-pressed="${!!ui.inboxChat}">Ask AI ${keyHint('inbox.ask')}</button>
        <button class="ghost ask-ai" data-inbox-pad aria-pressed="${!!ui.inboxPad}">Scratchpad ${keyHint('inbox.pad')}</button>
        <span class="muted small">${idx + 1} of ${num.format(total)}</span>
      </div>`;
  if (o.deleted) return `<div class="triage-bar"><button class="primary" data-read-restore>Restore</button><span class="muted small">In Trash · deleted for good in ${daysLeft(current)} days</span><button class="ghost" data-read-step="1">Next ${keyHint('read.next')}</button><span class="muted small">${idx + 1} of ${num.format(total)}</span></div>`;
  const t = o.triaged;
  return `<div class="triage-bar">
        <button class="${o.read ? 'ghost' : 'primary'}" data-mark-read="${current.id}" aria-pressed="${!!o.read}">${o.read ? `Read ${readWhen(o.readAt)}` : 'Done reading'} ${keyHint('read.done')}</button>
        <button class="ghost" data-stack="${current.id}" aria-pressed="${!!o.stackedAt}">${o.stackedAt ? 'On the stack' : 'Stack'} ${keyHint('read.stack')}</button>
        <button class="ghost" data-read-triage="kept" aria-pressed="${t === 'kept'}">${t === 'kept' ? 'Kept' : 'Keep'} ${keyHint('read.keep')}</button>
        <button class="ghost" data-read-triage="archived" aria-pressed="${t === 'archived'}">${t === 'archived' ? 'Archived' : 'Archive'} ${keyHint('read.archive')}</button>
        <button class="ghost" data-read-step="1" ${idx + 1 >= total ? 'disabled' : ''}>Next ${keyHint('read.next')}</button>
        <button class="ghost ask-ai" data-inbox-ask aria-pressed="${!!ui.inboxChat}">Ask AI ${keyHint('read.ask')}</button>
        <button class="ghost ask-ai" data-inbox-pad aria-pressed="${!!ui.inboxPad}">Scratchpad ${keyHint('read.pad')}</button>
        <span class="muted small">${idx + 1} of ${num.format(total)}</span>
      </div>`;
}
export function renderInbox() {
  const reading = ui.view === 'read';
  const base = reading ? readQueue() : inboxBase();
  const queue = reading ? base : inboxQueue();
  ui.inboxQueue = queue;
  if (!queue.find(r => r.id === ui.inboxId)) ui.inboxId = queue[0]?.id || null;
  const current = store.byId.get(ui.inboxId);
  view().className = `view inbox${reading ? ' reading' : ''}`;
  if (!reading && !base.length && prefs.inboxWindow === 'all') { view().innerHTML = `<div class="inbox-empty"><p class="serif big">Inbox zero.</p><p class="muted">New bookmarks from FieldTheory, and files you drop in, land here.</p><div class="inbox-empty-actions">${modeToggle(false)}<button class="ghost" data-inbox-pad aria-pressed="${!!ui.inboxPad}">Inbox scratchpad</button></div>${ui.inboxPad ? inboxPadHtml() : ''}</div>`; if (ui.inboxPad && (!pad.loaded || Date.now() - pad.fetchedAt > 10_000)) loadPad(); return; }
  const idx = current ? queue.indexOf(current) : -1;
  const counts = `<a href="/archive" data-link>Archive <span>${num.format(store.records.filter(x => statusOk(x, 'archived')).length)}</span></a><a href="/trash" data-link>Trash <span>${num.format(store.records.filter(x => statusOk(x, 'deleted')).length)}</span></a>`;
  const head = reading
    ? `<div class="queue-head"><div class="queue-count"><span class="count">${num.format(queue.length)}</span><span class="muted">to read${ui.readFrom ? ` · <span class="read-from">${esc(ui.readFrom)}</span>` : ''}</span></div>${modeToggle(true)}<div class="queue-links"><a href="${esc(ui.readBack && !ui.readBack.startsWith('/read') ? ui.readBack : '/')}" data-link data-read-back>← Back</a><button class="link" data-inbox-pad aria-pressed="${!!ui.inboxPad}">Scratchpad</button></div></div>`
    : `<div class="queue-head"><div class="queue-count"><span class="count">${num.format(queue.length)}</span><span class="muted">to triage${queue.length !== base.length ? ` · ${num.format(base.length)} in window` : ''}</span></div>${modeToggle(false)}<div class="queue-links">${counts}<button class="link" data-inbox-pad aria-pressed="${!!ui.inboxPad}">Scratchpad</button></div>${inboxControls(base)}</div>`;
  const prevScroll = $('.queue')?.scrollTop || 0;
  const list = current ? `<ol id="queue-list" style="height:${queue.length * queueRowH()}px"></ol>` : '';
  const main = current ? `
      <div class="triage-main">
      <div class="triage-scroll"><div class="reader-body inline${isDoc(current) ? ' has-doc' : ''}" id="triage-body">${readerContent(current, { docked: true })}</div></div>
      <div class="triage-dock">
      <div class="dock-meta">
        <div class="tag-editor" data-tags="${current.id}">${tagEditor(current)}</div>
        <textarea class="scratchpad" data-scratchpad="${current.id}" rows="1" placeholder="Scratchpad — why you saved this, what to do with it">${esc(store.overrides[current.id]?.scratchpad || '')}</textarea>
      </div>
      ${dockBar(current, reading, idx, queue.length)}
      </div>
      </div>${sideDock(current)}` : `<div class="inbox-empty"><p class="serif">${reading ? 'Nothing to read here.' : 'Nothing to triage here.'}</p>${reading ? '<a class="ghost" href="/" data-link>Back to the library</a>' : '<button class="ghost" data-inbox-clear>Reset filters</button>'}</div>${sideDock(null)}`;
  view().innerHTML = `<aside class="queue" aria-label="Queue">${head}${list}</aside><section class="triage ${sideDock(current) ? 'with-chat' : ''}">${main}</section>`;
  if (ui.inboxPad && (!pad.loaded || Date.now() - pad.fetchedAt > 10_000)) loadPad();
  if (current) {
    fitScratchpads($('.triage-dock'));
    afterPaint($('#triage-body'), current, { docked: true });
    captureNow(current);
    if (ui.inboxChat) loadInboxChat(current.id);
    const scrollerEl = $('.queue');
    scrollerEl.scrollTop = prevScroll;
    renderQueueRows();
    scrollerEl.addEventListener('scroll', handleQueueScroll, { passive: true });
  }
}
// The queue after the library changed underneath it (files added, a rebuild), without redrawing the post.
export function refreshQueue() {
  ui.inboxQueue = ui.view === 'read' ? readQueue() : inboxQueue();
  const listEl = $('#queue-list'), count = $('.queue-count .count');
  if (listEl) listEl.style.height = `${ui.inboxQueue.length * queueRowH()}px`;
  if (count) count.textContent = num.format(ui.inboxQueue.length);
  renderQueueRows(); paintDock();
}
// The dock's buttons after a change to this bookmark (read, stacked, kept), without touching the post.
export function paintDock() {
  const r = store.byId.get(ui.inboxId), bar = $('.triage-bar');
  if (!r || !bar) return;
  const q = ui.inboxQueue || [];
  bar.outerHTML = dockBar(r, ui.view === 'read', q.findIndex(x => x.id === r.id), q.length);
}
// An edit in progress in the post pane: moving on asks first, so it isn't lost.
export const leaveEdit = () => !$('#triage-body > .edit-form') || confirm('Leave without saving your edits?');

// Move to another bookmark in the queue (either mode); in Read the address follows along.
export function pickQueued(id, { scroll = true } = {}) {
  if (!id || !store.byId.has(id) || !leaveEdit()) return;
  ui.inboxId = id;
  if (ui.view === 'read') { rememberOpened(id); history.replaceState({ ...history.state }, '', `/read/${id}`); }
  renderInbox();
  if (scroll) scrollTriageTop();
  ensureQueueVisible(id);
}
export async function readTriage(value) {
  const id = ui.inboxId, o = store.overrides[id] || {};
  if (!id) return;
  const clear = o.triaged === value;
  await saveOverride([id], clear ? { triaged: null } : { triaged: value }, { label: clear ? `Un-${TRIAGE_LABEL[value].toLowerCase()}` : TRIAGE_LABEL[value] });
  updateInboxCount(); paintDock();
  toast(clear ? 'Moved back to the inbox' : value === 'kept' ? 'Kept' : 'Archived', { undo: true });
}
export async function readDelete() {
  const id = ui.inboxId; if (!id || !leaveEdit()) return;
  const q = ui.inboxQueue || [], next = q[q.findIndex(r => r.id === id) + 1];
  await saveOverride([id], { deleted: true }, { label: 'Move to Trash' });
  ui.readList = ui.readList.filter(x => x !== id);
  updateInboxCount(); toast('Moved to Trash · deleted in 30 days', { undo: true });
  pickQueued(next?.id || ui.readList[0]);
  if (!ui.readList.length) renderInbox();
}
// Switch between Read and Triage, keeping your place where it makes sense.
export function setMode(mode) {
  if (mode === 'read' && ui.view !== 'read') {
    ui.readList = (ui.inboxQueue || []).map(r => r.id);
    ui.readFrom = 'Inbox'; ui.readBack = '/inbox';
    if (ui.inboxId) navigate(`/read/${ui.inboxId}`); else navigate('/read');
  } else if (mode === 'triage' && ui.view !== 'inbox') navigate('/inbox');
}
export const TRIAGE_LABEL = { kept: 'Keep', archived: 'Archive', deleted: 'Move to Trash' };
export const triagePatch = (v) => v === 'deleted' ? { deleted: true } : { triaged: v };
// On mobile .triage-scroll doesn't scroll itself (overflow: visible, the page scrolls instead),
// so resetting its own scrollTop isn't enough — scroll it into view too.
function scrollTriageTop() {
  const ts = $('.triage-scroll');
  if (!ts) return;
  ts.scrollTop = 0;
  ts.scrollIntoView({ block: 'start' });
}
export async function triageCurrent(value) {
  const r = store.byId.get(ui.inboxId);
  if (!r || !leaveEdit()) return;
  const queue = ui.inboxQueue || [];
  const next = queue[queue.indexOf(r) + 1];
  await saveOverride([r.id], triagePatch(value), { label: TRIAGE_LABEL[value] });
  toast(value === 'kept' ? 'Kept' : value === 'archived' ? 'Archived' : 'Moved to Trash · deleted in 30 days', { undo: true });
  ui.inboxId = next?.id || null;
  updateInboxCount();
  renderInbox();
  scrollTriageTop();
}
export function inboxStep(d) {
  const q = ui.inboxQueue || [];
  const i = q.findIndex(r => r.id === ui.inboxId);
  const next = q[i + d];
  if (!next) return;
  pickQueued(next.id);
}
