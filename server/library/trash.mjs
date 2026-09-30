// Deleted bookmarks sit in Trash for 30 days, then are purged. FieldTheory's own
// files are never touched: a purged X bookmark becomes a permanent hidden tombstone
// in Corpus's state; a purged web page is removed from data/manual.json, and a purged file
// (image, PDF, book) has its folder in data/files/ deleted.
import { readState, writeState } from './state.mjs';
import { removeManual } from './manual.mjs';
import { removeFile } from '../files/store.mjs';

export const TRASH_DAYS = 30;
const DAY = 864e5;

export async function purgeTrash({ log = () => {}, now = Date.now() } = {}) {
  const state = await readState();
  const expired = [], stamp = [];
  for (const [id, o] of Object.entries(state.overrides)) {
    if (!o.deleted || o.purged) continue;
    if (!o.deletedAt) stamp.push(id);
    else if (now - Date.parse(o.deletedAt) >= TRASH_DAYS * DAY) expired.push(id);
  }
  if (!expired.length && !stamp.length) return 0;
  for (const id of expired) { if (id.startsWith('web-')) await removeManual(id); if (id.startsWith('file-')) await removeFile(id); }
  await writeState(st => {
    for (const id of stamp) st.overrides[id].deletedAt = st.overrides[id].updatedAt || new Date(now).toISOString();
    for (const id of expired) {
      if (id.startsWith('web-') || id.startsWith('file-')) delete st.overrides[id];
      else st.overrides[id] = { deleted: true, purged: true, deletedAt: st.overrides[id].deletedAt, purgedAt: new Date(now).toISOString() };
    }
  });
  if (expired.length) log(`[trash] purged ${expired.length} bookmark(s) older than ${TRASH_DAYS} days`);
  return expired.length;
}
