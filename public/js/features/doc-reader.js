// Books, PDFs and text files in the reader: chapters (EPUB, MOBI, text) or pages (PDF), a
// contents and notes panel, and your place kept. Highlights and notes work as on any post:
// each chapter, and each PDF page's text layer, is a highlight root with its own location
// (data-loc "ch:3" or "p:12"), so a highlight is found again in the right place.
const PDFJS = '/vendor/pdfjs/';
let lib = null;
async function pdfjs() {
  if (!lib) { lib = await import(`${PDFJS}pdf.min.mjs`); lib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`; }
  return lib;
}
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const docs = new Map();
export const loadDoc = (id, { fresh = false } = {}) => {
  if (fresh || !docs.has(id)) docs.set(id, fetch(`/files/${id}/doc.json`, { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).catch(e => { docs.delete(id); throw e; }));
  return docs.get(id);
};
// Open PDFs are kept while they're being read, so repainting the reader doesn't reload them.
const pdfs = new Map();
async function openPdf(id, file) {
  if (!pdfs.has(id)) {
    const { getDocument } = await pdfjs();
    const task = getDocument({ url: `/files/${id}/${file}`, cMapUrl: `${PDFJS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}standard_fonts/`, wasmUrl: `${PDFJS}wasm/`, iccUrl: `${PDFJS}iccs/`, isEvalSupported: false });
    pdfs.set(id, task.promise.catch(e => { pdfs.delete(id); throw e; }));
    for (const [k, p] of pdfs) if (pdfs.size > 3 && k !== id) { pdfs.delete(k); p.then(d => d.destroy()).catch(() => {}); }
  }
  return pdfs.get(id);
}

// Where you are in each open document, newest first; survives repaints of the reader.
const lastPos = new Map();
const mounted = new Set();
// Where a highlight is: a PDF page, a book chapter, or a part of a post (the article it links to).
const locKey = (loc) => !loc ? '' : loc.page != null ? `p:${loc.page}` : loc.ch != null ? `ch:${loc.ch}` : loc.part || '';
export const parseLoc = (s = '') => { const m = /^(p|ch):(\d+)$/.exec(s); return m ? (m[1] === 'p' ? { page: Number(m[2]) } : { ch: Number(m[2]) }) : /^[a-z]+$/.test(s) ? { part: s } : null; };
export { locKey };

// The element that scrolls the reader: the inbox pane, the dialog sheet, or the page itself.
function scrollerOf(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return document.scrollingElement;
}
const topIn = (node, scroller) => node.getBoundingClientRect().top - (scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top) + scroller.scrollTop;

const settled = (root, ms) => Promise.race([Promise.all([...root.querySelectorAll('img')].map(i => i.complete ? null : new Promise(res => { i.addEventListener('load', res, { once: true }); i.addEventListener('error', res, { once: true }); }))), new Promise(res => setTimeout(res, ms))]);

// h: { mark(root), pos, save(pos, progress), cover(blob), notes() -> [{id, loc, text, note}], jump(hid) }
export function mountDoc(el, r, h) {
  for (const c of mounted) if (!c.el.isConnected) c.destroy();
  const id = r.id, kind = r.doc.kind;
  const scroller = scrollerOf(el);
  const scrollTarget = scroller === document.scrollingElement ? window : scroller;
  let doc = null, cur = 0, alive = true, saveTimer = 0;
  const cleanups = [];
  el.classList.add(kind === 'pdf' ? 'pdf' : 'chapters');
  el.innerHTML = `<div class="doc-bar">
      <button class="doc-btn" data-doc-contents aria-expanded="false" title="Contents and notes (⇧C)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg>Contents</button>
      <span class="doc-where" aria-live="polite"></span>
      ${kind === 'pdf' ? '<span class="doc-zoom"><button class="doc-btn icon" data-doc-zoom="-1" aria-label="Zoom out">−</button><span class="doc-zoom-v">100%</span><button class="doc-btn icon" data-doc-zoom="1" aria-label="Zoom in">+</button></span>' : ''}
      <span class="doc-steps"><button class="doc-btn icon" data-doc-step="-1" aria-label="${kind === 'pdf' ? 'Previous page' : 'Previous chapter'}" title="${kind === 'pdf' ? 'Previous page' : 'Previous chapter'} ([)">‹</button><button class="doc-btn icon" data-doc-step="1" aria-label="${kind === 'pdf' ? 'Next page' : 'Next chapter'}" title="${kind === 'pdf' ? 'Next page' : 'Next chapter'} (])">›</button></span>
      <span class="doc-progress"><i></i></span>
      <div class="doc-panel" hidden></div>
    </div>
    <div class="doc-body"><p class="doc-loading">Opening ${esc(r.doc.name || 'the file')}…</p></div>
    <nav class="doc-foot"></nav>`;
  const bar = el.querySelector('.doc-bar'), panel = el.querySelector('.doc-panel'), body = el.querySelector('.doc-body'), foot = el.querySelector('.doc-foot');
  // settle(): the open chapter's images have loaded (or a few seconds passed), so positions hold still.
  const ctl = { el, id, destroy, goTo, step, toggleContents, remark, settle: () => settled(body, 4000) };
  el._doc = ctl;
  mounted.add(ctl);

  function destroy() { alive = false; mounted.delete(ctl); clearTimeout(saveTimer); cleanups.forEach(f => f()); }
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };

  // ── position and progress ──
  let progress = 0;
  // save: false while you're still on the title page above the text, so opening isn't "reading".
  function report(pos, p, { save = true } = {}) {
    progress = Math.max(0, Math.min(1, p));
    lastPos.set(id, pos);
    bar.querySelector('.doc-progress i').style.width = `${(progress * 100).toFixed(1)}%`;
    bar.querySelector('.doc-where').textContent = `${whereLabel(pos)} · ${Math.round(progress * 100)}%`;
    clearTimeout(saveTimer);
    if (save) saveTimer = setTimeout(() => h.save?.(pos, Math.round(progress * 1000) / 1000), 1500);
  }
  const titleOf = (n) => doc.chapters?.[n]?.title || doc.toc?.find(t => t.ch === n)?.title || `Section ${n + 1}`;
  // Several contents entries can share one chapter file (Gutenberg puts ten chapters in one):
  // the current one is the last whose heading is above the top of the screen.
  let anchors = [];
  const anchorId = (a) => `x-${String(a).replace(/[^\w-]/g, '_')}`;
  function collectAnchors() { anchors = (doc.toc || []).filter(e => e.ch === cur && e.anchor).map(e => ({ e, node: body.querySelector(`#${CSS.escape(anchorId(e.anchor))}`) })).filter(x => x.node); }
  function activeEntry() {
    if (kind === 'pdf') { let best = null; for (const e of doc.toc || []) if (e.page <= cur) best = e; return best; }
    const line = scroller.scrollTop + scroller.clientHeight * 0.4;
    let best = (doc.toc || []).find(e => e.ch === cur && !e.anchor) || null;
    for (const a of anchors) if (topIn(a.node, scroller) <= line) best = a.e;
    return best || anchors[0]?.e || null;
  }
  const whereLabel = (pos) => pos.page != null ? `Page ${pos.page + 1} of ${doc.pages}${activeEntry() ? ` · ${activeEntry().title}` : ''}` : activeEntry()?.title || titleOf(pos.ch);

  // ── contents and notes ──
  let tab = 'contents';
  function paintPanel() {
    const notes = (h.notes?.() || []).slice().sort((a, b) => (a.loc?.page ?? a.loc?.ch ?? 0) - (b.loc?.page ?? b.loc?.ch ?? 0));
    const act = activeEntry();
    const here = (e) => act ? e === act : kind === 'pdf' ? e.page === cur : e.ch === cur;
    const toc = doc.toc?.length ? doc.toc : kind === 'pdf' ? [] : doc.chapters.map((c, ch) => ({ title: titleOf(ch), ch, level: 0 }));
    // A note's place: its page, or the contents heading above it when its chapter is open.
    const whereFor = (n) => {
      if (n.loc?.page != null) return `p. ${n.loc.page + 1}`;
      if (n.loc?.ch == null) return '';
      const m = n.loc.ch === cur && body.querySelector(`mark[data-hl="${CSS.escape(n.id)}"]`);
      let best = null;
      if (m) for (const a of anchors) if (a.node.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) best = a.e;
      return (best?.title || titleOf(n.loc.ch)).slice(0, 48);
    };
    const list = tab === 'contents'
      ? (toc.length ? `<ol class="doc-toc">${toc.map(e => `<li style="--level:${Math.min(e.level || 0, 3)}" class="${here(e) ? 'on' : ''}"><button data-doc-go="${kind === 'pdf' ? `p:${e.page}` : `ch:${e.ch}`}" ${e.anchor ? `data-anchor="x-${esc(String(e.anchor).replace(/[^\w-]/g, '_'))}"` : ''}><span>${esc(e.title)}</span>${kind === 'pdf' ? `<span class="n">${e.page + 1}</span>` : ''}</button></li>`).join('')}</ol>` : `<p class="muted small doc-empty">${kind === 'pdf' ? `This PDF has no outline. ${doc.pages} pages.` : 'No contents.'}</p>`)
      : (notes.length ? `<ol class="doc-notes">${notes.map(n => `<li><button data-doc-note="${esc(n.id)}"><span class="where">${esc(whereFor(n))}</span><q>${esc(n.text.length > 220 ? `${n.text.slice(0, 220)}…` : n.text)}</q>${n.note ? `<span class="note">${esc(n.note)}</span>` : ''}</button></li>`).join('')}</ol>` : '<p class="muted small doc-empty">Select text to highlight it or add a note. Your highlights and notes in this document collect here.</p>');
    panel.innerHTML = `<div class="segmented doc-tabs" role="tablist"><button data-doc-tab="contents" aria-pressed="${tab === 'contents'}">Contents</button><button data-doc-tab="notes" aria-pressed="${tab === 'notes'}">Highlights & notes${notes.length ? ` · ${notes.length}` : ''}</button></div>${list}`;
    panel.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }
  function toggleContents(open = panel.hidden, which) {
    if (which) tab = which;
    panel.hidden = !open;
    bar.querySelector('[data-doc-contents]').setAttribute('aria-expanded', String(open));
    if (open && doc) paintPanel();
  }

  on(el, 'click', (ev) => {
    const t = ev.target.closest('button, a[data-ch]');
    if (!t || !el.contains(t)) return;
    const d = t.dataset;
    if (d.docContents !== undefined) { toggleContents(); return; }
    if (d.docTab) { tab = d.docTab; paintPanel(); return; }
    if (d.docGo) { ev.preventDefault(); toggleContents(false); goTo(parseLoc(d.docGo), { anchor: d.anchor }); return; }
    if (d.docNote) { toggleContents(false); h.jump?.(d.docNote); return; }
    if (d.docStep) { step(Number(d.docStep)); return; }
    if (d.docZoom) { zoomBy(Number(d.docZoom)); return; }
    if (t.matches('a[data-ch]')) { ev.preventDefault(); goTo({ ch: Number(d.ch) }, { anchor: d.anchor }); }
  });
  on(document, 'pointerdown', (ev) => { if (!panel.hidden && !panel.contains(ev.target) && !ev.target.closest('[data-doc-contents]')) toggleContents(false); });

  // ── chapters: EPUB, MOBI, text ──
  const chapterHtml = new Map();
  async function showChapter(n, { anchor, f, initial = false } = {}) {
    n = Math.max(0, Math.min(doc.chapters.length - 1, n));
    const changed = n !== cur || !body.querySelector('.doc-chapter');
    cur = n;
    if (changed) {
      if (!chapterHtml.has(n)) body.innerHTML = '<p class="doc-loading">Loading…</p>';
      if (!chapterHtml.has(n)) chapterHtml.set(n, await fetch(`/files/${id}/ch/${n}.html`).then(res => res.ok ? res.text() : '<p>This chapter couldn’t be loaded.</p>'));
      if (!alive || cur !== n) return;
      // Images load now, not lazily: their heights decide where a saved place or a heading is.
      body.innerHTML = `<div class="r-text doc-chapter" data-bm="${esc(id)}" data-loc="ch:${n}">${chapterHtml.get(n).replace(/ loading="lazy"/g, '')}</div>`;
      h.mark?.(body.firstChild);
      collectAnchors();
      const prev = n > 0 ? `<button class="doc-next prev" data-doc-step="-1"><span class="kicker">Previous</span><span>${esc(titleOf(n - 1))}</span></button>` : '<span></span>';
      const next = n < doc.chapters.length - 1 ? `<button class="doc-next" data-doc-step="1"><span class="kicker">Next</span><span>${esc(titleOf(n + 1))}</span></button>` : '<span class="doc-end muted small">The end</span>';
      foot.innerHTML = `${prev}${next}`;
    }
    if (changed && (anchor || f != null)) await settled(body, 4000);
    if (!alive || cur !== n) return;
    const target = anchor && body.querySelector(`#${CSS.escape(anchor)}`);
    if (target) scroller.scrollTop = topIn(target, scroller) - 72;
    else if (f != null) { const top = topIn(body, scroller); scroller.scrollTop = top + f * Math.max(0, body.offsetHeight - scroller.clientHeight * 0.5) - 8; }
    // Opening a book fresh stays on its title page; moving to another chapter starts at its top.
    else if (changed && !initial) scroller.scrollTop = Math.max(0, topIn(el, scroller) - 8);
    track();
  }
  function chapterPos() {
    const top = topIn(body, scroller), span = Math.max(1, body.offsetHeight - scroller.clientHeight * 0.5);
    const f = Math.max(0, Math.min(1, (scroller.scrollTop - top + 8) / span));
    const chars = doc.chapters.map(c => Math.max(1, c.chars || 0)), total = chars.reduce((a, b) => a + b, 0);
    const before = chars.slice(0, cur).reduce((a, b) => a + b, 0);
    report({ ch: cur, f: Math.round(f * 1000) / 1000 }, (before + f * chars[cur]) / total, { save: scroller.scrollTop + 8 >= top || cur !== firstReadable() });
  }

  // ── PDF pages ──
  let pdf = null, zoom = 1, scale = 1, baseW = 612, baseH = 792, pageEls = [], io = null;
  const rendered = new Map(); // page index -> { gen, promise } of its latest render
  let gen = 0;
  async function showPdf(pos) {
    pdf = await openPdf(id, r.doc.file);
    if (!alive) return;
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    baseW = vp.width; baseH = vp.height;
    body.innerHTML = '';
    pageEls = Array.from({ length: pdf.numPages }, (_, i) => {
      const p = document.createElement('div');
      p.className = 'pdf-page'; p.dataset.page = i;
      p.innerHTML = `<canvas></canvas><div class="textLayer hl-root" data-bm="${esc(id)}" data-loc="p:${i}"></div><span class="pdf-n">${i + 1}</span>`;
      body.append(p);
      return p;
    });
    layout();
    io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) renderPage(Number(e.target.dataset.page)); }, { root: scrollTarget === window ? null : scroller, rootMargin: '900px 0px' });
    pageEls.forEach(p => io.observe(p));
    cleanups.push(() => io.disconnect());
    if (pos?.page != null) scrollToPage(pos.page, pos.f || 0);
    if (!r.doc.cover) makeCover(first);
    track();
  }
  function fitWidth() { return Math.max(240, body.clientWidth || el.clientWidth || 680); }
  function layout() {
    scale = zoom * fitWidth() / baseW;
    for (const p of pageEls) { p.style.width = `${Math.floor(baseW * scale)}px`; p.style.height = `${Math.floor((p._h || baseH) * scale)}px`; }
    bar.querySelector('.doc-zoom-v') && (bar.querySelector('.doc-zoom-v').textContent = `${Math.round(zoom * 100)}%`);
  }
  function renderPage(i) {
    const had = rendered.get(i);
    if (had?.gen === gen) return had.promise;
    const promise = drawPage(i, gen);
    rendered.set(i, { gen, promise });
    return promise;
  }
  async function drawPage(i, g) {
    const page = await pdf.getPage(i + 1);
    if (!alive || g !== gen) return;
    const p = pageEls[i];
    const unit = page.getViewport({ scale: 1 });
    if (Math.abs(unit.height - baseH) > 1 || Math.abs(unit.width - baseW) > 1) { p._h = unit.height * baseW / unit.width; p.style.height = `${Math.floor(p._h * scale)}px`; }
    const vp = page.getViewport({ scale: scale * baseW / unit.width });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = p.querySelector('canvas');
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`; canvas.style.height = `${Math.floor(vp.height)}px`;
    // A zoom while this page is drawing: stop the old drawing first (pdf.js won't share a canvas).
    if (p._task) { p._task.cancel(); await p._task.promise.catch(() => {}); }
    if (!alive || g !== gen) return;
    const task = p._task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    try { await task.promise; } catch { if (rendered.get(i)?.gen === g) rendered.delete(i); return; } finally { if (p._task === task) p._task = null; }
    if (!alive || g !== gen) return;
    const tl = p.querySelector('.textLayer');
    tl.innerHTML = '';
    p.style.setProperty('--total-scale-factor', vp.scale);
    p.style.setProperty('--scale-round-x', '1px'); p.style.setProperty('--scale-round-y', '1px');
    try { await new lib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render(); } catch {}
    if (!alive || g !== gen) return;
    h.mark?.(tl);
    p.classList.add('done');
    // Keep memory in check on long documents: let far-away pages go.
    if (rendered.size > 14) for (const [k] of rendered) if (Math.abs(k - cur) > 6) { const q = pageEls[k]; const c = q.querySelector('canvas'); c.width = c.height = 0; q.querySelector('.textLayer').innerHTML = ''; q.classList.remove('done'); rendered.delete(k); }
  }
  function scrollToPage(i, f = 0) {
    const p = pageEls[Math.max(0, Math.min(pageEls.length - 1, i))];
    if (p) scroller.scrollTop = topIn(p, scroller) + f * p.offsetHeight - 56;
  }
  function pdfPos() {
    const probe = scroller.scrollTop + 64;
    let i = 0;
    for (let k = 0; k < pageEls.length; k++) { if (topIn(pageEls[k], scroller) <= probe) i = k; else break; }
    const p = pageEls[i];
    if (!p) return;
    cur = i;
    const f = Math.max(0, Math.min(1, (probe - topIn(p, scroller)) / p.offsetHeight));
    report({ page: i, f: Math.round(f * 1000) / 1000 }, (i + f) / pageEls.length);
  }
  function zoomBy(d) {
    const keep = lastPos.get(id);
    zoom = Math.max(0.5, Math.min(3, Math.round((zoom + d * 0.25) * 100) / 100));
    gen++; rendered.clear();
    pageEls.forEach(p => p.classList.remove('done'));
    layout();
    if (keep?.page != null) scrollToPage(keep.page, keep.f);
    io?.disconnect(); pageEls.forEach(p => io.observe(p));
  }
  async function makeCover(page) {
    try {
      const vp = page.getViewport({ scale: 480 / page.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      c.toBlob(b => b && h.cover?.(b), 'image/jpeg', 0.85);
    } catch {}
  }

  // ── shared ──
  let raf = 0;
  function track() { if (!doc) return; if (kind === 'pdf') { if (pageEls.length) pdfPos(); } else chapterPos(); }
  on(scrollTarget, 'scroll', () => { if (!el.isConnected) return destroy(); cancelAnimationFrame(raf); raf = requestAnimationFrame(track); }, { passive: true });
  let resizeTimer = 0, lastW = 0;
  on(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (kind === 'pdf' && pageEls.length && Math.abs(fitWidth() - lastW) > 8) { lastW = fitWidth(); zoomBy(0); } }, 200); });

  async function goTo(loc, { anchor } = {}) {
    if (!doc || !loc) return;
    if (kind === 'pdf' && loc.page != null) { scrollToPage(loc.page); await renderPage(loc.page); }
    else if (loc.ch != null) await showChapter(loc.ch, { anchor });
  }
  function step(d) {
    if (!doc) return;
    if (kind === 'pdf') scrollToPage(cur + d);
    else showChapter(cur + d);
  }
  // Highlights changed: take the old marks out and put the current ones back.
  function remark() {
    for (const root of el.querySelectorAll('.doc-chapter, .textLayer')) {
      for (const m of root.querySelectorAll('mark.hl')) m.replaceWith(...m.childNodes);
      root.normalize();
      h.mark?.(root);
    }
    if (!panel.hidden) paintPanel();
  }

  ctl.ready = (async () => {
    try {
      doc = await loadDoc(id);
      if (!alive) return;
      const pos = lastPos.get(id) || h.pos || null;
      if (kind === 'pdf') await showPdf(pos);
      else await showChapter(pos?.ch ?? firstReadable(), { f: pos?.f, initial: true });
      lastW = fitWidth();
    } catch (e) {
      body.innerHTML = `<p class="doc-loading warn">Couldn’t open this ${kind === 'pdf' ? 'PDF' : 'file'}: ${esc(e.message)}</p>`;
    }
  })();
  // Books often open on a cover image or a title page; start at the first real text unless you've read further.
  function firstReadable() { const i = doc.chapters.findIndex(c => (c.chars || 0) > 200); return i < 0 ? 0 : i; }
  return ctl;
}

// A PDF's first page as a JPEG, for its cover (the server has no canvas to draw one).
export async function pdfCover(data, width = 480) {
  const { getDocument } = await pdfjs();
  const task = getDocument({ data: new Uint8Array(data), cMapUrl: `${PDFJS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}standard_fonts/`, wasmUrl: `${PDFJS}wasm/`, isEvalSupported: false });
  try {
    const page = await (await task.promise).getPage(1);
    const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  } finally { task.destroy(); }
}
