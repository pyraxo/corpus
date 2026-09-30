// The Highlights page: every highlight, newest first.
import { keyHint } from '../app/keymap.js';
import { $, esc, num } from '../core/dom.js';
import { prefs } from '../core/prefs.js';
import { store, ui, view } from '../core/state.js';
import { fileLine, isFile, titleOf } from '../data/library.js';
import { clip, jumpToHighlight, whereOf } from '../features/highlights.js';
import { avatarOf, relDate } from '../ui/format.js';
import { openBookmark } from './dialog.js';

// Highlights page: every highlight, newest first; opening one scrolls the reader to it.
function allHighlights() {
  const out = [];
  for (const [id, o] of Object.entries(store.overrides)) {
    if (!o.highlights?.length || o.deleted) continue;
    const r = store.byId.get(id);
    if (r) for (const h of o.highlights) out.push({ r, h });
  }
  return out.sort((a, b) => String(b.h.at).localeCompare(String(a.h.at)));
}
export function renderHighlights() {
  const all = allHighlights();
  const q = (ui.hlQuery || '').toLowerCase().trim();
  const list = q ? all.filter(({ r, h }) => `${h.quote || h.text} ${h.note || ''} ${r.title} ${r.author.name} ${r.author.handle}`.toLowerCase().includes(q)) : all;
  ui.hlList = list;
  view().className = 'view highlights';
  view().innerHTML = `
    <div class="page-head"><h1 class="serif">Highlights</h1>${all.length ? `<div class="page-actions"><input class="field" id="hl-search" placeholder="Filter highlights" value="${esc(ui.hlQuery || '')}" autocomplete="off"></div>` : ''}</div>
    ${all.length ? `<p class="muted small hl-count">${num.format(list.length)}${q ? ` of ${num.format(all.length)}` : ''} highlight${list.length === 1 ? '' : 's'} from ${num.format(new Set(list.map(x => x.r.id)).size)} bookmark${new Set(list.map(x => x.r.id)).size === 1 ? '' : 's'}</p>` : ''}
    ${list.length ? `<ol class="hl-page">${list.map(({ r, h }) => `<li class="hl-card" data-hl-open="${r.id}" data-hl-id="${esc(h.id)}" tabindex="0">
        <blockquote class="serif">${esc(clip(h.quote || h.text, 900)).replace(/\n/g, '<br>')}</blockquote>
        ${h.note ? `<p class="hl-card-note">${esc(h.note)}</p>` : ''}
        <div class="hl-src">${avatarOf(r)}<span class="name">${esc(isFile(r) ? r.author.name || fileLine(r) : r.author.name)}</span>${whereOf(r, h) ? `<span class="hl-where">${esc(whereOf(r, h))}</span>` : ''}<span class="hl-title">${esc(titleOf(r, 90))}</span><span class="date">${relDate(h.at)}</span></div>
      </li>`).join('')}</ol>`
      : `<div class="empty"><p class="serif">${all.length ? 'No highlights match.' : 'No highlights yet.'}</p>${all.length ? '' : `<p class="muted">Select text while reading, then tap <strong>Highlight</strong> or press ${keyHint('reader.highlight')}.</p>`}</div>`}`;
}
export function openHighlight(id, hid) {
  const seen = new Set();
  const list = (ui.hlList || []).map(x => x.r).filter(r => !seen.has(r.id) && seen.add(r.id));
  openBookmark(id, list.length ? list : undefined, 'Highlights');
  requestAnimationFrame(() => requestAnimationFrame(() => jumpToHighlight(prefs.openIn === 'dialog' ? $('#reader-body') : $('#triage-body'), hid)));
}
