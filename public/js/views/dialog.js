// Opening a bookmark (the reader or the dialog, per Settings), the dialog itself, and capturing a post from X on demand.
import { rememberOpened } from '../app/palette.js';
import { navigate, updateInboxCount } from '../app/router.js';
import { $, $$ } from '../core/dom.js';
import { prefs } from '../core/prefs.js';
import { store, ui } from '../core/state.js';
import { saveOverride } from '../data/history.js';
import { api, facetOf, label } from '../data/library.js';
import { bookmarkSession, chatHtml } from '../features/chat.js';
import { toast } from '../ui/toast.js';
import { focusCardById, refreshCards } from './library.js';
import { fitScratchpads, paintReader } from './post.js';
import { TRIAGE_LABEL, triagePatch } from './reader/index.js';

export function openReader(id, list) {
  const r = store.byId.get(id);
  if (!r) return;
  ui.readerId = id;
  rememberOpened(id);
  if (list) ui.readerList = list;
  const el = $('#reader');
  paintReader($('#reader-body'), r);
  showReaderTab('read');
  captureNow(r);
  el.hidden = false;
  document.body.classList.add('locked');
  requestAnimationFrame(() => el.classList.add('in'));
  $('.reader-sheet').scrollTop = 0;
  $('.reader-sheet').focus({ preventScroll: true });
  if (location.pathname !== `/b/${id}`) history.pushState({ reader: id, from: location.pathname + location.search }, '', `/b/${id}`);
}
export function closeReader({ fromPop = false } = {}) {
  const el = $('#reader');
  if (el.hidden) return;
  el.classList.remove('in');
  document.body.classList.remove('locked');
  setTimeout(() => { el.hidden = true; }, 180);
  const last = ui.readerId;
  ui.readerId = null;
  if (!fromPop) { const st = history.state; if (st?.reader && st.from) history.back(); else history.replaceState({}, '', '/'); }
  if (ui.view === 'library') { refreshCards(); focusCardById(last); }
}
export function stepReader(d) {
  const list = ui.readerList.length ? ui.readerList : (ui.results || []);
  const i = list.findIndex(r => r.id === ui.readerId);
  const next = list[i + d];
  if (next) { history.replaceState({ ...history.state, reader: next.id }, '', `/b/${next.id}`); openReader(next.id); }
}
// Opening a bookmark: the reader (the inbox's layout, going through the list you opened it
// from) or the dialog over the page, as set in Settings → Library & inbox. from names the list.
export function openBookmark(id, list, from) {
  if (!store.byId.has(id)) return;
  if (prefs.openIn === 'dialog') { openReader(id, list); return; }
  closeReader({ fromPop: true });
  const ids = (list?.length ? list : [store.byId.get(id)]).map(r => r.id);
  ui.readList = ids.includes(id) ? ids : [id, ...ids];
  ui.readFrom = from || (ui.view === 'library' ? libraryLabel() : ui.view === 'highlights' ? 'Highlights' : null);
  ui.readBack = location.pathname + location.search;
  ui.inboxId = id;
  rememberOpened(id);
  navigate(`/read/${id}`);
}
// What the library is showing, as the name of a reading list: "AI · Agents", "Search: evals".
export function libraryLabel() {
  const bits = [...ui.filters].map(label);
  if (ui.query) bits.push(`“${ui.query}”`);
  const st = { inbox: 'Untriaged', kept: 'Kept', archived: 'Archive', deleted: 'Trash' }[ui.status];
  return [st, ...bits].filter(Boolean).join(' · ') || 'Library';
}
export const inQueue = () => ui.view === 'inbox' || ui.view === 'read';
// Uncaptured bookmark opened: move it to the front of the capture queue and fill it in when ready.
const capturing = new Set();
export async function captureNow(r) {
  if (r.enrichment !== 'pending' || capturing.has(r.id)) return;
  capturing.add(r.id);
  try { await api('/api/enrich/priority', { method: 'POST', body: { id: r.id } }); } catch { capturing.delete(r.id); return; }
  for (let i = 0; i < 90 && r.enrichment === 'pending'; i++) {
    await new Promise(res => setTimeout(res, i < 6 ? 2000 : 5000));
    const res = await fetch(`/api/enrichment/${r.id}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok) { applyEnrichment(r, body); break; }
    const note = $$(`[data-pending="${r.id}"]`);
    if (body.waitingUntil) note.forEach(n => { n.textContent = `Queued — X’s rate limit resets in ${Math.max(1, Math.round((body.waitingUntil - Date.now()) / 60000))} min, then this is captured first.`; });
  }
  capturing.delete(r.id);
  if (ui.readerId === r.id) { paintReader($('#reader-body'), r); }
  if (ui.inboxId === r.id && inQueue() && $('#triage-body')) paintReader($('#triage-body'), r, { docked: true });
}
function applyEnrichment(r, enr) {
  r.enrichment = enr.status;
  r.enrichedAt = enr.fetchedAt;
  if (enr.status !== 'ok') return;
  const focalIndex = Math.max(0, enr.thread.findIndex(t => t.id === r.id));
  const focal = enr.thread[focalIndex];
  if (focal) { r.text = focal.text; if (focal.media?.length) r.media = focal.media; }
  if (enr.thread.length > 1) { r.thread = enr.thread; r.focalIndex = focalIndex; r.format = 'format:thread'; r.tags = [...r.tags.filter(t => facetOf(t.id) !== 'format'), { id: 'format:thread', by: 'rule', score: 1 }]; }
  if (enr.article) { r.article = enr.article; r.title = enr.article.title || r.title; }
  if (enr.card) r.card = { ...enr.card, url: enr.card.url || r.links.find(l => !/x\.com|twitter\.com/.test(l)) || null };
  if (enr.quoted) {
    // The quoted post's own unroll (enr.quote) carries its thread, article and card.
    const full = enr.quote?.status === 'ok' ? enr.quote : null;
    const qi = full ? Math.max(0, full.thread.findIndex(t => t.id === enr.quoted.id)) : 0;
    r.quoted = { ...enr.quoted, url: `https://x.com/${enr.quoted.author?.handle || 'i'}/status/${enr.quoted.id}` };
    if (full) Object.assign(r.quoted, { thread: full.thread.length > 1 ? full.thread : null, focalIndex: full.thread.length > 1 ? qi : 0, article: full.article, card: full.card || enr.quoted.card });
  }
  store.tagCache.delete(r.id); store.hay.delete(r.id);
}
// Reader chat tab.
export async function showReaderTab(tab) {
  ui.readerTab = tab;
  $$('[data-rtab]').forEach(b => b.setAttribute('aria-pressed', b.dataset.rtab === tab));
  $('#reader-body').hidden = tab !== 'read';
  if (tab === 'read') fitScratchpads($('#reader-body'));
  const box = $('#reader-chat');
  box.hidden = tab !== 'chat';
  if (tab !== 'chat') return;
  const s = await bookmarkSession(ui.readerId);
  box.innerHTML = chatHtml(s);
  const sheet = $('.reader-sheet'); sheet.scrollTop = sheet.scrollHeight;
  $('textarea', box)?.focus();
}
export function focusTagInput() { showReaderTab('read'); const i = $('#reader [data-tag-input]'); i?.scrollIntoView({ block: 'center' }); i?.focus(); }
export async function triageReader(value) {
  const id = ui.readerId; if (!id) return;
  const o = store.overrides[id] || {};
  // Pressing the current state again clears it (e.g. un-archive).
  const clear = value !== 'deleted' && o.triaged === value;
  await saveOverride([id], clear ? { triaged: null } : triagePatch(value), { label: clear ? `Un-${TRIAGE_LABEL[value].toLowerCase()}` : TRIAGE_LABEL[value] });
  updateInboxCount();
  toast(clear ? 'Moved back to the inbox' : value === 'kept' ? 'Kept' : value === 'archived' ? 'Archived' : 'Moved to Trash · deleted in 30 days', { undo: true });
  const r = store.byId.get(id); if (r) paintReader($('#reader-body'), r);
}
export async function restoreReader() {
  const id = ui.readerId; if (!id) return;
  await saveOverride([id], { deleted: null }, { label: 'Restore' });
  updateInboxCount(); toast('Restored', { undo: true });
  const r = store.byId.get(id); if (r) paintReader($('#reader-body'), r);
}
