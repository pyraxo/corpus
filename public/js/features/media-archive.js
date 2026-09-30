// Local copies of post images, shown when X no longer serves them, and what's saved for each post.
import { $$ } from '../core/dom.js';
import { api } from '../data/library.js';

// A missing video poster fires no error of its own; probe it and use the local copy if X dropped it.
export function archivedPosters(root) {
  for (const v of $$('video[poster]', root)) {
    const poster = v.getAttribute('poster');
    if (!/^https?:\/\//.test(poster)) continue;
    const probe = new Image();
    probe.onerror = () => { v.poster = `/media?u=${encodeURIComponent(poster)}`; };
    probe.referrerPolicy = 'no-referrer';
    probe.src = poster;
  }
}
const archiveCache = new Map();
export async function archiveStatus(r) {
  if (r.provider !== 'twitter') return;
  let c = archiveCache.get(r.id);
  if (!c || Date.now() - c.at > 30_000) { c = { at: Date.now(), p: api(`/api/archive/${r.id}`).catch(() => null) }; archiveCache.set(r.id, c); }
  const a = await c.p;
  if (!a) return;
  const missing = a.of - a.files - a.gone;
  const text = `${a.captured ? 'Saved in Corpus' : 'Post text saved'}${a.of ? ` · ${a.files}/${a.of} media` : ''}${a.gone ? ` · ${a.gone} gone from X` : ''}`;
  const title = `${a.captured ? 'The full post, thread and quoted post are stored locally' : 'FieldTheory keeps the post text; the full thread is captured from X'}${a.of ? `. ${a.files} of ${a.of} images and avatars saved${missing > 0 ? `, ${missing} still downloading` : ''}` : ''}.`;
  for (const el of $$(`[data-archive-status="${r.id}"]`)) { el.textContent = text; el.title = title; el.classList.toggle('partial', missing > 0); }
}

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupMediaArchive() {
  // Corpus saves every post's images locally (FieldTheory keeps the text). When X stops
  // serving an image (the post was deleted), the local copy is shown instead.
  document.addEventListener('error', (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLImageElement || el instanceof HTMLVideoElement) || el.dataset.archived) return;
    const src = el.getAttribute('src');
    if (!/^https?:\/\//.test(src || '')) return;
    el.dataset.archived = '1';
    // Video isn't kept, only its poster frame.
    if (el instanceof HTMLVideoElement) { if (el.getAttribute('poster')) el.poster = `/media?u=${encodeURIComponent(el.getAttribute('poster'))}`; return; }
    el.src = `/media?u=${encodeURIComponent(src)}`;
  }, true);
}
