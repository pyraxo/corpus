// The Add dialog: drop files or choose them, or paste links; each item shows its progress
// (uploading, reading the page, tagging) and then what it became, with Open.
import { $, esc, num } from '../core/dom.js';
import { store } from '../core/state.js';
import { KIND_NAME, fileLine, readTime } from '../data/library.js';
import { ACCEPT, addFile, addLink, linksIn, refreshAfterAdd, tagSummary, waitForJob } from '../features/uploads.js';
import { host } from '../ui/format.js';
import { openBookmark } from './dialog.js';

const items = [];
let keyHandler = null;

const ICON = {
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M7 4.8l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.2l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2zm0 0v4h4"/></svg>'
};

export function openAddDialog({ files = [], links = [] } = {}) {
  if (!$('#add')) {
    document.body.insertAdjacentHTML('beforeend', `<div id="add" class="overlay add-overlay">
      <div class="overlay-scrim" data-add-close></div>
      <div class="add-box" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <header class="add-head"><h2 class="serif" id="add-title">Add to Corpus</h2><button class="x" data-add-close aria-label="Close" title="Close (esc)">×</button></header>
        <button type="button" class="add-drop" data-add-pick>
          <span class="add-drop-icon">${ICON.upload}</span>
          <span class="add-drop-text"><strong>Drop files here</strong> or <u>choose files</u></span>
          <span class="add-kinds">Images · PDF · EPUB · MOBI · Text and Markdown</span>
        </button>
        <div class="add-or" aria-hidden="true"><span>or add a link</span></div>
        <form class="add-link" data-add-link>
          <span class="add-link-icon">${ICON.link}</span>
          <input type="text" inputmode="url" name="url" placeholder="Paste a link: an article, a post, a PDF…" autocomplete="off" spellcheck="false" aria-label="Link">
          <button class="primary" type="submit">Add</button>
        </form>
        <p class="add-hint muted small">Pages are read as articles, with their title, author, date and text. Links to PDFs and books are added as files.</p>
        <ol class="add-items" aria-live="polite"></ol>
        <footer class="add-foot"><span class="muted small">Everything you add goes to the inbox, and Jev tags it.</span><button class="ghost small-btn" data-add-reader hidden>Open in Reader</button></footer>
      </div>
    </div>`);
    const el = $('#add');
    el.addEventListener('click', onClick);
    el.addEventListener('submit', (e) => { e.preventDefault(); const input = $('input', e.target); addLinks(linksIn(input.value), input); });
    // Pasting a link starts right away; so does pasting several.
    el.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); addFiles(files); return; }
      const input = e.target.closest('[data-add-link] input');
      const links = linksIn(e.clipboardData?.getData('text'));
      if (input && links.length) { e.preventDefault(); addLinks(links, input); }
    });
    const drop = $('.add-drop', el);
    el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); drop.classList.add('over'); } });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) drop.classList.remove('over'); });
    el.addEventListener('drop', (e) => {
      drop.classList.remove('over');
      e.preventDefault();
      if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
      else addLinks(linksIn(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text')));
    });
    keyHandler = (e) => { if (e.key === 'Escape' && $('#add')) { e.preventDefault(); e.stopPropagation(); closeAddDialog(); } };
    document.addEventListener('keydown', keyHandler, true);
    document.body.classList.add('locked');
  }
  paint();
  if (files.length) addFiles(files);
  if (links.length) addLinks(links);
  if (!files.length && !links.length) requestAnimationFrame(() => $('#add input')?.focus());
}

export function closeAddDialog() {
  $('#add')?.remove();
  document.removeEventListener('keydown', keyHandler, true);
  document.body.classList.remove('locked');
  // Finished items don't come back next time; ones still working do.
  for (let i = items.length - 1; i >= 0; i--) if (items[i].state !== 'working') items.splice(i, 1);
}

function onClick(e) {
  const t = e.target.closest('[data-add-close], [data-add-pick], [data-add-open], [data-add-reader]');
  if (!t) return;
  if (t.dataset.addClose !== undefined) closeAddDialog();
  else if (t.dataset.addPick !== undefined) {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: ACCEPT });
    input.addEventListener('change', () => addFiles([...input.files]));
    input.click();
  } else if (t.dataset.addOpen) { const list = done(); closeAddDialog(); openBookmark(t.dataset.addOpen, list, 'Just added'); }
  else if (t.dataset.addReader !== undefined) { const list = done(); closeAddDialog(); if (list[0]) openBookmark(list[0].id, list, 'Just added'); }
}
const done = () => items.filter(i => i.id && i.state !== 'error').map(i => store.byId.get(i.id)).filter(Boolean);

function addFiles(files) { for (const f of files.filter(f => f.size > 0)) run({ kind: 'file', name: f.name, file: f }); }
function addLinks(links, input) {
  if (!links.length) { if (input?.value.trim()) paintHint('That doesn’t look like a link (it should start with http:// or https://)'); return; }
  if (input) input.value = '';
  for (const url of links) if (!items.some(i => i.url === url && i.state !== 'error')) run({ kind: 'link', name: host(url) || url, url });
}
function paintHint(text) { const h = $('#add .add-hint'); if (h) { h.textContent = text; h.classList.add('warn'); } }

async function run(item) {
  Object.assign(item, { key: Math.random().toString(36).slice(2), state: 'working', status: '' });
  items.unshift(item);
  const status = (s) => { item.status = s; paint(); };
  try {
    const res = item.kind === 'file' ? await addFile(item.file, status) : await addLink(item.url, status);
    Object.assign(item, { id: res.id, title: res.title, duplicate: !!res.duplicate });
    await refreshAfterAdd([res.id]);
    item.state = res.duplicate ? 'duplicate' : 'done';
    item.status = res.duplicate ? 'Already in Corpus' : res.parseFailed ? 'Couldn’t read the page — saved as a link; open it to upload as-is' : describe(res);
    paint();
    if (res.job && !res.duplicate) {
      item.status = `${describe(res)} · Jev is tagging…`; paint();
      const j = await waitForJob(res.job);
      await refreshAfterAdd([res.id]);
      item.status = `${describe(res)} · ${j.status === 'done' ? tagSummary(j) : `tagging failed: ${j.error || 'unknown error'}`}`;
      paint();
    }
  } catch (e) { Object.assign(item, { state: 'error', status: e.message }); paint(); }
}
// What an item became: "Article · 1,309 words · 7 min", "PDF · 15 pages", "Page".
function describe(res) {
  const r = store.byId.get(res.id);
  if (r?.doc) return [KIND_NAME[r.doc.kind], fileLine(r).split(' · ').slice(1).join(' · ')].filter(Boolean).join(' · ');
  if (res.kind === 'web' || r?.provider === 'web') return res.isArticle ? `Article · ${num.format(res.words)} words · ${readTime(Math.max(1, Math.round(res.words / 230)))}` : 'Page saved';
  return 'Added';
}
function thumb(item) {
  const r = item.id && store.byId.get(item.id);
  const src = r?.doc?.cover || (r?.doc?.kind === 'image' && r.media?.[0]?.url) || r?.article?.cover || r?.card?.image;
  if (src) return `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  if (item.kind === 'link') return `<img class="fav" src="https://www.google.com/s2/favicons?domain=${esc(host(item.url))}&sz=64" alt="" referrerpolicy="no-referrer">`;
  return ICON.file;
}
function paint() {
  const list = $('#add .add-items');
  if (!list) return;
  list.innerHTML = items.map(i => `<li class="add-item" data-state="${i.state}">
      <span class="add-thumb" ${i.id ? `data-add-thumb="${esc(i.id)}"` : ''}>${thumb(i)}</span>
      <span class="add-what"><strong>${esc(i.title || i.name)}</strong><span class="add-status">${i.state === 'working' ? '<i class="spin"></i>' : ''}${esc(i.status)}</span></span>
      ${i.id && i.state !== 'error' ? `<button class="ghost small-btn" data-add-open="${esc(i.id)}">Open</button>` : ''}
    </li>`).join('');
  const reader = $('#add [data-add-reader]');
  if (reader) reader.hidden = done().length < 2;
}
