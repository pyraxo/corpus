// The reader's queue: the inbox's filters, and a virtualized list of thousands of rows.
import { $, esc, num } from '../../core/dom.js';
import { prefs } from '../../core/prefs.js';
import { store, ui } from '../../core/state.js';
import { ancestors, descendants, facetOf, fileLine, formatOf, isDoc, isFile, isRead, label, progressOf, tagIds } from '../../data/library.js';
import { FORMAT_TABS, SORTS, WINDOWS, query, sortRecords } from '../../data/query.js';
import { relDate, snippet } from '../../ui/format.js';

export function inboxBase() {
  const w = prefs.inboxWindow;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[w];
  const cutoff = days ? Date.now() - days * 864e5 : w === 'older' ? Date.now() - 30 * 864e5 : 0;
  return query({ status: 'inbox', filters: new Set(), q: '' }).filter(r => !cutoff || (w === 'older' ? new Date(r.postedAt) < cutoff : new Date(r.postedAt) >= cutoff));
}
// The queue: untriaged bookmarks in the chosen window, narrowed by type and topic, in the chosen order.
export function inboxQueue() {
  const topicIds = prefs.inboxTopic ? new Set(descendants(prefs.inboxTopic)) : null;
  const list = inboxBase().filter(r => (prefs.inboxFormat === 'all' || formatOf(r) === prefs.inboxFormat) && (!topicIds || tagIds(r).some(id => topicIds.has(id))));
  return sortRecords(list, prefs.inboxSort);
}
export function inboxControls(base) {
  const topicIds = prefs.inboxTopic ? new Set(descendants(prefs.inboxTopic)) : null;
  const byTopic = topicIds ? base.filter(r => tagIds(r).some(id => topicIds.has(id))) : base;
  const byFormat = prefs.inboxFormat === 'all' ? base : base.filter(r => formatOf(r) === prefs.inboxFormat);
  const fmtCounts = new Map();
  for (const r of byTopic) fmtCounts.set(formatOf(r), (fmtCounts.get(formatOf(r)) || 0) + 1);
  const topicCounts = new Map();
  for (const r of byFormat) { const seen = new Set(); for (const id of tagIds(r)) if (facetOf(id) === 'topic') for (const a of [id, ...ancestors(id)]) if (!seen.has(a)) { seen.add(a); topicCounts.set(a, (topicCounts.get(a) || 0) + 1); } }
  const topics = store.concepts.filter(c => c.facet === 'topic' && (topicCounts.get(c.id) || prefs.inboxTopic === c.id)).sort((a, b) => (a.parent || a.id).localeCompare(b.parent || b.id) || (a.parent ? 1 : -1) - (b.parent ? 1 : -1) || topicCounts.get(b.id) - topicCounts.get(a.id));
  const filtered = prefs.inboxFormat !== 'all' || prefs.inboxTopic || prefs.inboxWindow !== 'all';
  return `<div class="inbox-controls">
      <div class="ic-row">
        <select id="inbox-sort" aria-label="Order">${SORTS.map(([v, l]) => `<option value="${v}" ${prefs.inboxSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="inbox-window" aria-label="When">${WINDOWS.map(([v, l]) => `<option value="${v}" ${prefs.inboxWindow === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <select id="inbox-topic" aria-label="Topic"><option value="">All topics</option>${topics.map(c => `<option value="${esc(c.id)}" ${prefs.inboxTopic === c.id ? 'selected' : ''}>${c.parent ? '\u2003' : ''}${esc(c.label)} · ${num.format(topicCounts.get(c.id) || 0)}</option>`).join('')}</select>
      <div class="ic-formats" role="group" aria-label="Type">${FORMAT_TABS.filter(([v]) => v === 'all' || fmtCounts.get(v) || prefs.inboxFormat === v).map(([v, l]) => `<button data-inbox-format="${v}" aria-pressed="${prefs.inboxFormat === v}">${l}<span>${num.format(v === 'all' ? byTopic.length : fmtCounts.get(v) || 0)}</span></button>`).join('')}</div>
      ${filtered ? '<button class="ghost small ic-clear" data-inbox-clear>Reset</button>' : ''}
    </div>`;
}
// Virtualized queue list: only the rows near the scrollport are ever in the DOM, so scrolling
// works over the whole queue (thousands of bookmarks) instead of a small window around the current item.
// Row height by density: three lines with room to breathe, or two tight ones. Must match .queue li in css/inbox.css.
export const queueRowH = () => prefs.density === 'compact' ? 56 : 84;
const QUEUE_OVERSCAN = 8;
let queueScrollRaf = 0;
const queueRowHtml = (r, top, currentId) => {
  const title = (r.title || snippet(r, 80)).slice(0, 90);
  // Omit the title line entirely when there's no text yet (pending capture) — an empty span
  // still reserves its line's height in the fixed-height row, leaving an ugly gap.
  const who = isFile(r) ? r.author.name || fileLine(r) : r.author.name;
  const kind = `${label(formatOf(r))}${r.thread ? ` · ${r.thread.length}` : ''}${isDoc(r) && progressOf(r) > 0.005 ? ` · ${Math.round(progressOf(r) * 100)}%` : ''}${isRead(r) ? ' · read' : ''}`;
  const attrs = `class="${r.id === currentId ? 'on' : ''}" style="top:${top}px" data-pick="${r.id}"`;
  // Compact: the title, then one line for who, what and when.
  if (prefs.density === 'compact') return `<li ${attrs}><span class="q-title">${esc(title || who)}</span><span class="q-line"><span class="q-name">${esc(who)}</span><span class="q-meta">${kind}</span><span class="q-date">${relDate(r.postedAt)}</span></span></li>`;
  return `<li ${attrs}><span class="q-author"><span class="q-name">${esc(who)}</span><span class="q-date">${relDate(r.postedAt)}</span></span>${title ? `<span class="q-title">${esc(title)}</span>` : ''}<span class="q-meta">${kind}</span></li>`;
};
export function renderQueueRows() {
  const listEl = $('#queue-list'), scrollerEl = $('.queue');
  if (!listEl || !scrollerEl) return;
  const queue = ui.inboxQueue || [];
  const viewportH = scrollerEl.clientHeight || 0;
  const scrollTop = Math.max(0, scrollerEl.scrollTop - listEl.offsetTop);
  const start = Math.max(0, Math.floor(scrollTop / queueRowH()) - QUEUE_OVERSCAN);
  const end = Math.min(queue.length, Math.ceil((scrollTop + viewportH) / queueRowH()) + QUEUE_OVERSCAN);
  listEl.innerHTML = queue.slice(start, end).map((r, i) => queueRowHtml(r, (start + i) * queueRowH(), ui.inboxId)).join('');
}
export function handleQueueScroll() { cancelAnimationFrame(queueScrollRaf); queueScrollRaf = requestAnimationFrame(renderQueueRows); }
// Scrolls the queue so the given bookmark's row is in view, then repaints the visible rows.
export function ensureQueueVisible(id) {
  const scrollerEl = $('.queue'), listEl = $('#queue-list');
  if (!scrollerEl || !listEl) return;
  const idx = (ui.inboxQueue || []).findIndex(r => r.id === id);
  if (idx < 0) return;
  const top = listEl.offsetTop + idx * queueRowH(), bottom = top + queueRowH();
  if (top < scrollerEl.scrollTop) scrollerEl.scrollTop = top;
  else if (bottom > scrollerEl.scrollTop + scrollerEl.clientHeight) scrollerEl.scrollTop = bottom - scrollerEl.clientHeight;
  renderQueueRows();
}
