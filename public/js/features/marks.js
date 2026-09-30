// The stack (five reads, first in first out) and read state.
import { store } from '../core/state.js';
import { saveEach, saveOverride } from '../data/history.js';
import { STACK_MAX, stackAll } from '../data/library.js';
import { shortTitle } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { repaintBookmark } from '../views/post.js';

export async function toggleStack(id) {
  if (!store.byId.has(id)) return;
  if (store.overrides[id]?.stackedAt) {
    await saveOverride([id], { stackedAt: null }, { label: 'Take off the stack' });
    toast('Taken off the stack', { undo: true });
  } else {
    // First in, first out: make room by letting the oldest go.
    const rest = stackAll().filter(r => r.id !== id);
    const out = rest.slice(0, Math.max(0, rest.length - STACK_MAX + 1));
    await saveEach({ [id]: { stackedAt: new Date().toISOString() }, ...Object.fromEntries(out.map(r => [r.id, { stackedAt: null }])) }, { label: 'Add to stack' });
    toast(out.length ? `On the stack · “${shortTitle(out[0])}” made room` : `On the stack · ${rest.length + 1} of ${STACK_MAX}`, { undo: true });
  }
  repaintBookmark(id);
}
export async function toggleRead(id) {
  const o = store.overrides[id] || {};
  if (!store.byId.has(id) || o.deleted) return;
  // Unmarking keeps readAt, so "last read" survives; finishing a stacked read takes it off the stack.
  if (o.read) { await saveOverride([id], { read: null }, { label: 'Mark unread' }); toast('Marked unread', { undo: true }); }
  else {
    await saveOverride([id], { read: true, readAt: new Date().toISOString(), ...(o.stackedAt ? { stackedAt: null } : {}) }, { label: 'Mark read' });
    toast(o.stackedAt ? 'Read · off the stack' : 'Marked read', { undo: true });
  }
  repaintBookmark(id);
}
