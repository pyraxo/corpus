// Saving your changes, with undo and redo.
import { updateInboxCount } from '../app/router.js';
import { $ } from '../core/dom.js';
import { store, ui } from '../core/state.js';
import { api, facetOf, label } from './library.js';
import { toast } from '../ui/toast.js';
import { refreshCards } from '../views/library.js';
import { paintReader, repaintBookmark } from '../views/post.js';
import { renderInbox } from '../views/reader/index.js';

// Each change records exact before/after snapshots of the affected bookmarks' state,
// so ⌘Z / ⇧⌘Z can restore either side precisely (triage, tags, scratchpads, highlights, deletes, bulk).
export const undoStack = [], redoStack = [];
const snap = (ids) => Object.fromEntries(ids.map(id => [id, store.overrides[id] ? structuredClone(store.overrides[id]) : null]));
function applySnap(entries) {
  for (const [id, o] of Object.entries(entries)) { if (o) store.overrides[id] = o; else delete store.overrides[id]; store.tagCache.delete(id); store.hay.delete(id); }
}
function patchLocal(id, patch, now = new Date().toISOString()) {
  const next = { ...(store.overrides[id] || {}) };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
  if (patch.deleted === true && !next.deletedAt) next.deletedAt = now;
  if (patch.deleted === null) delete next.deletedAt;
  store.overrides[id] = next; store.tagCache.delete(id); store.hay.delete(id);
}
function pushUndo(label, ids, before) { undoStack.push({ label, ids, before, after: snap(ids) }); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
export async function saveOverride(ids, patch, { label = 'Change', undoable = true } = {}) {
  const before = snap(ids);
  const now = new Date().toISOString();
  for (const id of ids) patchLocal(id, patch, now);
  if (undoable) pushUndo(label, ids, before);
  try { await api('/api/overrides', { method: 'PUT', body: { ids, patch } }); }
  catch (e) { toast(`Not saved: ${e.message}`); }
}
// Different patches for different bookmarks, saved and undone as one change.
export async function saveEach(patches, { label = 'Change' } = {}) {
  const ids = Object.keys(patches);
  const before = snap(ids);
  for (const [id, patch] of Object.entries(patches)) patchLocal(id, patch);
  pushUndo(label, ids, before);
  await persistSnap(snap(ids));
}
async function persistSnap(entries) {
  try { await api('/api/overrides/restore', { method: 'PUT', body: { entries } }); } catch (e) { toast(`Not saved: ${e.message}`); }
}
export async function undo() {
  const e = undoStack.pop();
  if (!e) { toast('Nothing to undo'); return; }
  applySnap(e.before); redoStack.push(e);
  afterHistory(e, true); toast(`Undid: ${e.label}`);
  await persistSnap(e.before);
}
export async function redo() {
  const e = redoStack.pop();
  if (!e) { toast('Nothing to redo'); return; }
  applySnap(e.after); undoStack.push(e);
  afterHistory(e, false); toast(`Redid: ${e.label}`);
  await persistSnap(e.after);
}
function afterHistory(e, undone) {
  updateInboxCount();
  const readerOpen = !$('#reader').hidden;
  if (ui.view === 'inbox' && !readerOpen) {
    // Undoing a triage brings that bookmark back to the front of the queue.
    if (undone && e.ids.length === 1 && store.byId.has(e.ids[0])) ui.inboxId = e.ids[0];
    renderInbox();
  } else if (ui.view === 'read' && !readerOpen) repaintBookmark(ui.inboxId);
  else if (ui.view === 'library' && !readerOpen) refreshCards();
  if (readerOpen && ui.readerId) { const r = store.byId.get(ui.readerId); if (r) paintReader($('#reader-body'), r); }
}
export async function setTags(r, { add = [], remove = [] }) {
  const o = store.overrides[r.id] || {};
  const machine = new Set(r.tags.map(t => t.id));
  let nextAdd = new Set(o.add || []), nextRemove = new Set(o.remove || []);
  for (const id of add) { nextRemove.delete(id); if (!machine.has(id)) nextAdd.add(id); }
  for (const id of remove) { nextAdd.delete(id); if (machine.has(id)) nextRemove.add(id); }
  // Picking a format by hand is exclusive.
  if (add.some(id => facetOf(id) === 'format')) for (const id of nextAdd) if (facetOf(id) === 'format' && !add.includes(id)) nextAdd.delete(id);
  await saveOverride([r.id], { add: [...nextAdd], remove: [...nextRemove] }, { label: add.length ? `Tag ${add.map(label).join(', ')}` : `Untag ${remove.map(label).join(', ')}` });
}
