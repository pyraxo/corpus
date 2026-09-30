// Sharing what you're reading. The installed app has no address bar, so the reader offers the
// links worth sending: the post on X (or the page, for a saved link), the article a post links
// to, and this bookmark in Corpus; and the device's own share sheet where there is one.
import { $, copyText, esc } from '../core/dom.js';
import { isFile } from '../data/library.js';

const isX = (u) => /^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(u || '');
export const corpusLink = (r) => `${location.origin}/b/${r.id}`;
// The links worth sharing for a bookmark, most useful first.
function links(r) {
  const out = [];
  if (r.provider === 'twitter') out.push(['post', 'Copy link to the post on X', r.url]);
  else if (r.provider === 'web') out.push(['page', 'Copy link to the page', r.url]);
  // The post's own link, else the first a thread part links to.
  const ext = (ls = []) => ls.find(l => /^https?:/.test(l) && !isX(l));
  const linked = r.provider === 'twitter' && (r.card?.url || ext(r.links) || (r.thread || []).map(t => t.card?.url || ext(t.links)).find(Boolean));
  if (linked && !isX(linked)) out.push(['article', 'Copy link to the linked page', linked]);
  out.push(['corpus', 'Copy Corpus link', corpusLink(r)]);
  return out;
}
// What the share sheet gets: the original when there is one, else the Corpus link.
const shareUrl = (r) => isFile(r) ? corpusLink(r) : r.url;

export function openShare(anchor, r) {
  closeShare();
  const items = links(r);
  const canShare = !!navigator.share;
  document.body.insertAdjacentHTML('beforeend', `<div id="share" class="share-menu" role="menu">
    ${canShare ? '<button role="menuitem" data-share-native>Share…</button>' : ''}
    ${items.map(([k, l, u]) => `<button role="menuitem" data-share-copy="${esc(u)}"><span>${esc(l)}</span><span class="share-url">${esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 46))}</span></button>`).join('')}
  </div>`);
  const menu = $('#share');
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(innerHeight - menu.offsetHeight - 8, rect.bottom + 6)}px`;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth))}px`;
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    closeShare();
    if (b.dataset.shareNative !== undefined) { try { await navigator.share({ title: r.title || undefined, url: shareUrl(r) }); } catch {} return; }
    copyText(b.dataset.shareCopy);
  });
  (menu.querySelector('button') || menu).focus();
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  document.addEventListener('keydown', escape, true);
}
const outside = (e) => { if (!e.target.closest('#share')) closeShare(); };
const escape = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeShare(); } };
export function closeShare() {
  $('#share')?.remove();
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', escape, true);
}
