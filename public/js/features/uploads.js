// Adding files: drop, paste or pick images, PDFs, books and text; then Jev tags them.
import { updateInboxCount } from '../app/router.js';
import { $, $$, sleep } from '../core/dom.js';
import { store, ui } from '../core/state.js';
import { api, label, loadAll } from '../data/library.js';
import { rerenderTags } from './tags.js';
import { host, shortTitle } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { inQueue, openBookmark } from '../views/dialog.js';
import { refreshCards } from '../views/library.js';
import { repaintBookmark } from '../views/post.js';
import { refreshQueue, renderInbox } from '../views/reader/index.js';
import { pdfCover } from './doc-reader.js';

// Each is saved on the server, read (chapters, pages, metadata, cover), added to the library
// and the inbox, then tagged by Jev in the background, which may also suggest new topics.
const ACCEPT = '.pdf,.epub,.mobi,.azw,.azw3,.txt,.md,.markdown,.html,.htm,image/*';
export function pickFiles() {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: ACCEPT });
  input.addEventListener('change', () => uploadFiles([...input.files]));
  input.click();
}
async function uploadFiles(files) {
  files = files.filter(f => f.size > 0);
  if (!files.length) return;
  const added = [];
  for (const [i, f] of files.entries()) {
    toast(`Adding ${files.length > 1 ? `${i + 1} of ${files.length} · ` : ''}${f.name}…`, { sticky: true });
    try {
      const res = await fetch('/api/files', { method: 'POST', headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' }, body: f });
      if (res.status === 401) { location.reload(); return; }
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Error ${res.status}`);
      added.push({ ...json, file: f });
    } catch (e) { toast(`${f.name}: ${e.message}`, { sticky: true }); await sleep(3500); }
  }
  if (!added.length) return;
  await loadAll(); updateInboxCount();
  refreshAfterAdd(added);
  const fresh = added.filter(a => !a.duplicate);
  const first = added[0];
  const open = { label: 'Open', run: () => openBookmark(first.id, added.map(a => store.byId.get(a.id)).filter(Boolean), 'Just added') };
  if (!fresh.length) toast(added.length === 1 ? `Already in Corpus: “${first.title}”` : `All ${added.length} were already in Corpus`, { action: open });
  else toast(fresh.length === 1 ? `Added “${fresh[0].title}”${fresh[0].job ? ' · Jev is tagging it…' : ''}` : `Added ${fresh.length} files${fresh.some(a => a.job) ? ' · Jev is tagging them…' : ''}`, { action: open });
  // A PDF's cover is its first page, drawn here: the server has no canvas.
  for (const a of fresh) if (a.kind === 'pdf') pdfCover(await a.file.arrayBuffer()).then(b => b && uploadCover(a.id, b)).catch(() => {});
  watchTagging(fresh.filter(a => a.job));
}
function refreshAfterAdd(added) {
  if (!$('#reader').hidden) return;
  if (ui.view === 'library') refreshCards();
  else if (ui.view === 'inbox' && !ui.inboxId) renderInbox();
  else if (inQueue()) { refreshQueue(); const cur = store.byId.get(ui.inboxId); if (cur && added.some(a => a.id === cur.id)) rerenderTags(cur); }
}
async function watchTagging(list) {
  if (!list.length) return;
  for (let i = 0; i < 40 && list.some(a => !a.state); i++) {
    await sleep(i < 6 ? 1500 : 3000);
    for (const a of list.filter(x => !x.state)) {
      const j = (await api('/api/ops', { method: 'POST', body: { tool: 'get_job', args: { id: a.job } } }).catch(() => null))?.result;
      if (j?.status && j.status !== 'running') a.state = j;
    }
  }
  await loadAll(); updateInboxCount();
  refreshAfterAdd(list);
  if (!$('#reader').hidden && list.some(a => a.id === ui.readerId)) repaintBookmark(ui.readerId);
  const done = list.filter(a => a.state?.status === 'done');
  if (list.length === 1 && done.length) {
    const r = store.byId.get(done[0].id), s = done[0].state;
    const tags = (s.tags || []).filter(id => store.conceptById.has(id) && /^(topic|kind):/.test(id)).slice(0, 3).map(label);
    toast(`Tagged “${shortTitle(r || { title: done[0].title })}”${tags.length ? `: ${tags.join(', ')}` : ''}${s.suggested?.length ? ` · ${s.suggested.length} new topic${s.suggested.length === 1 ? '' : 's'} suggested` : ''}`, { action: { label: 'Open', run: () => openBookmark(done[0].id, [r].filter(Boolean), 'Just added') } });
  } else if (done.length) toast(`Jev tagged ${done.length} new file${done.length === 1 ? '' : 's'}`);
  else if (list.some(a => a.state?.status === 'failed')) toast(`Tagging failed: ${list.find(a => a.state?.status === 'failed').state.error || 'unknown error'}`);
}
export async function uploadCover(target, blob) {
  const id = typeof target === 'string' ? target : target.id;
  const res = await fetch(`/api/files/${id}/cover`, { method: 'PUT', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob }).then(r => r.ok ? r.json() : null).catch(() => null);
  const r = store.byId.get(id);
  if (res?.cover && r?.doc) {
    r.doc.cover = res.cover;
    for (const el of $$(`[data-doc="${id}"]`)) el.closest('.reader-body')?.querySelector('.doc-cover.blank')?.replaceWith(Object.assign(document.createElement('img'), { className: 'doc-cover', src: res.cover, alt: 'Cover' }));
    if (ui.view === 'library' && $('#reader').hidden) refreshCards();
  }
}
// Drop anywhere: files, or a link dragged in from another tab (saved like any web page).
let dragDepth = 0, draggingInside = false;
const dropKind = (e) => { const types = [...(e.dataTransfer?.types || [])]; return types.includes('Files') ? 'files' : !draggingInside && types.includes('text/uri-list') ? 'link' : null; };
function showDrop(kind) {
  let el = $('#drop');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div id="drop" class="drop-zone" hidden><div class="drop-box"><p class="serif"></p><p class="muted small"></p></div></div>'); el = $('#drop'); }
  if (kind) {
    $('.serif', el).textContent = kind === 'link' ? 'Drop to save this link' : 'Drop to add to Corpus';
    $('.muted', el).textContent = kind === 'link' ? 'Its page is saved and tagged, like any bookmark. Links to PDFs and books are added as files.' : 'Images, PDFs, EPUB and MOBI books, text and Markdown. Each lands in your inbox, and Jev tags it.';
  }
  el.hidden = !kind;
}

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupUploads() {
  document.addEventListener('dragstart', () => { draggingInside = true; });
  document.addEventListener('dragend', () => { draggingInside = false; });
  window.addEventListener('dragenter', (e) => { const k = dropKind(e); if (!k) return; e.preventDefault(); dragDepth++; showDrop(k); });
  window.addEventListener('dragover', (e) => { if (!dropKind(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!dropKind(e)) return; if (--dragDepth <= 0) { dragDepth = 0; showDrop(null); } });
  window.addEventListener('drop', async (e) => {
    const k = dropKind(e);
    dragDepth = 0; showDrop(null);
    if (!k) return;
    e.preventDefault();
    if (k === 'files') { uploadFiles([...e.dataTransfer.files]); return; }
    const url = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).find(l => /^https?:\/\//.test(l));
    if (!url) return;
    toast(`Saving ${host(url)}…`, { sticky: true });
    try {
      const { result } = await api('/api/ops', { method: 'POST', body: { tool: 'create_bookmark', args: { url } } });
      await loadAll(); updateInboxCount(); refreshAfterAdd([{ id: result.id }]);
      toast(result.summary || 'Saved', { action: { label: 'Open', run: () => openBookmark(result.id, [store.byId.get(result.id)].filter(Boolean), 'Just added') } });
      if (result.job) watchTagging([{ id: result.id, job: result.job, title: result.title }]);
    } catch (err) { toast(err.message); }
  });
  // Paste an image (a screenshot) or a file anywhere outside a text box.
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || (e.target.matches?.('input, textarea, [contenteditable]') && !files.some(f => f.type.startsWith('image/')))) return;
    e.preventDefault();
    uploadFiles(files.map(f => f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
  });
}
