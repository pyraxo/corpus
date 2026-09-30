// Highlights and notes: finding a passage again, marking it, the floating toolbar, and notes on highlights.
import { capsOf } from '../app/keymap.js';
import { $, $$, copyText, esc } from '../core/dom.js';
import { store, ui } from '../core/state.js';
import { saveOverride } from '../data/history.js';
import { isDoc } from '../data/library.js';
import { toast } from '../ui/toast.js';
import { openHighlight, renderHighlights } from '../views/highlights.js';
import { repaintBookmark } from '../views/post.js';
import { locKey, parseLoc } from './doc-reader.js';

// A highlight is stored as its exact text plus a little context either side, so it can
// be found again in the rendered post even after the post is re-captured or re-rendered.
const HL_SKIP = '.r-index, .media-flag, .q-open, .r-pending, button';
export const clip = (s, n) => s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s;
export const highlightsOf = (id) => store.overrides[id]?.highlights || [];
function textIndex(root) {
  const nodes = [];
  let n = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => t.parentElement?.closest(HL_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let t; (t = walker.nextNode());) { nodes.push({ node: t, start: n }); n += t.nodeValue.length; }
  return { nodes, text: nodes.map(x => x.node.nodeValue).join('') };
}
// A DOM position (as in a Range) as an offset into textIndex's text.
function pointOffset(ix, container, offset) {
  if (container.nodeType === Node.TEXT_NODE) { const e = ix.nodes.find(x => x.node === container); if (e) return e.start + offset; }
  const at = document.createRange(); at.setStart(container, offset);
  return ix.nodes.find(x => at.comparePoint(x.node, 0) >= 0)?.start ?? ix.text.length;
}
// The occurrence of the highlighted text whose surroundings best match what was saved.
function locate(ix, h) {
  const t = ix.text, pre = h.prefix || '', suf = h.suffix || '';
  let best = -1, bestScore = -1;
  for (let i = t.indexOf(h.text); i >= 0; i = t.indexOf(h.text, i + 1)) {
    let score = 0;
    while (score < pre.length && t[i - 1 - score] === pre[pre.length - 1 - score]) score++;
    for (let k = 0, j = i + h.text.length; k < suf.length && t[j + k] === suf[k]; k++) score++;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}
function markOne(root, h) {
  const ix = textIndex(root);
  const s = locate(ix, h);
  if (s < 0) return false;
  const e = s + h.text.length;
  for (const { node, start } of ix.nodes) {
    const end = start + node.nodeValue.length;
    if (end <= s || start >= e) continue;
    let t = node;
    if (s > start) t = t.splitText(s - start);
    if (e < end) t.splitText(e - Math.max(s, start));
    if (!t.nodeValue.trim()) continue;
    const m = document.createElement('mark');
    m.className = 'hl'; m.dataset.hl = h.id;
    t.parentNode.insertBefore(m, t); m.append(t);
  }
  return true;
}
// Every highlight root: a post's text, a book chapter, a PDF page's text layer. Posts have no
// location; a chapter or page does (data-loc), and only its own highlights are marked in it.
const HL_ROOT = '.r-text, .hl-root';
export function markRoot(root, r) {
  const loc = root.dataset.loc || '';
  const hs = highlightsOf(r.id);
  for (const h of hs) if (locKey(h.loc) === loc) markOne(root, h);
  for (const m of $$('mark.hl', root)) m.classList.toggle('has-note', !!hs.find(h => h.id === m.dataset.hl)?.note);
}
export function markHighlights(el, r) {
  if (el) for (const root of $$(HL_ROOT, el)) markRoot(root, r);
}
// PDFs have pages to cite; a book's chapter files don't match its chapters, so they aren't named.
export const whereOf = (r, h) => h.loc?.page != null ? `p. ${h.loc.page + 1}` : '';
export function highlightsSection(r) {
  const hs = highlightsOf(r.id);
  if (!hs.length) return '';
  const sorted = isDoc(r) ? [...hs].sort((a, b) => (a.loc?.page ?? a.loc?.ch ?? 0) - (b.loc?.page ?? b.loc?.ch ?? 0)) : hs;
  const notes = hs.filter(h => h.note).length;
  return `<div class="r-section"><h4>Highlights · ${hs.length}${notes ? ` · ${notes} note${notes === 1 ? '' : 's'}` : ''}</h4><ol class="hl-list">${sorted.map(h => `<li><div class="hl-body"><button class="hl-quote" data-hl-jump="${esc(h.id)}">${whereOf(r, h) ? `<span class="hl-where">${esc(whereOf(r, h))}</span>` : ''}${esc(clip(h.quote || h.text, 280))}</button>${h.note ? `<p class="hl-note-text">${esc(h.note)}</p>` : ''}</div><span class="hl-actions"><button class="x" data-hl-note-edit="${esc(h.id)}" data-bm="${r.id}" aria-label="${h.note ? 'Edit note' : 'Add a note'}" title="${h.note ? 'Edit note' : 'Add a note'}">✎</button><button class="x" data-hl-remove="${esc(h.id)}" data-bm="${r.id}" aria-label="Remove highlight" title="Remove highlight">×</button></span></li>`).join('')}</ol></div>`;
}
export const hlMark = (r) => { const n = highlightsOf(r.id).length; return n ? `<span class="hl-mark" title="${n} highlight${n === 1 ? '' : 's'}"><i></i>${n}</span>` : ''; };
// The bookmark a highlight root belongs to (roots carry data-bm); older markup: the reader's or the inbox's.
const bookmarkOfBody = (el) => el?.closest('[data-bm]')?.dataset.bm || (el?.closest('.reader-body')?.id === 'triage-body' ? ui.inboxId : ui.readerId);
// The selection as it reads, paragraph breaks included, without part numbers or buttons.
function selectedText(range) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;width:600px;white-space:normal';
  box.append(range.cloneContents());
  for (const x of box.querySelectorAll(HL_SKIP)) x.remove();
  document.body.append(box);
  const text = box.innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  box.remove();
  return text;
}
export async function highlightSelection({ withNote = false } = {}) {
  const sel = getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) { toast('Select some text first'); return; }
  const range = sel.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const root = (common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement)?.closest(HL_ROOT);
  const r = root && store.byId.get(bookmarkOfBody(root));
  if (!r) { toast('Select text in the post to highlight it'); return; }
  const ix = textIndex(root);
  let s = pointOffset(ix, range.startContainer, range.startOffset), e = pointOffset(ix, range.endContainer, range.endOffset);
  while (s < e && /\s/.test(ix.text[s])) s++;
  while (e > s && /\s/.test(ix.text[e - 1])) e--;
  if (e - s < 2) return;
  const quote = selectedText(range) || ix.text.slice(s, e);
  const loc = parseLoc(root.dataset.loc);
  const dup = highlightsOf(r.id).find(x => x.text === ix.text.slice(s, e) && locKey(x.loc) === locKey(loc) && x.prefix === ix.text.slice(Math.max(0, s - 40), s));
  if (dup) { sel.removeAllRanges(); hidePop(); if (withNote) { const m = $(`mark[data-hl="${CSS.escape(dup.id)}"]`); if (m) editNote(r.id, dup.id, m.getBoundingClientRect()); } else toast('Already highlighted'); return; }
  const h = { id: Math.random().toString(36).slice(2, 10), text: ix.text.slice(s, e), quote: quote.slice(0, 6000), prefix: ix.text.slice(Math.max(0, s - 40), s), suffix: ix.text.slice(e, e + 40), at: new Date().toISOString(), ...(loc && { loc }) };
  sel.removeAllRanges(); hidePop();
  await saveOverride([r.id], { highlights: [...highlightsOf(r.id), h] }, { label: withNote ? 'Note' : 'Highlight' });
  repaintBookmark(r.id);
  if (withNote) { const m = $(`mark[data-hl="${CSS.escape(h.id)}"]`); if (m) editNote(r.id, h.id, m.getBoundingClientRect()); }
  else toast('Highlighted', { undo: true });
}
async function removeHighlight(id, hid) {
  const rest = highlightsOf(id).filter(h => h.id !== hid);
  hidePop();
  await saveOverride([id], { highlights: rest.length ? rest : null }, { label: 'Remove highlight' });
  repaintBookmark(id);
  if (ui.view === 'highlights' && $('#reader').hidden) renderHighlights();
  toast('Highlight removed', { undo: true });
}
// Notes: a few words of your own on a highlight, like a note in the margin.
function editNote(id, hid, rect) {
  const h = highlightsOf(id).find(x => x.id === hid);
  if (!h) return;
  showPop(rect, `<form class="hl-note" data-hl-note="${esc(hid)}" data-bm="${esc(id)}"><p class="hl-note-q">${esc(clip(h.quote || h.text, 120))}</p><textarea rows="3" placeholder="Your note — a thought, a question, a link to something else">${esc(h.note || '')}</textarea><div class="hl-note-bar"><span class="muted small">${capsOf('Mod+Enter')}</span>${h.note ? '<button type="button" data-hl-note-clear>Delete note</button>' : ''}<button type="submit" class="primary">Save</button></div></form>`, 'note');
  requestAnimationFrame(() => { const ta = $('#hl-pop textarea'); ta?.focus(); ta?.setSelectionRange(ta.value.length, ta.value.length); });
}
async function saveNote(id, hid, text) {
  const note = String(text || '').trim();
  const hs = highlightsOf(id).map(h => h.id !== hid ? h : note ? { ...h, note, noteAt: new Date().toISOString() } : (({ note: _, noteAt: __, ...rest }) => rest)(h));
  hidePop();
  await saveOverride([id], { highlights: hs }, { label: note ? 'Note' : 'Delete note' });
  repaintBookmark(id);
  if (ui.view === 'highlights' && $('#reader').hidden) renderHighlights();
  toast(note ? 'Note saved' : 'Note deleted', { undo: true });
}
export async function jumpToHighlight(el, hid) {
  const find = () => el && $(`mark[data-hl="${CSS.escape(hid)}"]`, el);
  let m = find();
  // In a book or PDF, the passage may be in another chapter or a page not drawn yet.
  const doc = !m && el && $('.doc-mount', el)?._doc;
  if (doc) {
    const h = highlightsOf(doc.id).find(x => x.id === hid);
    await doc.ready;
    if (h?.loc) { await doc.goTo(h.loc); m = find(); }
  }
  if (!m) { toast('That passage isn’t in the current text any more'); return; }
  // In a book, wait for its pictures: they change where everything below them is.
  const docHere = el && $('.doc-mount', el)?._doc;
  if (docHere) { await docHere.settle(); m = find() || m; }
  m.scrollIntoView({ block: 'center', behavior: docHere ? 'auto' : 'smooth' });
  $$(`mark[data-hl="${CSS.escape(hid)}"]`, el).forEach(x => { x.classList.remove('flash'); void x.offsetWidth; x.classList.add('flash'); });
}
// One small floating bar: "Highlight" over a selection, or Copy / Remove on a highlight.
function hlPop() {
  let el = $('#hl-pop');
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', '<div id="hl-pop" class="hl-pop" role="toolbar" hidden></div>');
    el = $('#hl-pop');
    el.addEventListener('pointerdown', (e) => { if (!e.target.closest('textarea, input')) e.preventDefault(); }); // keep the selection
  }
  return el;
}
function showPop(rect, html, kind) {
  const el = hlPop();
  el.innerHTML = html; el.dataset.kind = kind; el.hidden = false;
  const w = el.offsetWidth, h = el.offsetHeight;
  // On touch screens the system's own selection menu sits above, so go below.
  let top = matchMedia('(pointer: coarse)').matches ? rect.bottom + 12 : rect.top - h - 8;
  if (top < 8) top = rect.bottom + 8;
  el.style.top = `${Math.min(top, innerHeight - h - 8)}px`;
  el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
}
export function hidePop(kind) { const el = $('#hl-pop'); if (el && (!kind || el.dataset.kind === kind)) el.hidden = true; }
function checkSelection() {
  const sel = getSelection();
  const range = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
  const common = range?.commonAncestorContainer;
  const root = common && (common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement)?.closest(HL_ROOT);
  if ($('#hl-pop')?.dataset.kind === 'note' && !$('#hl-pop').hidden) return;
  if (!root || !sel.toString().trim()) { hidePop('new'); return; }
  showPop(range.getBoundingClientRect(), `<button data-hl-add>Highlight${matchMedia('(pointer: coarse)').matches ? '' : ' <kbd>h</kbd>'}</button><button data-hl-add-note>Add note</button>`, 'new');
}
let selTimer = 0;

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupHighlights() {
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, 160); });
  document.addEventListener('scroll', () => { hidePop('mark'); if ($('#hl-pop')?.dataset.kind === 'new' && !$('#hl-pop').hidden) { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, 60); } }, true);
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.closest('[data-hl-add]')) { await highlightSelection(); return; }
    if (t.closest('[data-hl-add-note]')) { await highlightSelection({ withNote: true }); return; }
    const ne = t.closest('[data-hl-note-edit]');
    if (ne) { const m = $(`mark[data-hl="${CSS.escape(ne.dataset.hlNoteEdit)}"]`); editNote(ne.dataset.bm, ne.dataset.hlNoteEdit, (m || ne).getBoundingClientRect()); return; }
    if (t.closest('[data-hl-note-clear]')) { const f = t.closest('[data-hl-note]'); await saveNote(f.dataset.bm, f.dataset.hlNote, ''); return; }
    const rm = t.closest('[data-hl-remove]');
    if (rm) { await removeHighlight(rm.dataset.bm, rm.dataset.hlRemove); return; }
    const cp = t.closest('[data-hl-copy]');
    if (cp) { const h = highlightsOf(cp.dataset.bm).find(x => x.id === cp.dataset.hlCopy); hidePop(); if (h) copyText(h.quote || h.text); return; }
    const jump = t.closest('[data-hl-jump]');
    if (jump) { jumpToHighlight(jump.closest('.reader-body'), jump.dataset.hlJump); return; }
    const card = t.closest('[data-hl-open]');
    if (card) { openHighlight(card.dataset.hlOpen, card.dataset.hlId); return; }
    const mark = t.closest('mark.hl');
    if (mark && !t.closest('a') && getSelection()?.isCollapsed !== false) {
      const id = bookmarkOfBody(mark);
      const note = highlightsOf(id).find(h => h.id === mark.dataset.hl)?.note;
      showPop(mark.getBoundingClientRect(), `${note ? `<p class="hl-pop-note">${esc(note)}</p>` : ''}<button data-hl-copy="${esc(mark.dataset.hl)}" data-bm="${id}">Copy</button><button data-hl-note-edit="${esc(mark.dataset.hl)}" data-bm="${id}">${note ? 'Edit note' : 'Add note'}</button><button data-hl-remove="${esc(mark.dataset.hl)}" data-bm="${id}">Remove</button>`, 'mark');
      return;
    }
    if (!t.closest('#hl-pop')) { hidePop('mark'); hidePop('note'); }
  });
  document.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('[data-hl-note]');
    if (!f) return;
    ev.preventDefault();
    await saveNote(f.dataset.bm, f.dataset.hlNote, $('textarea', f).value);
  });
  document.addEventListener('keydown', (ev) => {
    if (!ev.target.matches('.hl-note textarea')) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); hidePop('note'); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ev.target.form.requestSubmit(); }
  }, true);
}
