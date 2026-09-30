// Adding to Corpus: files (images, PDFs, books, text) and links (read as articles), one item
// at a time with its progress reported back; then Jev tags each one in the background. The Add
// dialog (views/add-dialog.js) shows it all; dropping or pasting anywhere opens that dialog.
import { updateInboxCount } from '../app/router.js';
import { $, $$, sleep } from '../core/dom.js';
import { store, ui } from '../core/state.js';
import { api, label, loadAll } from '../data/library.js';
import { rerenderTags } from './tags.js';
import { inQueue } from '../views/dialog.js';
import { refreshCards } from '../views/library.js';
import { repaintBookmark } from '../views/post.js';
import { refreshQueue, renderInbox } from '../views/reader/index.js';
import { openAddDialog } from '../views/add-dialog.js';
import { pdfCover } from './doc-reader.js';

export const ACCEPT = '.pdf,.epub,.mobi,.azw,.azw3,.txt,.md,.markdown,.html,.htm,image/*';
// http(s) links in pasted text, one per line or separated by spaces.
export const linksIn = (text) => [...new Set((String(text || '').match(/https?:\/\/[^\s<>"']+/g) || []).map(u => u.replace(/[),.;]+$/, '')))];

// status(text) is called as the item progresses; resolves to the server's answer (id, title, kind, job…).
export async function addFile(file, status = () => {}) {
  status('Uploading and reading…');
  const res = await fetch('/api/files', { method: 'POST', headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' }, body: file });
  if (res.status === 401) { location.reload(); throw new Error('Signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || `Error ${res.status}`);
  // A PDF's cover is its first page, drawn here: the server has no canvas.
  if (json.kind === 'pdf' && !json.duplicate) pdfCover(await file.arrayBuffer()).then(b => b && uploadCover(json.id, b)).catch(() => {});
  return json;
}
export async function addLink(url, status = () => {}) {
  status('Reading the page…');
  const { result } = await api('/api/ops', { method: 'POST', body: { tool: 'create_bookmark', args: { url } } });
  return result;
}
// Poll a tagging job until it's finished (or a few minutes pass).
export async function waitForJob(job) {
  for (let i = 0; i < 60; i++) {
    await sleep(i < 6 ? 1500 : 3000);
    const j = (await api('/api/ops', { method: 'POST', body: { tool: 'get_job', args: { id: job } } }).catch(() => null))?.result;
    if (j?.status && j.status !== 'running') return j;
  }
  return { status: 'failed', error: 'Still tagging; check back soon' };
}
export const tagSummary = (j) => {
  const tags = (j.tags || []).filter(id => store.conceptById.has(id) && /^(topic|kind):/.test(id)).slice(0, 3).map(label);
  return `${tags.length ? `Tagged: ${tags.join(', ')}` : 'Tagged'}${j.suggested?.length ? ` · ${j.suggested.length} new topic${j.suggested.length === 1 ? '' : 's'} suggested` : ''}`;
};

// After something was added: reload the library and redraw whatever is showing.
export async function refreshAfterAdd(ids = []) {
  await loadAll(); updateInboxCount();
  if (!$('#reader').hidden) { if (ids.includes(ui.readerId)) repaintBookmark(ui.readerId); return; }
  if (ui.view === 'library') refreshCards();
  else if (ui.view === 'inbox' && !ui.inboxId) renderInbox();
  else if (inQueue()) { refreshQueue(); const cur = store.byId.get(ui.inboxId); if (cur && ids.includes(cur.id)) rerenderTags(cur); }
}

export async function uploadCover(target, blob) {
  const id = typeof target === 'string' ? target : target.id;
  const res = await fetch(`/api/files/${id}/cover`, { method: 'PUT', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob }).then(r => r.ok ? r.json() : null).catch(() => null);
  const r = store.byId.get(id);
  if (res?.cover && r?.doc) {
    r.doc.cover = res.cover;
    for (const el of $$(`[data-doc="${id}"]`)) el.closest('.reader-body')?.querySelector('.doc-cover.blank')?.replaceWith(Object.assign(document.createElement('img'), { className: 'doc-cover', src: res.cover, alt: 'Cover' }));
    for (const el of $$(`[data-add-thumb="${id}"]`)) el.innerHTML = `<img src="${res.cover}" alt="">`;
    if (ui.view === 'library' && $('#reader').hidden) refreshCards();
  }
}

// Drop anywhere: files, or a link dragged in from another tab.
let dragDepth = 0, draggingInside = false;
const dropKind = (e) => { const types = [...(e.dataTransfer?.types || [])]; return types.includes('Files') ? 'files' : !draggingInside && types.includes('text/uri-list') ? 'link' : null; };
function showDrop(kind) {
  let el = $('#drop');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div id="drop" class="drop-zone" hidden><div class="drop-box"><p class="serif"></p><p class="muted small"></p></div></div>'); el = $('#drop'); }
  if (kind) {
    $('.serif', el).textContent = kind === 'link' ? 'Drop to save this link' : 'Drop to add to Corpus';
    $('.muted', el).textContent = kind === 'link' ? 'The page is read as an article and tagged. Links to PDFs and books are added as files.' : 'Images, PDFs, EPUB and MOBI books, text and Markdown. Each lands in your inbox, and Jev tags it.';
  }
  el.hidden = !kind;
}
// Pasted images have no useful name: give them one with the time.
const named = (f) => f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type });

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupUploads() {
  document.addEventListener('dragstart', () => { draggingInside = true; });
  document.addEventListener('dragend', () => { draggingInside = false; });
  window.addEventListener('dragenter', (e) => { const k = dropKind(e); if (!k || $('#add')) return; e.preventDefault(); dragDepth++; showDrop(k); });
  window.addEventListener('dragover', (e) => { if (!dropKind(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!dropKind(e) || $('#add')) return; if (--dragDepth <= 0) { dragDepth = 0; showDrop(null); } });
  window.addEventListener('drop', (e) => {
    const k = dropKind(e);
    dragDepth = 0; showDrop(null);
    if (!k) return;
    e.preventDefault();
    // The open dialog takes its own drops.
    if (e.target.closest?.('#add')) return;
    if (k === 'files') openAddDialog({ files: [...e.dataTransfer.files] });
    else openAddDialog({ links: linksIn(e.dataTransfer.getData('text/uri-list')) });
  });
  // Paste a screenshot or a file anywhere, or a link outside a text box.
  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('#add')) return;
    const files = [...(e.clipboardData?.files || [])];
    const inField = e.target.matches?.('input, textarea, [contenteditable]');
    if (files.length && (!inField || files.some(f => f.type.startsWith('image/')))) { e.preventDefault(); openAddDialog({ files: files.map(named) }); return; }
    const links = inField ? [] : linksIn(e.clipboardData?.getData('text'));
    if (links.length) { e.preventDefault(); openAddDialog({ links }); }
  });
}
