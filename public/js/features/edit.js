// Editing an entry in the reader. Links you saved: everything, from the title and byline to the
// article itself, edited in place (a toolbar changes or removes the block you're in). Files: the
// title page (title, authors, publisher, date, description). Posts from X: their title.
import { $, $$, esc } from '../core/dom.js';
import { store, ui } from '../core/state.js';
import { api, loadAll } from '../data/library.js';
import { capsOf } from '../app/keymap.js';
import { toast } from '../ui/toast.js';
import { refreshQueue } from '../views/reader/index.js';
import { inQueue } from '../views/dialog.js';
import { paintReader } from '../views/post.js';

// Tag for each kind of block while editing, and back.
const TAG = { p: 'p', h2: 'h2', h3: 'h3', h4: 'h4', li: 'p', oli: 'p', quote: 'blockquote', code: 'pre', caption: 'p' };
const TYPE_OF_TAG = { P: 'p', DIV: 'p', H1: 'h2', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4', BLOCKQUOTE: 'quote', PRE: 'code' };
const TOOLS = [['p', 'Text'], ['h2', 'Heading'], ['h3', 'Subheading'], ['quote', 'Quote'], ['li', '• List'], ['oli', '1. List'], ['code', 'Code']];

const blockHtml = (b) => {
  if (b.type === 'image') return `<figure data-b="image" data-url="${esc(b.url)}" contenteditable="false"><img src="${esc(b.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><button type="button" class="b-x" data-edit-drop aria-label="Remove image" title="Remove image">×</button></figure>`;
  if (b.type === 'divider') return `<div data-b="divider" class="b-divider" contenteditable="false"><hr><button type="button" class="b-x" data-edit-drop aria-label="Remove divider" title="Remove divider">×</button></div>`;
  const tag = TAG[b.type] || 'p';
  return `<${tag} data-b="${b.type}"${b.type === 'caption' ? ' class="r-figcap"' : ''}>${esc(b.text || '').replace(/\n/g, '<br>')}</${tag}>`;
};
// The editor's contents as blocks again. Whatever the browser made of Enter and Backspace
// (new paragraphs, merged ones, stray divs and lists) comes back as plain blocks.
function readBlocks(body) {
  const out = [];
  const add = (el) => {
    const type = el.dataset?.b || TYPE_OF_TAG[el.tagName] || 'p';
    if (type === 'image') { if (el.dataset.url) out.push({ type: 'image', url: el.dataset.url }); return; }
    if (type === 'divider') { out.push({ type: 'divider' }); return; }
    if (el.tagName === 'UL' || el.tagName === 'OL') { for (const li of el.children) out.push({ type: el.tagName === 'UL' ? 'li' : 'oli', text: li.innerText.trim() }); return; }
    const text = type === 'code' ? el.innerText.replace(/\s+$/, '') : el.innerText.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (text) out.push({ type, text });
  };
  for (const n of body.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { if (n.nodeValue.trim()) out.push({ type: 'p', text: n.nodeValue.trim() }); }
    else if (n.nodeType === Node.ELEMENT_NODE) add(n);
  }
  return out;
}

export const isEditing = (el) => !!el?.querySelector(':scope > .edit-form');
// The reader body showing this bookmark: the dialog's, or the reader view's.
export const bodyFor = (id) => (!$('#reader').hidden && ui.readerId === id ? $('#reader-body') : ui.inboxId === id && inQueue() ? $('#triage-body') : null);

export function startEdit(el, r) {
  if (!el || !r || isEditing(el)) return;
  const kind = r.provider === 'web' ? 'web' : r.provider === 'file' ? 'file' : 'post';
  const a = r.article || {}, d = r.doc || {};
  const field = (name, lbl, value, { type = 'text', placeholder = '' } = {}) => `<label class="edit-field"><span>${lbl}</span><input class="field" name="${name}" type="${type}" value="${esc(value || '')}" placeholder="${esc(placeholder)}" autocomplete="off"></label>`;
  const day = (iso) => (iso || '').slice(0, 10);
  const note = { web: 'Everything here is yours to change; the page itself isn’t touched.', file: 'The title page. The file itself stays as it is.', post: 'The title shown for this post. Its text comes from X.' }[kind];
  el.innerHTML = `<form class="edit-form" data-edit="${esc(r.id)}">
    <div class="edit-bar">
      <span class="kicker">Editing</span><span class="muted small edit-note">${note}</span>
      <span class="edit-actions">
        ${kind === 'web' ? `${a.edited ? '<button type="button" class="ghost small" data-edit-action="restore" title="Back to the page as it was first read">Restore original</button>' : ''}<button type="button" class="ghost small" data-edit-action="reread" title="Read the page again from the web; your edits are replaced">Re-read page</button>` : ''}
        <button type="button" class="ghost" data-edit-cancel>Cancel ${capsOf('Escape')}</button>
        <button type="submit" class="primary">Save ${capsOf('Mod+Enter')}</button>
      </span>
    </div>
    <textarea class="edit-title" name="title" rows="1" placeholder="Title">${esc(r.title || '')}</textarea>
    ${kind === 'web' ? `<div class="edit-fields">
        ${field('author', 'Author', a.byline)}${field('site', 'Site', a.site)}${field('published', 'Published', day(a.published), { type: 'date' })}
        <label class="edit-field wide"><span>Cover image</span><span class="edit-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" referrerpolicy="no-referrer">` : ''}<input class="field" name="cover" value="${esc(a.cover || '')}" placeholder="https://… (empty for none)" autocomplete="off"></span></label>
      </div>
      <div class="edit-tools" role="toolbar" aria-label="Block">${TOOLS.map(([t, l]) => `<button type="button" data-edit-block="${t}">${l}</button>`).join('')}<button type="button" class="danger" data-edit-block="remove" title="Remove the block you're in">Remove block</button></div>
      <div class="edit-body r-text r-article" contenteditable="true" spellcheck="true" aria-label="Article">${(a.blocks || [{ type: 'p', text: r.text || '' }]).map(blockHtml).join('')}</div>`
    : kind === 'file' ? `<div class="edit-fields">
        ${field('author', 'Author', (d.authors || []).join(', '), { placeholder: 'Several: comma-separated' })}${field('publisher', 'Publisher', d.publisher)}${field('published', 'Published', d.published)}
        <label class="edit-field wide"><span>Description</span><textarea class="field" name="description" rows="4">${esc(d.description || '')}</textarea></label>
      </div>` : ''}
  </form>`;
  const form = $('.edit-form', el);
  const title = $('.edit-title', form);
  const fit = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
  fit(); title.addEventListener('input', fit);
  title.focus(); title.setSelectionRange(title.value.length, title.value.length);
  const body = $('.edit-body', form);
  if (body) {
    // Enter makes a paragraph (not a div); pasting brings plain text, not the page's styling.
    body.addEventListener('focus', () => document.execCommand('defaultParagraphSeparator', false, 'p'));
    body.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); save(el, r, form); });
  form.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.editCancel !== undefined) finish(el, r);
    else if (t.dataset.editDrop !== undefined) t.closest('[data-b]').remove();
    else if (t.dataset.editBlock) setBlock(body, t.dataset.editBlock);
    else if (t.dataset.editAction) act(el, r, t.dataset.editAction);
  });
  // Toolbar buttons keep the caret where it was.
  form.addEventListener('mousedown', (e) => { if (e.target.closest('[data-edit-block]')) e.preventDefault(); });
  const cover = form.elements.cover;
  cover?.addEventListener('change', () => { const box = $('.edit-cover', form); const img = $('img', box); const u = cover.value.trim(); if (!/^https?:\/\//.test(u)) { img?.remove(); return; } if (img) img.src = u; else box.insertAdjacentHTML('afterbegin', `<img src="${esc(u)}" alt="" referrerpolicy="no-referrer">`); });
  // Keys while editing: save, or leave without saving. They don't reach the reader's shortcuts.
  form._keys = (e) => {
    if (!form.isConnected) return document.removeEventListener('keydown', form._keys, true);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(el, r); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); form.requestSubmit(); }
  };
  document.addEventListener('keydown', form._keys, true);
}

// The block the caret is in becomes another kind (or goes).
function setBlock(body, type) {
  const sel = getSelection();
  let n = sel?.anchorNode;
  while (n && n.parentNode !== body) n = n.parentNode;
  if (!n || n.nodeType !== Node.ELEMENT_NODE || !body.contains(n)) { toast('Put the cursor in a paragraph first'); return; }
  if (type === 'remove') { n.remove(); return; }
  if (n.dataset.b === 'image' || n.dataset.b === 'divider') return;
  const next = document.createElement(TAG[type]);
  next.dataset.b = type;
  next.innerHTML = n.innerHTML;
  n.replaceWith(next);
  const r = document.createRange(); r.selectNodeContents(next); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
}

async function save(el, r, form) {
  const f = form.elements, args = { id: r.id, title: f.title.value };
  if (r.provider === 'web') Object.assign(args, { author: f.author.value, site: f.site.value, published: f.published.value, cover: f.cover.value.trim(), blocks: readBlocks($('.edit-body', form)) });
  else if (r.provider === 'file') Object.assign(args, { author: f.author.value, publisher: f.publisher.value, published: f.published.value, description: f.description.value });
  const title = String(args.title).trim();
  // What you saved shows at once; the server rebuilds its index behind it.
  await call(el, r, args, 'Saved', () => {
    r._title ??= r.title;
    if (title) r.title = title; else if (r.provider === 'twitter') r.title = r._title;
    if (r.provider === 'web') {
      r.article = { ...(r.article || {}), title: title || r.article?.title, byline: args.author.trim() || null, site: args.site.trim() || r.article?.site, published: args.published ? new Date(args.published).toISOString() : null, cover: /^https?:\/\//.test(args.cover) ? args.cover : null, blocks: args.blocks, edited: true };
      r.author = { ...r.author, name: args.author.trim() || args.site.trim() || r.author.name };
    }
    if (r.provider === 'file') Object.assign(r.doc, { authors: args.author.split(/\s*[,;]\s*/).filter(Boolean), publisher: args.publisher.trim() || null, published: args.published.trim() || null, description: args.description.trim() || null });
    if (r.provider === 'file') r.author = { ...r.author, name: r.doc.authors.join(', ') };
    store.tagCache.delete(r.id); store.hay.delete(r.id); delete r._len;
  });
}
async function act(el, r, action) {
  if (action === 'reread' && !confirm('Read the page again from the web? Your edits to it are replaced.')) return;
  if (action === 'restore' && !confirm('Go back to the page as it was first read? Your edits are undone.')) return;
  await call(el, r, { id: r.id, action }, action === 'reread' ? 'Read again from the web' : 'Restored');
}
async function call(el, r, args, done, applyLocally) {
  const form = $('.edit-form', el);
  for (const b of $$('button', form)) b.disabled = true;
  const submit = $('button[type="submit"]', form); if (submit) submit.textContent = args.action ? 'Working…' : 'Saving…';
  try {
    await api('/api/ops', { method: 'POST', body: { tool: 'edit_bookmark', args } });
    if (applyLocally) applyLocally(); else await loadAll();
    finish(el, store.byId.get(r.id) || r);
    if (inQueue()) refreshQueue();
    toast(done);
  } catch (e) { for (const b of $$('button', form)) b.disabled = false; toast(`Not saved: ${e.message}`); }
}
function finish(el, r) {
  const form = $('.edit-form', el);
  if (form?._keys) document.removeEventListener('keydown', form._keys, true);
  el.innerHTML = '';
  paintReader(el, r, el.id === 'triage-body' ? { docked: true } : undefined);
}
