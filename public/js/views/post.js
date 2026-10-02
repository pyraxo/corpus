// One bookmark in full, as the reader and the dialog show it: posts, threads, articles, and files with their title page.
import { keyHint } from '../app/keymap.js';
import { $, $$, esc, fmt, num } from '../core/dom.js';
import { prefs } from '../core/prefs.js';
import { store, ui } from '../core/state.js';
import { saveOverride } from '../data/history.js';
import { api, KIND_NAME, STACK_MAX, ancestors, facetOf, formatOf, isDoc, isFile, label, minutes, progressOf, readTime, readWhen, stackList, tagIds, tagsOf } from '../data/library.js';
import { daysLeft } from '../data/query.js';
import { highlightsOf, highlightsSection, jumpToHighlight, markHighlights, markRoot } from '../features/highlights.js';
import { archiveStatus, archivedPosters } from '../features/media-archive.js';
import { uploadCover } from '../features/uploads.js';
import { avatar, byline, bytes, formatBadge, fullDate, host, img, richText } from '../ui/format.js';
import { inQueue } from './dialog.js';
import { refreshCards } from './library.js';
import { paintDock } from './reader/index.js';
import { mountDoc } from '../features/doc-reader.js';

// "By Ethan Mollick · One Useful Thing · March 3, 2026 · 12 min read · Open ↗"
function articleByline(a, url, { open = true } = {}) {
  const words = (a.blocks || []).reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);
  const bits = [a.byline && `By ${esc(a.byline)}`, esc(a.siteName || a.site || host(url)), a.published && fullDate(a.published), words > 80 && `${readTime(Math.max(1, Math.round(words / 230)))} read`].filter(Boolean);
  return `<p class="r-byline">${bits.join(' · ')}${open ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}</p>`;
}

// A post that links out to a page (not X, not a native X article): that page may be an article.
const linksOut = (r) => r.provider === 'twitter' && !r.article && !!(r.card?.url || r.links?.length) && !/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(r.card?.url || r.links[0]);
const linked = new Map(); // bookmark id -> the server's answer, fetched once per session
const openLinked = new Set(); // articles you've expanded, kept open across repaints
// Fetch the linked article (the server reads and caches it) and show it under the post, a
// screenful at first; highlights made in it are found again, like any in the post.
export function loadLinked(el, r) {
  const box = $(`.r-linked[data-linked="${CSS.escape(r.id)}"]`, el);
  if (!box) return;
  if (!linked.has(r.id)) linked.set(r.id, api(`/api/linked/${r.id}`).catch(() => null));
  box._ready = (async () => {
    const slow = setTimeout(() => { if (box.isConnected && !box.firstChild) { box.hidden = false; box.innerHTML = '<p class="r-linked-loading">Reading the linked article…</p>'; } }, 250);
    const res = await linked.get(r.id);
    clearTimeout(slow);
    if (!box.isConnected) return;
    if (!res?.ok) { box.remove(); return; }
    const a = res.article;
    box.hidden = false;
    box.innerHTML = `<div class="r-linked-head"><span class="kicker">The linked article</span><h2 class="r-linked-title">${esc(a.title || res.url)}</h2>${articleByline(a, res.url)}</div>
      <div class="r-text r-article r-linked-body" data-bm="${esc(r.id)}" data-loc="link">${a.cover ? `<img class="r-cover" src="${esc(a.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}${articleBlocks(a.blocks)}</div>
      <button class="r-linked-more" data-linked-more>Continue reading</button>`;
    // The post's own link card says the same thing, less; the article replaces it.
    for (const c of $$('.r-text .r-card', el)) if (c.getAttribute('href') === (r.card?.url || res.url)) c.remove();
    const body = $('.r-linked-body', box);
    markRoot(body, r);
    const long = body.scrollHeight > 1100;
    const keepOpen = openLinked.has(r.id) || highlightsOf(r.id).some(h => h.loc?.part === 'link');
    box.classList.toggle('collapsed', long && !keepOpen);
    $('.r-linked-more', box).hidden = !long || keepOpen;
    $('.r-linked-more', box).addEventListener('click', () => { openLinked.add(r.id); box.classList.remove('collapsed'); $('.r-linked-more', box).hidden = true; });
  })();
}

// docked: the inbox pins tags and the scratchpad in a bar below the post instead.
export function readerContent(r, { docked = false } = {}) {
  if (isDoc(r)) return docContent(r, { docked });
  const o = store.overrides[r.id] || {};
  const f = formatOf(r);
  const title = r.article?.title || '';
  const showMedia = !r.sensitive || prefs.showSensitive;
  const mediaBlock = (media = []) => showMedia && media.length ? `<div class="r-media n${Math.min(media.length, 4)}">${media.map(m => m.video && (m.type === 'video' || m.type === 'gif')
    ? `<video controls playsinline preload="none" poster="${esc(m.url)}" ${m.type === 'gif' ? 'loop muted autoplay' : ''} src="${esc(m.video)}"></video>`
    : `<a href="${esc(img(m.url, 'orig'))}" target="_blank" rel="noopener"><img src="${esc(img(m.url, 'medium'))}" alt="${esc(m.alt || m.description || '')}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>${isFile(r) && media[0]?.description ? `<p class="r-caption">${esc(media[0].description)}</p>` : ''}` : '';
  // A link card; its address is the card's own or the first link of the part it's in. Without one
  // it's shown but isn't a link (a bare "#" would just reload Corpus).
  const card = (c, links = []) => {
    if (!c || !(c.title || c.image)) return '';
    const url = c.url || links.find(l => /^https?:\/\//.test(l) && !/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(l));
    const body = `${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span class="domain">${esc(c.domain || host(c.url))}</span><strong>${esc(c.title || '')}</strong>${c.description ? `<span class="desc">${esc(c.description)}</span>` : ''}`;
    return url ? `<a class="r-card" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${body}</a>` : `<div class="r-card">${body}</div>`;
  };
  // A post's thread parts, article and link card; the quoted post is rendered the same way.
  const postBody = (p) => {
    const parts = p.thread || [{ id: p.id, text: p.text, media: p.media, links: p.links }];
    const focalIndex = p.focalIndex || 0;
    const article = p.article ? `<div class="r-article">${p.article.cover ? `<img class="r-cover" src="${esc(p.article.cover)}" alt="" referrerpolicy="no-referrer">` : ''}${articleBlocks(p.article.blocks)}</div>` : '';
    return `${parts.map((t, i) => `<section class="r-part ${i === focalIndex && parts.length > 1 ? 'focal' : ''}">${parts.length > 1 ? `<span class="r-index">${String(i + 1).padStart(2, '0')}</span>` : ''}${p.article && i === 0 ? article : richText(i === focalIndex && p.card && !p.article ? stripCardUrl(t.text || '', p.card) : t.text)}${mediaBlock(t.media)}${i > 0 ? card(t.card, t.links) : ''}</section>`).join('')}
      ${!p.article ? card(p.card, p.links) : ''}`;
  };
  const q = r.quoted;
  const quoted = q ? `<blockquote class="r-quote${q.thread || q.article ? ' full' : ''}"><div class="byline">${avatar(q.author || {})}<span class="name">${esc(q.author?.name || '')}</span><span class="handle">@${esc(q.author?.handle || '')}</span>${q.thread ? `<span class="q-kind">Thread · ${q.thread.length}</span>` : q.article ? '<span class="q-kind">Article</span>' : ''}${q.id ? `<a class="q-open" href="${esc(q.url || `https://x.com/i/status/${q.id}`)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}</div>${q.article?.title ? `<h2 class="r-title q-title">${esc(q.article.title)}</h2>` : ''}${postBody(q)}</blockquote>` : '';
  const pending = r.enrichment === 'pending';
  return `
    <header class="r-head">${byline(r, false)}<div class="r-meta"><span>${fullDate(r.postedAt)}</span>${formatBadge(r)}${isFile(r) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" download="${esc(r.doc.name)}">Original file ↓</a>` : `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open ${r.provider === 'twitter' ? 'on X' : esc(host(r.url))} ↗</a>`}<span class="r-tools"><button type="button" class="r-edit" data-share-open="${esc(r.id)}" title="Share or copy a link (Shift+S)">Share</button><button type="button" class="r-edit" data-edit-open="${esc(r.id)}" title="Edit (Shift+E)">Edit</button></span></div>
      ${readerMarks(r, { docked })}
      ${title ? `<h1 class="r-title">${esc(title)}</h1>` : ''}
      ${r.provider === 'web' && r.article ? articleByline(r.article, r.url, { open: false }) : ''}</header>
    <div class="r-text" data-bm="${esc(r.id)}">
      ${postBody(r)}
      ${quoted}
      ${pending ? `<p class="r-pending" data-pending="${r.id}">Capturing the full ${f === 'format:article' ? 'article' : 'thread'} from X…</p>` : ''}
    </div>
    ${linksOut(r) ? `<section class="r-linked" data-linked="${esc(r.id)}" hidden></section>` : ''}
    <footer class="r-foot">
      ${readerActions(r)}
      ${highlightsSection(r)}
      ${docked ? '' : `<div class="r-section"><h4>Tags</h4><div class="tag-editor" data-tags="${r.id}">${tagEditor(r)}</div></div>
      <div class="r-section"><h4>Scratchpad</h4><textarea class="scratchpad" data-scratchpad="${r.id}" rows="3" placeholder="Why you saved this, what to try, questions it raises. Agents can write here too.">${esc(o.scratchpad || '')}</textarea></div>`}
      ${isFile(r) ? fileStats(r) : r.provider === 'web' ? `<div class="r-stats"><span>${esc(r.article?.site || host(r.url))}</span><span>Saved ${fullDate(r.capturedAt)}</span></div>` : `<div class="r-stats"><span>${fmt.format(r.engagement.likeCount || 0)} likes</span><span>${fmt.format(r.engagement.repostCount || 0)} reposts</span><span>${fmt.format(r.engagement.bookmarkCount || 0)} saves</span><span class="r-archive" data-archive-status="${r.id}"></span></div>`}
    </footer>`;
}
const fileStats = (r) => `<div class="r-stats"><span>${esc(r.doc.name)}</span><span>${bytes(r.doc.size)}</span><span>Added ${fullDate(r.postedAt)}</span></div>`;
// A book, PDF or text file: a title page with what's known about it, then the document itself
// (mounted by doc-reader.js into .doc-mount), then the usual actions, highlights and notes.
function docContent(r, { docked = false } = {}) {
  const o = store.overrides[r.id] || {};
  const d = r.doc;
  const year = (d.published || '').slice(0, 4);
  const facts = [
    ['Published', d.published ? (d.published.length > 4 ? fullDate(d.published) : d.published) : ''],
    ['Publisher', d.publisher], ['Language', d.language && (new Intl.DisplayNames(['en'], { type: 'language' }).of(d.language.split(/[-_]/)[0]) || d.language)], ['ISBN', d.isbn],
    ['Length', [d.pages ? `${num.format(d.pages)} pages` : '', d.words ? `${num.format(d.words)} words` : '', readTime(minutes(r))].filter(Boolean).join(' · ')]
  ].filter(([, v]) => v);
  const p = progressOf(r);
  return `
    <header class="r-head doc-head">
      <div class="doc-card">
        ${d.cover ? `<img class="doc-cover" src="${esc(d.cover)}" alt="Cover">` : `<div class="doc-cover blank"><span>${esc(KIND_NAME[d.kind])}</span></div>`}
        <div class="doc-info">
          <span class="kicker">${esc(label(formatOf(r)))} · ${esc(KIND_NAME[d.kind])}${year ? ` · ${esc(year)}` : ''}</span>
          <h1 class="r-title">${esc(r.title)}</h1>
          ${d.authors?.length ? `<p class="doc-authors">${esc(d.authors.join(', '))}</p>` : ''}
          ${facts.length ? `<dl class="doc-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
          ${p > 0.005 ? `<div class="doc-progress-line"><span class="tile-progress"><i style="--p:${p}"></i></span><span class="muted small">${Math.round(p * 100)}% read</span></div>` : ''}
        </div>
      </div>
      ${d.description ? `<p class="doc-desc">${esc(d.description)}</p>` : ''}
      ${d.subjects?.length ? `<div class="doc-subjects">${d.subjects.slice(0, 10).map(x => `<span class="pill">${esc(x)}</span>`).join('')}</div>` : ''}
      <div class="r-meta">${formatBadge(r)}<a href="${esc(r.url)}" target="_blank" rel="noopener" download="${esc(d.name)}">Original file ↓</a><span class="r-tools"><button type="button" class="r-edit" data-share-open="${esc(r.id)}" title="Share or copy a link (Shift+S)">Share</button><button type="button" class="r-edit" data-edit-open="${esc(r.id)}" title="Edit (Shift+E)">Edit</button></span></div>
      ${readerMarks(r, { docked })}
    </header>
    <div class="doc-mount" data-doc="${esc(r.id)}"></div>
    <footer class="r-foot">
      ${readerActions(r)}
      ${highlightsSection(r)}
      ${docked ? '' : `<div class="r-section"><h4>Tags</h4><div class="tag-editor" data-tags="${r.id}">${tagEditor(r)}</div></div>
      <div class="r-section"><h4>Scratchpad</h4><textarea class="scratchpad" data-scratchpad="${r.id}" rows="3" placeholder="Why you saved this, what to try, questions it raises. Agents can write here too.">${esc(o.scratchpad || '')}</textarea></div>`}
      ${fileStats(r)}
    </footer>`;
}
// Tags Jev thought this file deserves that aren't in the taxonomy yet: one click adds the topic and tags it.
function suggestedTags(r) {
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').replace(/s$/, '');
  const have = new Set(tagIds(r).map(id => norm(label(id))));
  return (r.suggested || []).filter(x => !have.has(norm(x.label)) && !(store.overrides[r.id]?.dismissed || []).includes(x.label));
}
function suggestedHtml(r) {
  const list = suggestedTags(r);
  if (!list.length) return '';
  return `<span class="suggested"><span class="sug-label" title="Jev read this and thinks these would be useful new topics">Suggested</span>${list.map(x => `<span class="sug"><button type="button" data-suggest="${esc(x.label)}" data-parent="${esc(x.parent || '')}" title="${esc(`New topic${x.parent ? ` under ${label(x.parent)}` : ''} · ${Math.round(x.score * 100)}% fit`)}">+ ${esc(x.label)}${x.parent ? `<span class="sug-in">${esc(label(x.parent))}</span>` : ''}</button><button type="button" class="sug-x" data-dismiss-suggest="${esc(x.label)}" aria-label="Dismiss" title="Not this one">×</button></span>`).join('')}</span>`;
}
function stripCardUrl(text, card) {
  const target = card.url ? card.url.replace(/\/$/, '') : null;
  return text.replace(/\s*(https?:\/\/\S+)\s*$/, (m, u) => (!target || u.replace(/\/$/, '') === target || host(u) === card.domain) ? '' : m);
}
export const ICON = {
  stack: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="fill" d="M2.5 5.6 8 3l5.5 2.6L8 8.2z"/><path d="M2.5 8.4 8 11l5.5-2.6M2.5 11.2 8 13.8l5.5-2.6"/></svg>',
  read: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="fill" cx="8" cy="8" r="5.75"/><path class="tick" d="m5.5 8.2 1.8 1.8 3.3-3.6"/></svg>',
  keep: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.3 11.2 12.5 4.5"/></svg>',
  archive: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M3.5 4.5v8a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-8M6.5 8h3"/></svg>',
  skip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3.5v9l6-4.5-6-4.5zM11.5 3.5v9"/></svg>',
  delete: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M6.7 7.2v4M9.3 7.2v4"/></svg>',
  ask: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1H8l-3 2.7V10H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/></svg>',
  pad: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3-7.3 7.3-3.6.9.9-3.6z"/><path d="M9.3 3.7l3 3"/></svg>',
  restore: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3 2 6l3 3"/><path d="M2 6h7a4 4 0 1 1 0 8H7"/></svg>'
};
// Stack and read state sit under the byline, where the decision to read gets made.
function readerMarks(r, { docked = false } = {}) {
  const o = store.overrides[r.id] || {};
  if (o.deleted) return '';
  const pos = o.stackedAt ? stackList().findIndex(x => x.id === r.id) + 1 : 0;
  const hint = (k) => docked ? '' : keyHint(k);
  return `<div class="r-marks">
      <button class="mark" data-stack="${r.id}" aria-pressed="${!!o.stackedAt}">${ICON.stack}<span>${o.stackedAt ? `On the stack${pos ? ` · ${pos} of ${STACK_MAX}` : ''}` : 'Add to stack'}</span>${hint('reader.stack')}</button>
      <button class="mark" data-mark-read="${r.id}" aria-pressed="${!!o.read}">${ICON.read}<span>${o.read ? `Read ${readWhen(o.readAt)}` : 'Mark as read'}</span>${!o.read && o.readAt ? `<span class="mark-note">last read ${readWhen(o.readAt)}</span>` : ''}${hint('reader.done')}</button>
    </div>`;
}
function readerActions(r) {
  const o = store.overrides[r.id] || {};
  if (o.deleted) return `<div class="r-actions"><button class="primary" data-act="restore">Restore</button><span class="muted small">In Trash · deleted for good in ${daysLeft(r)} days</span></div>`;
  const t = o.triaged;
  return `<div class="r-actions">
    <button class="${o.read ? 'ghost' : 'primary'} done" data-mark-read="${r.id}" aria-pressed="${!!o.read}">${o.read ? `Read ${readWhen(o.readAt)}` : 'Done reading'}${keyHint('reader.done')}</button>
    <button class="ghost" data-act="kept" aria-pressed="${t === 'kept'}">${t === 'kept' ? 'Kept' : 'Keep'}${keyHint('reader.keep')}</button>
    <button class="ghost" data-act="archived" aria-pressed="${t === 'archived'}">${t === 'archived' ? 'Archived' : 'Archive'}${keyHint('reader.archive')}</button>
    <button class="ghost danger" data-act="deleted">Delete${keyHint('reader.delete')}</button>
  </div>`;
}
function articleBlocks(blocks = []) {
  let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const b of blocks) {
    if (b.type === 'li' || b.type === 'oli') { const tag = b.type === 'li' ? 'ul' : 'ol'; if (list !== tag) { close(); html += `<${tag}>`; list = tag; } html += `<li>${esc(b.text)}</li>`; continue; }
    close();
    if (b.type === 'image') html += `<img src="${esc(b.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    else if (b.type === 'divider') html += '<hr>';
    else if (b.type === 'code') html += `<pre><code>${esc(b.text)}</code></pre>`;
    else if (b.type === 'quote') html += `<blockquote>${esc(b.text)}</blockquote>`;
    else if (b.type === 'caption') html += `<p class="r-figcap">${esc(b.text)}</p>`;
    else if (/^h\d$/.test(b.type)) html += `<${b.type}>${esc(b.text)}</${b.type}>`;
    else html += `<p>${esc(b.text).replace(/\n/g, '<br>')}</p>`;
  }
  close();
  return html;
}
export function tagEditor(r) {
  const tags = tagsOf(r).filter(t => !['source'].includes(facetOf(t.id)));
  const order = ['format', 'topic', 'kind', 'label', 'contains'];
  tags.sort((a, b) => order.indexOf(facetOf(a.id)) - order.indexOf(facetOf(b.id)));
  return `${tags.map(t => `<span class="tag f-${facetOf(t.id)} ${t.by === 'you' ? 'mine' : ''}" title="${esc(`${store.facets.find(f => f.id === facetOf(t.id))?.label || ''} · ${t.by}`)}">${esc(ancestors(t.id).length ? `${label(ancestors(t.id)[0])} / ${label(t.id)}` : label(t.id))}<button data-untag="${esc(t.id)}" aria-label="Remove">×</button></span>`).join('')}
    <span class="tag-add"><input data-tag-input placeholder="Add tag…" autocomplete="off"><div class="suggest" hidden></div></span>${suggestedHtml(r)}`;
}
// Everything that shows a post in the reader or the inbox goes through here.
// A scratchpad is as tall as its text (CSS sets the minimum and maximum), so it reads in full.
export function fitScratchpad(ta) {
  if (!ta.offsetParent) return; // hidden: measured when shown
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
}
export const fitScratchpads = (root = document) => $$('textarea[data-scratchpad]', root).forEach(fitScratchpad);
export function paintReader(el, r, opts) {
  if (!el) return;
  // An edit in progress isn't redrawn under you (tagging, a rebuild); saving or cancelling redraws it.
  if (el.querySelector(':scope > .edit-form')) return;
  const doc = el.querySelector('.doc-mount')?._doc;
  if (doc && doc.id === r.id && doc.el.isConnected) {
    // An open book or PDF stays open, where you were; only what's around it is redrawn.
    const t = document.createElement('template');
    t.innerHTML = readerContent(r, opts);
    for (const part of ['.r-head', '.r-foot']) { const next = t.content.querySelector(part); if (next) el.querySelector(part)?.replaceWith(next); }
    doc.remark();
    requestAnimationFrame(() => fitScratchpads(el));
    return;
  }
  el.innerHTML = readerContent(r, opts);
  afterPaint(el, r);
}
// After a post is drawn: highlights, archived images, and for a book or PDF, the document itself.
export function afterPaint(el, r) {
  if (!el) return;
  requestAnimationFrame(() => fitScratchpads(el));
  markHighlights(el, r);
  loadLinked(el, r);
  archivedPosters(el);
  archiveStatus(r);
  const mount = $('.doc-mount', el);
  if (mount && isDoc(r)) mountDoc(mount, r, docHooks(r, el));
}
function docHooks(r, el) {
  return {
    pos: store.overrides[r.id]?.pos || null,
    mark: (root) => markRoot(root, r),
    // Your place, saved quietly (not an undoable change).
    save: (pos, progress) => {
      const cur = store.overrides[r.id]?.pos;
      if (!store.byId.has(r.id) || (cur && cur.ch === pos.ch && cur.page === pos.page && Math.abs((cur.f || 0) - (pos.f || 0)) < 0.01)) return;
      saveOverride([r.id], { pos, progress }, { undoable: false });
    },
    cover: (blob) => uploadCover(r, blob),
    notes: () => highlightsOf(r.id).map(h => ({ id: h.id, loc: h.loc, text: h.quote || h.text, note: h.note })),
    jump: (hid) => jumpToHighlight(el, hid)
  };
}
// The document open in front of you: in the reader dialog, else in the reader view.
export const currentDoc = () => (!$('#reader').hidden ? $('#reader-body .doc-mount') : $('#triage-body .doc-mount'))?._doc || null;
// Re-render wherever this bookmark is showing: the reader, the inbox's triage pane, or the library.
export function repaintBookmark(id) {
  const r = store.byId.get(id);
  if (!r) return;
  const readerOpen = !$('#reader').hidden;
  if (readerOpen && ui.readerId === id) paintReader($('#reader-body'), r);
  if (inQueue() && ui.inboxId === id && $('#triage-body')) { paintReader($('#triage-body'), r, { docked: true }); paintDock(); }
  else if (ui.view === 'library' && !readerOpen) refreshCards();
}
