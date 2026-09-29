import './dropdown.js?v=18';
// Corpus — library, inbox, taxonomy and settings over the built bookmark index.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const num = new Intl.NumberFormat('en');
const PAGE = 60;

const defaults = { theme: 'system', layout: 'wall', density: 'comfortable', sort: 'bookmarked', readerSize: 'm', showSensitive: false, inboxWindow: 'all', inboxSort: 'bookmarked', inboxFormat: 'all', inboxTopic: '' };
const prefStorage = (() => { try { const k = '__corpus'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; } catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; } })();
const prefs = { ...defaults, ...safeJSON(prefStorage.getItem('corpus.prefs')) };
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function savePrefs(patch) { Object.assign(prefs, patch); prefStorage.setItem('corpus.prefs', JSON.stringify(prefs)); applyPrefs(); }
function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme; else root.dataset.theme = prefs.theme;
  root.dataset.density = prefs.density;
  root.dataset.reader = prefs.readerSize;
}

const store = {
  records: [], byId: new Map(), concepts: [], conceptById: new Map(), children: new Map(), facets: [],
  overrides: {}, settings: {}, status: null, generatedAt: null, tagCache: new Map(), hay: new Map()
};
const ui = { view: 'library', query: '', filters: new Set(), status: 'active', visible: PAGE, readerList: [], readerId: null, inboxId: null, taxFacet: 'topic', taxSelected: null, taxQuery: '', railOpen: new Set(), mobileRail: false };

// ── data ────────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && path !== '/api/logout') { location.reload(); throw new Error('Signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

async function loadAll() {
  const [data, tax, state] = await Promise.all([
    fetch('/data/bookmarks.json', { cache: 'no-cache' }).then(r => { if (r.status === 401) location.reload(); return r.json(); }),
    fetch('/data/taxonomy.json', { cache: 'no-cache' }).then(r => r.json()),
    api('/api/state').catch(() => ({ overrides: {}, settings: {} }))
  ]);
  store.records = data.records;
  store.generatedAt = data.generatedAt;
  store.byId = new Map(data.records.map(r => [r.id, r]));
  setTaxonomy(tax);
  store.overrides = state.overrides || {};
  store.settings = state.settings || {};
  store.tagCache.clear(); store.hay.clear();
}

function setTaxonomy(tax) {
  store.facets = tax.facets;
  store.concepts = tax.concepts;
  store.conceptById = new Map(tax.concepts.map(c => [c.id, c]));
  store.children = new Map();
  for (const c of tax.concepts) if (c.parent) { if (!store.children.has(c.parent)) store.children.set(c.parent, []); store.children.get(c.parent).push(c.id); }
}

const label = (id) => store.conceptById.get(id)?.label || id.split(':').slice(1).join(':').split('/').pop().replace(/-/g, ' ');
const facetOf = (id) => store.conceptById.get(id)?.facet || id.split(':')[0];
function descendants(id) { const out = [id]; for (const c of store.children.get(id) || []) out.push(...descendants(c)); return out; }
function ancestors(id) { const out = []; let c = store.conceptById.get(id); while (c?.parent) { out.push(c.parent); c = store.conceptById.get(c.parent); } return out; }

function tagsOf(r) {
  let t = store.tagCache.get(r.id);
  if (t) return t;
  const o = store.overrides[r.id] || {};
  const removed = new Set(o.remove || []);
  const set = new Map();
  for (const tag of r.tags) if (!removed.has(tag.id)) set.set(tag.id, tag);
  for (const id of o.add || []) set.set(id, { id, by: 'you', score: 1, sources: ['you'] });
  // Manual format override replaces the machine format.
  if ((o.add || []).some(id => facetOf(id) === 'format')) for (const [id, tag] of set) if (facetOf(id) === 'format' && tag.by !== 'you') set.delete(id);
  t = [...set.values()];
  store.tagCache.set(r.id, t);
  return t;
}
const tagIds = (r) => tagsOf(r).map(t => t.id);
const formatOf = (r) => tagIds(r).find(id => facetOf(id) === 'format') || r.format;
const triage = (r) => store.overrides[r.id]?.triaged || null;

function haystack(r) {
  let h = store.hay.get(r.id);
  if (h) return h;
  h = [r.title, r.text, r.author.name, r.author.handle, ...(r.thread || []).map(t => t.text), r.article?.title, ...(r.article?.blocks || []).slice(0, 60).map(b => b.text || ''), r.card?.title, r.card?.description, r.card?.domain, r.quoted?.text, ...tagIds(r).map(label), store.overrides[r.id]?.note].filter(Boolean).join(' ').toLowerCase();
  store.hay.set(r.id, h);
  return h;
}

function matchesQuery(r, q) {
  if (!q) return true;
  const h = haystack(r);
  for (const term of q.toLowerCase().match(/"[^"]+"|\S+/g) || []) {
    if (term.startsWith('from:')) { if (r.author.handle.toLowerCase() !== term.slice(5).replace('@', '')) return false; continue; }
    if (!h.includes(term.replace(/"/g, ''))) return false;
  }
  return true;
}

// OR within a facet, AND across facets; parents include their descendants.
function filterGroups(filters) {
  const groups = new Map();
  for (const id of filters) { const f = facetOf(id); if (!groups.has(f)) groups.set(f, new Set()); for (const d of descendants(id)) groups.get(f).add(d); }
  return [...groups.values()];
}

function statusOk(r, status) {
  if (store.overrides[r.id]?.deleted) return status === 'deleted';
  const t = triage(r);
  if (status === 'active') return t !== 'archived';
  if (status === 'inbox') return !t;
  if (status === 'kept') return t === 'kept';
  if (status === 'archived') return t === 'archived';
  return true;
}

const SORTS = [['bookmarked', 'Recently saved'], ['oldest', 'Oldest saved'], ['posted', 'Newest posted'], ['posted-old', 'Oldest posted'], ['saves', 'Most saved'], ['likes', 'Most liked'], ['longest', 'Longest reads'], ['shortest', 'Quickest reads']];
const FORMAT_TABS = [['all', 'All'], ['format:thread', 'Threads'], ['format:article', 'Articles'], ['format:link', 'Links'], ['format:repo', 'Repos'], ['format:video', 'Video'], ['format:image', 'Images'], ['format:quote', 'Quotes'], ['format:post', 'Posts']];
const WINDOWS = [['all', 'Any time'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['older', 'Older than 30 days']];

// Rough reading length in characters: whole thread, article body, or the post.
function readLen(r) {
  if (r._len != null) return r._len;
  let n = r.thread ? r.thread.reduce((s, t) => s + (t.text?.length || 0), 0) : (r.text?.length || 0);
  if (r.article) n += r.article.blocks.reduce((s, b) => s + (b.text?.length || 0), 0);
  return (r._len = n);
}

function sortRecords(list, sort) {
  const eng = (r, k) => r.engagement?.[k] || 0;
  const by = {
    bookmarked: (a, b) => b.order - a.order,
    oldest: (a, b) => a.order - b.order,
    posted: (a, b) => String(b.postedAt).localeCompare(String(a.postedAt)),
    'posted-old': (a, b) => String(a.postedAt).localeCompare(String(b.postedAt)),
    saves: (a, b) => eng(b, 'bookmarkCount') - eng(a, 'bookmarkCount'),
    likes: (a, b) => eng(b, 'likeCount') - eng(a, 'likeCount'),
    longest: (a, b) => readLen(b) - readLen(a) || b.order - a.order,
    shortest: (a, b) => readLen(a) - readLen(b) || b.order - a.order
  }[sort] || ((a, b) => b.order - a.order);
  return list.sort(by);
}

function query({ q = ui.query, filters = ui.filters, status = ui.status, except } = {}) {
  const groups = filterGroups([...filters].filter(id => facetOf(id) !== except));
  return store.records.filter(r => {
    if (!statusOk(r, status) || !matchesQuery(r, q)) return false;
    if (!groups.length) return true;
    const ids = tagIds(r);
    return groups.every(g => ids.some(id => g.has(id)));
  });
}

async function saveOverride(ids, patch) {
  for (const id of ids) {
    const next = { ...(store.overrides[id] || {}) };
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
    store.overrides[id] = next; store.tagCache.delete(id); store.hay.delete(id);
  }
  try { await api('/api/overrides', { method: 'PUT', body: { ids, patch } }); }
  catch (e) { toast(`Not saved: ${e.message}`); }
}

async function setTags(r, { add = [], remove = [] }) {
  const o = store.overrides[r.id] || {};
  const machine = new Set(r.tags.map(t => t.id));
  let nextAdd = new Set(o.add || []), nextRemove = new Set(o.remove || []);
  for (const id of add) { nextRemove.delete(id); if (!machine.has(id)) nextAdd.add(id); }
  for (const id of remove) { nextAdd.delete(id); if (machine.has(id)) nextRemove.add(id); }
  // Picking a format by hand is exclusive.
  if (add.some(id => facetOf(id) === 'format')) for (const id of nextAdd) if (facetOf(id) === 'format' && !add.includes(id)) nextAdd.delete(id);
  await saveOverride([r.id], { add: [...nextAdd], remove: [...nextRemove] });
}

// ── rendering helpers ─────────────────────────────────────────────────────
const relDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), days = (Date.now() - d) / 864e5;
  if (days < 1 / 24) return days * 1440 < 2 ? 'now' : `${Math.round(days * 1440)}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};
const fullDate = (iso) => iso ? new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const img = (url, size = 'small') => /pbs\.twimg\.com\/media\//.test(url || '') ? `${url.split('?')[0]}?name=${size}` : url;
const avatar = (a) => a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="avatar blank">${esc((a.name || '?')[0])}</span>`;

function richText(text = '') {
  const parts = esc(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return parts.map(p => `<p>${p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}${u.length > 56 ? '…' : ''}</a>`).replace(/(^|\s)@(\w{1,15})/g, '$1<a href="https://x.com/$2" target="_blank" rel="noopener noreferrer">@$2</a>')}</p>`).join('');
}
const plain = (text = '') => text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

function snippet(r, n = 220, { afterTitle = false } = {}) {
  let t = plain(r.article?.preview || r.text) || r.card?.description || '';
  if (afterTitle && r.title && t.startsWith(r.title.replace(/…$/, ''))) t = t.slice(r.title.replace(/…$/, '').length).trim() || r.card?.description || '';
  return t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t;
}

const FORMAT_GLYPH = { 'format:thread': '≡', 'format:article': '¶', 'format:link': '↗', 'format:repo': '{}', 'format:video': '▶', 'format:image': '◐', 'format:quote': '❝', 'format:post': '·' };
function formatBadge(r) {
  const f = formatOf(r);
  const extra = f === 'format:thread' && r.thread ? ` · ${r.thread.length}` : '';
  return `<span class="fmt">${label(f)}${extra}</span>`;
}
// The n most confident descriptive tags; a parent is dropped when a confident child says more.
function topTags(r, n = 3) {
  const cands = tagsOf(r).filter(t => ['topic', 'kind', 'label'].includes(facetOf(t.id)))
    .map(t => ({ ...t, rank: t.by === 'you' ? 2 : (t.score ?? 0.5) }))
    .sort((a, b) => b.rank - a.rank);
  const implied = new Set(cands.filter(t => t.rank >= 0.4).flatMap(t => ancestors(t.id)));
  return cands.filter(t => !implied.has(t.id)).slice(0, n);
}
function tagPills(r, n = 3) {
  return topTags(r, n).map(t => {
    const path = [...ancestors(t.id).reverse().map(label), label(t.id)].join(' / ');
    const conf = t.by === 'you' ? 'added by you' : `${Math.round((t.score ?? 0) * 100)}% · ${(t.sources || [t.by]).join(' + ')}`;
    return `<span class="pill f-${facetOf(t.id)} ${t.by === 'you' ? 'mine' : ''}" title="${esc(`${path} — ${conf}`)}">${esc(label(t.id))}</span>`;
  }).join('');
}

function visual(r) {
  const m = r.media?.[0];
  if (m && (!r.sensitive || prefs.showSensitive)) return { url: img(m.url), w: m.width, h: m.height, video: m.type === 'video' || m.type === 'gif', count: r.media.length };
  if (r.article?.cover) return { url: r.article.cover, w: 5, h: 2 };
  if (r.card?.image) return { url: r.card.image, w: 1.91, h: 1 };
  return null;
}

function mediaTile(v, cls = '') {
  if (!v) return '';
  const ratio = v.w && v.h ? Math.max(0.56, Math.min(1.6, v.h / v.w)) : 0.66;
  return `<div class="tile-media ${cls}" style="--ratio:${ratio}"><img src="${esc(v.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">${v.video ? '<span class="media-flag">▶</span>' : v.count > 1 ? `<span class="media-flag">${v.count}</span>` : ''}</div>`;
}

function byline(r, withDate = true) {
  return `<div class="byline">${avatar(r.author)}<span class="name">${esc(r.author.name)}</span><span class="handle">@${esc(r.author.handle)}</span>${withDate ? `<span class="date">${relDate(r.postedAt)}</span>` : ''}</div>`;
}

function listItem(r) {
  const v = visual(r);
  return `<article class="row" data-open="${r.id}" tabindex="0">
    <div class="row-main">${byline(r)}<h3>${esc(r.title || snippet(r, 90))}</h3><p class="row-snippet">${esc(snippet(r, 240, { afterTitle: true }))}</p>
    <div class="meta">${formatBadge(r)}${tagPills(r)}${triage(r) ? `<span class="state">${triage(r)}</span>` : ''}</div></div>
    ${v ? `<div class="row-thumb"><img src="${esc(v.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` : ''}
  </article>`;
}

function gridItem(r) {
  const v = visual(r);
  return `<article class="card" data-open="${r.id}" tabindex="0">
    ${v ? mediaTile({ ...v, w: 16, h: 10 }, 'fixed') : `<div class="card-type">${esc(snippet(r, 160))}</div>`}
    <div class="card-body">${byline(r)}<h3>${esc(r.title || snippet(r, 90))}</h3>${v ? `<p class="card-snippet">${esc(snippet(r, 140, { afterTitle: true }))}</p>` : ''}
    <div class="meta">${formatBadge(r)}${tagPills(r)}</div></div>
  </article>`;
}

// Wall tiles vary by content so the columns read like a laid brick wall.
function wallItem(r) {
  const v = visual(r);
  const f = formatOf(r);
  const text = plain(r.text);
  let body;
  if (f === 'format:article' && !r.article) body = `<div class="tile-pad"><span class="kicker">Article</span><p class="lead">${esc(text || 'Long-form post on X')}</p><p class="muted small">Not captured yet — open to capture it now.</p></div>`;
  else if (f === 'format:article' && r.article) body = `${v ? mediaTile(v) : ''}<div class="tile-pad"><span class="kicker">Article</span><h3 class="serif">${esc(r.article.title)}</h3><p>${esc(snippet(r, 200))}</p></div>`;
  else if (f === 'format:thread' && r.thread) body = `<div class="tile-pad"><span class="kicker">Thread · ${r.thread.length}</span><p class="lead">${esc(text.length > 300 ? `${text.slice(0, 300).replace(/\s+\S*$/, '')}…` : text)}</p><ol class="thread-peek">${r.thread.slice(r.focalIndex + 1, r.focalIndex + 3).map(t => `<li>${esc(plain(t.text).slice(0, 110))}${plain(t.text).length > 110 ? '…' : ''}</li>`).join('')}</ol></div>${v ? mediaTile(v) : ''}`;
  else if (!v && text.length && text.length <= 180 && f !== 'format:link' && f !== 'format:repo') body = `<div class="tile-pad quote"><p class="serif big">${esc(text)}</p></div>`;
  else if ((f === 'format:link' || f === 'format:repo') && r.card) body = `${text ? `<div class="tile-pad"><p>${esc(snippet(r, 220))}</p></div>` : ''}<div class="linkcard">${r.card.image ? mediaTile({ url: r.card.image, w: 1.91, h: 1 }) : ''}<div class="linkcard-text"><span class="domain">${esc(r.card.domain || host(r.card.url))}</span><strong>${esc(r.card.title || '')}</strong></div></div>`;
  else body = `${v ? mediaTile(v) : ''}${text ? `<div class="tile-pad"><p>${esc(text.length > 420 ? `${text.slice(0, 420).replace(/\s+\S*$/, '')}…` : text)}</p></div>` : ''}`;
  const pills = tagPills(r);
  return `<article class="tile" data-open="${r.id}" tabindex="0">${body}${pills ? `<div class="tile-tags">${pills}</div>` : ''}<footer class="tile-foot">${byline(r, false)}<span class="date">${relDate(r.postedAt)}</span></footer></article>`;
}

function estimateHeight(r, colWidth) {
  const v = visual(r); const f = formatOf(r); const t = plain(r.text).length;
  let h = 86;
  if (v) h += colWidth * (v.w && v.h ? Math.max(0.56, Math.min(1.6, v.h / v.w)) : 0.66);
  if (f === 'format:thread') h += 160 + Math.min(300, t) * 0.5;
  else if (!v && t <= 180) h += 40 + t * 0.9;
  else h += Math.min(t, 420) * 0.42 + 24;
  return h;
}

// ── views ─────────────────────────────────────────────────────────────────
const view = () => $('#view');

function renderLibrary() {
  const results = sortRecords(query(), prefs.sort);
  ui.results = results;
  const shown = results.slice(0, ui.visible);
  const chips = [...ui.filters].map(id => `<button class="chip" data-unfilter="${esc(id)}">${esc(label(id))}<span aria-hidden="true">×</span></button>`).join('');
  view().className = 'view library';
  view().innerHTML = `
    <div class="rail-scrim ${ui.mobileRail ? 'open' : ''}" data-rail-close></div>
    <aside class="rail ${ui.mobileRail ? 'open' : ''}" aria-label="Filters">${renderRail()}</aside>
    <section class="stage">
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="count">${num.format(results.length)}</span>
          ${chips}${ui.filters.size || ui.query ? '<button class="ghost small" data-clear>Clear</button>' : ''}
        </div>
        <div class="toolbar-right">
          <button class="ghost rail-toggle" data-rail aria-expanded="${ui.mobileRail}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M4.5 8h7M6.5 12h3"/></svg>Filter${ui.filters.size ? `<span class="badge">${ui.filters.size}</span>` : ''}</button>
          <select id="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}" ${prefs.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="segmented" role="group" aria-label="Layout">${[['wall', 'Wall'], ['grid', 'Grid'], ['list', 'List']].map(([v, l]) => `<button data-layout="${v}" aria-pressed="${prefs.layout === v}">${l}</button>`).join('')}</div>
        </div>
      </div>
      <div id="results" class="results ${prefs.layout}"></div>
      ${results.length ? '' : `<div class="empty"><p class="serif">Nothing here.</p><button class="ghost" data-clear>Clear search and filters</button></div>`}
      <div id="sentinel" class="sentinel"></div>
    </section>`;
  paintResults(shown, true);
  observeSentinel();
}

function paintResults(items, reset) {
  const box = $('#results');
  if (!box) return;
  if (prefs.layout === 'wall') {
    const width = box.clientWidth || window.innerWidth;
    const cols = Math.max(1, Math.min(5, Math.floor((width + 20) / 300)));
    if (reset || !box._cols || box._cols.length !== cols) {
      box.innerHTML = Array.from({ length: cols }, () => '<div class="col"></div>').join('');
      box._cols = $$('.col', box); box._heights = new Array(cols).fill(0); box._painted = 0;
      items = ui.results.slice(0, ui.visible);
    }
    const colWidth = width / cols;
    const buckets = box._cols.map(() => []);
    for (const r of items) { const i = box._heights.indexOf(Math.min(...box._heights)); buckets[i].push(wallItem(r)); box._heights[i] += estimateHeight(r, colWidth) + 16; }
    buckets.forEach((html, i) => box._cols[i].insertAdjacentHTML('beforeend', html.join('')));
  } else {
    const tpl = prefs.layout === 'grid' ? gridItem : listItem;
    const html = items.map(tpl).join('');
    if (reset) box.innerHTML = html; else box.insertAdjacentHTML('beforeend', html);
  }
}

let sentinelObserver;
function observeSentinel() {
  sentinelObserver?.disconnect();
  const s = $('#sentinel');
  if (!s) return;
  sentinelObserver = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || ui.visible >= (ui.results?.length || 0)) return;
    const next = ui.results.slice(ui.visible, ui.visible + PAGE);
    ui.visible += PAGE;
    paintResults(next, false);
  }, { rootMargin: '1200px' });
  sentinelObserver.observe(s);
}

function setRail(open) {
  ui.mobileRail = open;
  $('.rail')?.classList.toggle('open', open);
  $('.rail-scrim')?.classList.toggle('open', open);
  $('.rail-toggle')?.setAttribute('aria-expanded', open);
  document.body.classList.toggle('rail-locked', open);
}

function renderRail() {
  const counts = new Map();
  // Facet counts respect everything except the facet's own selection, so choices stay visible.
  const perFacet = new Map();
  for (const f of ['topic', 'kind', 'format', 'contains', 'label']) perFacet.set(f, query({ except: f }));
  for (const [f, list] of perFacet) for (const r of list) {
    const seen = new Set();
    for (const id of tagIds(r)) { if (facetOf(id) !== f) continue; for (const a of [id, ...ancestors(id)]) if (!seen.has(a)) { seen.add(a); counts.set(a, (counts.get(a) || 0) + 1); } }
  }
  const statusCounts = { active: 0, inbox: 0, kept: 0, archived: 0 };
  for (const r of query({ status: 'all' })) { const t = triage(r); if (t !== 'archived') statusCounts.active++; if (!t) statusCounts.inbox++; if (t === 'kept') statusCounts.kept++; if (t === 'archived') statusCounts.archived++; }
  const item = (id, depth = 0) => {
    const c = store.conceptById.get(id);
    const kids = (store.children.get(id) || []).filter(k => counts.get(k) || ui.filters.has(k));
    const n = counts.get(id) || 0;
    if (!n && !ui.filters.has(id)) return '';
    const open = ui.railOpen.has(id) || kids.some(k => ui.filters.has(k));
    return `<li class="${ui.filters.has(id) ? 'on' : ''}" style="--depth:${depth}">
      <div class="rail-row">${kids.length ? `<button class="caret ${open ? 'open' : ''}" data-caret="${esc(id)}" aria-label="Expand">›</button>` : '<span class="caret-space"></span>'}<button class="rail-item" data-filter="${esc(id)}"><span>${esc(c?.label || label(id))}</span><span class="n">${num.format(n)}</span></button></div>
      ${kids.length && open ? `<ul>${kids.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0)).map(k => item(k, depth + 1)).join('')}</ul>` : ''}</li>`;
  };
  const section = (facet, title) => {
    const roots = store.concepts.filter(c => c.facet === facet && !c.parent).map(c => c.id).sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    const html = roots.map(id => item(id)).join('');
    return html ? `<section class="rail-group"><h4>${title}</h4><ul>${html}</ul></section>` : '';
  };
  return `<div class="rail-head"><strong>Filters</strong>${ui.filters.size ? '<button class="ghost small" data-clear>Clear</button>' : ''}<button class="primary small-btn" data-rail-close>Done</button></div><section class="rail-group"><h4>Status</h4><ul>${[['active', 'All'], ['inbox', 'Untriaged'], ['kept', 'Kept'], ['archived', 'Archived']].map(([v, l]) => `<li class="${ui.status === v ? 'on' : ''}"><div class="rail-row"><span class="caret-space"></span><button class="rail-item" data-status="${v}"><span>${l}</span><span class="n">${num.format(statusCounts[v])}</span></button></div></li>`).join('')}</ul></section>
    ${section('topic', 'Topic')}${section('kind', 'Kind')}${section('format', 'Format')}${section('contains', 'Contains')}${section('label', 'Labels')}`;
}

// ── inbox: one-at-a-time triage ──────────────────────────────────────────
function inboxBase() {
  const w = prefs.inboxWindow;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[w];
  const cutoff = days ? Date.now() - days * 864e5 : w === 'older' ? Date.now() - 30 * 864e5 : 0;
  return query({ status: 'inbox', filters: new Set(), q: '' }).filter(r => !cutoff || (w === 'older' ? new Date(r.postedAt) < cutoff : new Date(r.postedAt) >= cutoff));
}
// The queue: untriaged bookmarks in the chosen window, narrowed by type and topic, in the chosen order.
function inboxQueue() {
  const topicIds = prefs.inboxTopic ? new Set(descendants(prefs.inboxTopic)) : null;
  const list = inboxBase().filter(r => (prefs.inboxFormat === 'all' || formatOf(r) === prefs.inboxFormat) && (!topicIds || tagIds(r).some(id => topicIds.has(id))));
  return sortRecords(list, prefs.inboxSort);
}

function inboxControls(base) {
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

function renderInbox() {
  const base = inboxBase();
  const queue = inboxQueue();
  ui.inboxQueue = queue;
  if (!queue.find(r => r.id === ui.inboxId)) ui.inboxId = queue[0]?.id || null;
  const current = store.byId.get(ui.inboxId);
  view().className = 'view inbox';
  if (!base.length && prefs.inboxWindow === 'all') { view().innerHTML = `<div class="inbox-empty"><p class="serif big">Inbox zero.</p><p class="muted">New bookmarks from FieldTheory land here.</p></div>`; return; }
  const idx = current ? queue.indexOf(current) : -1;
  const head = `<div class="queue-head"><div class="queue-count"><span class="count">${num.format(queue.length)}</span><span class="muted">to triage${queue.length !== base.length ? ` · ${num.format(base.length)} in window` : ''}</span></div>${inboxControls(base)}</div>`;
  const list = current ? `<ol id="queue-list">${queue.slice(Math.max(0, idx - 3), idx + 60).map(r => `<li class="${r.id === current.id ? 'on' : ''}" data-pick="${r.id}"><span class="q-author">${esc(r.author.name)}<span class="q-date">${relDate(r.postedAt)}</span></span><span class="q-title">${esc((r.title || snippet(r, 80)).slice(0, 90))}</span><span class="q-meta">${label(formatOf(r))}${r.thread ? ` · ${r.thread.length}` : ''}</span></li>`).join('')}</ol>` : '';
  const main = current ? `
      <div class="triage-scroll"><div class="reader-body inline" id="triage-body">${readerContent(current)}</div></div>
      <div class="triage-bar">
        <button class="primary" data-triage="kept">Keep <kbd>⏎</kbd></button>
        <button class="ghost" data-triage="archived">Archive <kbd>e</kbd></button>
        <button class="ghost" data-skip>Skip <kbd>s</kbd></button>
        <span class="muted small">${idx + 1} of ${num.format(queue.length)}</span>
      </div>` : `<div class="inbox-empty"><p class="serif">Nothing to triage here.</p><button class="ghost" data-inbox-clear>Reset filters</button></div>`;
  view().innerHTML = `<aside class="queue" aria-label="Queue">${head}${list}</aside><section class="triage">${main}</section>`;
  if (current) captureNow(current);
}

async function triageCurrent(value) {
  const r = store.byId.get(ui.inboxId);
  if (!r) return;
  const queue = ui.inboxQueue || [];
  const next = queue[queue.indexOf(r) + 1];
  await saveOverride([r.id], { triaged: value });
  ui.inboxId = next?.id || null;
  updateInboxCount();
  renderInbox();
  $('.triage-scroll')?.scrollTo(0, 0);
}

// ── reader ──────────────────────────────────────────────────────────────
function readerContent(r) {
  const o = store.overrides[r.id] || {};
  const f = formatOf(r);
  const parts = r.thread || [{ id: r.id, text: r.text, media: r.media, links: r.links }];
  const title = r.article?.title || '';
  const showMedia = !r.sensitive || prefs.showSensitive;
  const mediaBlock = (media = []) => showMedia && media.length ? `<div class="r-media n${Math.min(media.length, 4)}">${media.map(m => m.video && (m.type === 'video' || m.type === 'gif')
    ? `<video controls playsinline preload="none" poster="${esc(m.url)}" ${m.type === 'gif' ? 'loop muted autoplay' : ''} src="${esc(m.video)}"></video>`
    : `<a href="${esc(img(m.url, 'orig'))}" target="_blank" rel="noopener"><img src="${esc(img(m.url, 'medium'))}" alt="${esc(m.alt || '')}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : '';
  const card = (c) => c && (c.title || c.image) ? `<a class="r-card" href="${esc(c.url || '#')}" target="_blank" rel="noopener noreferrer">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span class="domain">${esc(c.domain || host(c.url))}</span><strong>${esc(c.title || '')}</strong>${c.description ? `<span class="desc">${esc(c.description)}</span>` : ''}</a>` : '';
  const article = r.article ? `<div class="r-article">${r.article.cover ? `<img class="r-cover" src="${esc(r.article.cover)}" alt="" referrerpolicy="no-referrer">` : ''}${articleBlocks(r.article.blocks)}</div>` : '';
  const pending = r.enrichment === 'pending';
  return `
    <header class="r-head">${byline(r, false)}<div class="r-meta"><span>${fullDate(r.postedAt)}</span>${formatBadge(r)}<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open ${r.provider === 'twitter' ? 'on X' : esc(host(r.url))} ↗</a></div>
      ${title ? `<h1 class="r-title">${esc(title)}</h1>` : ''}</header>
    <div class="r-text">
      ${parts.map((p, i) => `<section class="r-part ${i === r.focalIndex && parts.length > 1 ? 'focal' : ''}">${parts.length > 1 ? `<span class="r-index">${String(i + 1).padStart(2, '0')}</span>` : ''}${r.article && i === 0 ? article : richText(i === r.focalIndex && r.card && !r.article ? stripCardUrl(p.text, r.card) : p.text)}${mediaBlock(p.media)}${i > 0 ? card(p.card) : ''}</section>`).join('')}
      ${!r.article ? card(r.card) : ''}
      ${r.quoted ? `<blockquote class="r-quote"><div class="byline">${avatar(r.quoted.author || {})}<span class="name">${esc(r.quoted.author?.name || '')}</span><span class="handle">@${esc(r.quoted.author?.handle || '')}</span></div>${richText(r.quoted.text)}${mediaBlock(r.quoted.media)}</blockquote>` : ''}
      ${pending ? `<p class="r-pending" data-pending="${r.id}">Capturing the full ${f === 'format:article' ? 'article' : 'thread'} from X…</p>` : ''}
    </div>
    <footer class="r-foot">
      <div class="r-section"><h4>Tags</h4><div class="tag-editor" data-tags="${r.id}">${tagEditor(r)}</div></div>
      <div class="r-section"><h4>Note</h4><textarea class="note" data-note="${r.id}" rows="2" placeholder="Why you saved this">${esc(o.note || '')}</textarea></div>
      <div class="r-stats"><span>${fmt.format(r.engagement.likeCount || 0)} likes</span><span>${fmt.format(r.engagement.repostCount || 0)} reposts</span><span>${fmt.format(r.engagement.bookmarkCount || 0)} saves</span></div>
    </footer>`;
}

function stripCardUrl(text, card) {
  const target = card.url ? card.url.replace(/\/$/, '') : null;
  return text.replace(/\s*(https?:\/\/\S+)\s*$/, (m, u) => (!target || u.replace(/\/$/, '') === target || host(u) === card.domain) ? '' : m);
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
    else if (/^h\d$/.test(b.type)) html += `<${b.type}>${esc(b.text)}</${b.type}>`;
    else html += `<p>${esc(b.text).replace(/\n/g, '<br>')}</p>`;
  }
  close();
  return html;
}

function tagEditor(r) {
  const tags = tagsOf(r).filter(t => !['source'].includes(facetOf(t.id)));
  const order = ['format', 'topic', 'kind', 'label', 'contains'];
  tags.sort((a, b) => order.indexOf(facetOf(a.id)) - order.indexOf(facetOf(b.id)));
  return `${tags.map(t => `<span class="tag f-${facetOf(t.id)} ${t.by === 'you' ? 'mine' : ''}" title="${esc(`${store.facets.find(f => f.id === facetOf(t.id))?.label || ''} · ${t.by}`)}">${esc(ancestors(t.id).length ? `${label(ancestors(t.id)[0])} / ${label(t.id)}` : label(t.id))}<button data-untag="${esc(t.id)}" aria-label="Remove">×</button></span>`).join('')}
    <span class="tag-add"><input data-tag-input placeholder="Add tag…" autocomplete="off"><div class="suggest" hidden></div></span>`;
}

function openReader(id, list) {
  const r = store.byId.get(id);
  if (!r) return;
  ui.readerId = id;
  rememberOpened(id);
  if (list) ui.readerList = list;
  const el = $('#reader');
  $('#reader-body').innerHTML = readerContent(r);
  showReaderTab('read');
  captureNow(r);
  el.hidden = false;
  document.body.classList.add('locked');
  requestAnimationFrame(() => el.classList.add('in'));
  $('.reader-sheet').scrollTop = 0;
  $('.reader-sheet').focus({ preventScroll: true });
  if (location.pathname !== `/b/${id}`) history.pushState({ reader: id, from: location.pathname + location.search }, '', `/b/${id}`);
}

function closeReader({ fromPop = false } = {}) {
  const el = $('#reader');
  if (el.hidden) return;
  el.classList.remove('in');
  document.body.classList.remove('locked');
  setTimeout(() => { el.hidden = true; }, 180);
  const last = ui.readerId;
  ui.readerId = null;
  if (!fromPop) { const st = history.state; if (st?.reader && st.from) history.back(); else history.replaceState({}, '', '/'); }
  if (ui.view === 'library') { refreshCards(); focusCardById(last); }
}

function stepReader(d) {
  const list = ui.readerList.length ? ui.readerList : (ui.results || []);
  const i = list.findIndex(r => r.id === ui.readerId);
  const next = list[i + d];
  if (next) { history.replaceState({ ...history.state, reader: next.id }, '', `/b/${next.id}`); openReader(next.id); }
}

// Uncaptured bookmark opened: move it to the front of the capture queue and fill it in when ready.
const capturing = new Set();
async function captureNow(r) {
  if (r.enrichment !== 'pending' || capturing.has(r.id)) return;
  capturing.add(r.id);
  try { await api('/api/enrich/priority', { method: 'POST', body: { id: r.id } }); } catch { capturing.delete(r.id); return; }
  for (let i = 0; i < 90 && r.enrichment === 'pending'; i++) {
    await new Promise(res => setTimeout(res, i < 6 ? 2000 : 5000));
    const res = await fetch(`/api/enrichment/${r.id}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok) { applyEnrichment(r, body); break; }
    const note = $$(`[data-pending="${r.id}"]`);
    if (body.waitingUntil) note.forEach(n => { n.textContent = `Queued — X’s rate limit resets in ${Math.max(1, Math.round((body.waitingUntil - Date.now()) / 60000))} min, then this is captured first.`; });
  }
  capturing.delete(r.id);
  if (ui.readerId === r.id) { $('#reader-body').innerHTML = readerContent(r); }
  if (ui.inboxId === r.id && ui.view === 'inbox' && $('#triage-body')) $('#triage-body').innerHTML = readerContent(r);
}

function applyEnrichment(r, enr) {
  r.enrichment = enr.status;
  r.enrichedAt = enr.fetchedAt;
  if (enr.status !== 'ok') return;
  const focalIndex = Math.max(0, enr.thread.findIndex(t => t.id === r.id));
  const focal = enr.thread[focalIndex];
  if (focal) { r.text = focal.text; if (focal.media?.length) r.media = focal.media; }
  if (enr.thread.length > 1) { r.thread = enr.thread; r.focalIndex = focalIndex; r.format = 'format:thread'; r.tags = [...r.tags.filter(t => facetOf(t.id) !== 'format'), { id: 'format:thread', by: 'rule', score: 1 }]; }
  if (enr.article) { r.article = enr.article; r.title = enr.article.title || r.title; }
  if (enr.card) r.card = { ...enr.card, url: enr.card.url || r.links.find(l => !/x\.com|twitter\.com/.test(l)) || null };
  if (enr.quoted) r.quoted = { ...enr.quoted, author: enr.quoted.author };
  store.tagCache.delete(r.id); store.hay.delete(r.id);
}

function refreshCards() {
  // Re-render in place after tag edits so the grid reflects overrides.
  if (ui.view !== 'library') return;
  const y = window.scrollY;
  renderLibrary();
  window.scrollTo(0, y);
}

// ── tag input with create-on-the-fly ─────────────────────────────────────
function suggestions(q, r) {
  const have = new Set(tagIds(r));
  const lq = q.toLowerCase().trim();
  const out = store.concepts.filter(c => !have.has(c.id) && c.facet !== 'source' && (!lq || c.label.toLowerCase().includes(lq) || c.id.includes(lq) || (c.aliases || []).some(a => a.startsWith(lq))))
    .sort((a, b) => (a.label.toLowerCase().startsWith(lq) ? 0 : 1) - (b.label.toLowerCase().startsWith(lq) ? 0 : 1) || a.label.length - b.label.length)
    .slice(0, 8).map(c => ({ id: c.id, text: c.parent ? `${label(c.parent)} / ${c.label}` : c.label, facet: c.facet }));
  if (lq && !store.concepts.some(c => c.label.toLowerCase() === lq)) {
    out.push({ create: 'label', text: `New label “${q.trim()}”` }, { create: 'topic', text: `New topic “${q.trim()}”` });
  }
  return out;
}
const slug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

async function createConcept({ facet, labelText, parent = null, aliases = [] }) {
  const id = `${facet}:${parent ? `${parent.split(':')[1]}/` : ''}${slug(labelText)}`;
  const concept = { label: labelText.trim(), facet, parent, aliases };
  await api('/api/taxonomy', { method: 'PUT', body: { id, patch: concept } });
  const c = { id, ...concept, origin: 'user' };
  if (!store.conceptById.has(id)) setTaxonomy({ facets: store.facets, concepts: [...store.concepts, c] });
  return id;
}

// ── taxonomy ────────────────────────────────────────────────────────────
function conceptCounts() {
  const counts = new Map();
  for (const r of store.records) { const seen = new Set(); for (const id of tagIds(r)) for (const a of [id, ...ancestors(id)]) if (!seen.has(a)) { seen.add(a); counts.set(a, (counts.get(a) || 0) + 1); } }
  return counts;
}

function renderTaxonomy() {
  const counts = conceptCounts();
  const facet = ui.taxFacet;
  const q = ui.taxQuery.toLowerCase();
  const inFacet = store.concepts.filter(c => c.facet === facet);
  const max = Math.max(1, ...inFacet.map(c => counts.get(c.id) || 0));
  const matches = (c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q) || (c.aliases || []).some(a => a.includes(q));
  const visibleIds = new Set();
  for (const c of inFacet) if (matches(c)) { visibleIds.add(c.id); ancestors(c.id).forEach(a => visibleIds.add(a)); }
  const rows = (parent, depth) => inFacet.filter(c => (c.parent || null) === parent && visibleIds.has(c.id)).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)).map(c => {
    const n = counts.get(c.id) || 0;
    return `<div class="t-row ${ui.taxSelected === c.id ? 'on' : ''} ${depth ? 'child' : ''}" data-concept="${esc(c.id)}" style="--depth:${depth}" tabindex="0">
      <span class="t-label">${esc(c.label)}${c.origin === 'user' ? '<span class="dot" title="Added by you"></span>' : ''}</span>
      <span class="t-id">${esc(c.id)}</span>
      <span class="t-alias">${(c.aliases || []).length || ''}</span>
      <span class="t-count"><span class="bar" style="--w:${(n / max) * 100}%"></span>${num.format(n)}</span>
    </div>${rows(c.id, depth + 1)}`;
  }).join('');
  const untagged = store.records.filter(r => !tagIds(r).some(id => facetOf(id) === 'topic')).length;
  view().className = 'view taxonomy';
  view().innerHTML = `
    <div class="page-head"><h1 class="serif">Taxonomy</h1>
      <div class="page-actions"><input class="field" id="tax-search" placeholder="Filter concepts" value="${esc(ui.taxQuery)}"><button class="primary" data-new-concept>New concept</button></div></div>
    <nav class="tabs">${store.facets.filter(f => f.id !== 'source').map(f => `<button data-facet="${f.id}" aria-pressed="${facet === f.id}">${f.label}<span>${store.concepts.filter(c => c.facet === f.id).length}</span></button>`).join('')}</nav>
    <div class="t-layout">
      <div class="t-table">
        <div class="t-row head"><span>Concept</span><span class="t-id">ID</span><span class="t-alias">Aliases</span><span class="t-count">Bookmarks</span></div>
        ${rows(null, 0) || '<p class="muted pad">No concepts yet. Add one, or create labels from any bookmark.</p>'}
        ${facet === 'topic' && untagged ? `<button class="t-untagged" data-view-untagged>${num.format(untagged)} bookmarks have no topic →</button>` : ''}
      </div>
      <aside class="t-detail" id="t-detail">${conceptDetail(ui.taxSelected, counts)}</aside>
    </div>`;
}

function conceptDetail(id, counts) {
  const isNew = id === '__new';
  const c = isNew ? { id: '', label: '', facet: ui.taxFacet, parent: null, aliases: [] } : store.conceptById.get(id);
  if (!c) return `<div class="t-empty"><p class="muted">Select a concept to rename it, move it under another, or edit the keywords that route bookmarks to it.</p></div>`;
  const parents = store.concepts.filter(p => p.facet === c.facet && p.id !== c.id && !descendants(c.id).includes(p.id));
  const samples = isNew ? [] : sortRecords(store.records.filter(r => tagIds(r).some(t => descendants(c.id).includes(t))), 'bookmarked').slice(0, 5);
  return `<form class="t-form" data-concept-form="${esc(c.id)}">
    <h2 class="serif">${isNew ? 'New concept' : esc(c.label)}</h2>
    ${isNew ? '' : `<p class="mono muted small">${esc(c.id)} · ${num.format(counts.get(c.id) || 0)} bookmarks</p>`}
    <label>Name<input class="field" name="label" value="${esc(c.label)}" required></label>
    <label>Facet<select class="field" name="facet" ${isNew ? '' : 'disabled'}>${store.facets.filter(f => f.id !== 'source').map(f => `<option value="${f.id}" ${f.id === c.facet ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
    <label>Parent<select class="field" name="parent"><option value="">None (top level)</option>${parents.map(p => `<option value="${esc(p.id)}" ${p.id === c.parent ? 'selected' : ''}>${esc(p.parent ? `${label(p.parent)} / ${p.label}` : p.label)}</option>`).join('')}</select></label>
    <label>Keywords<textarea class="field" name="aliases" rows="4" placeholder="comma separated — bookmarks mentioning these get this tag">${esc((c.aliases || []).join(', '))}</textarea></label>
    <div class="t-form-actions"><button class="primary" type="submit">${isNew ? 'Create' : 'Save'}</button>${isNew ? '<button class="ghost" type="button" data-cancel-concept>Cancel</button>' : `<button class="ghost" type="button" data-browse="${esc(c.id)}">View bookmarks</button><button class="ghost danger" type="button" data-delete-concept="${esc(c.id)}">${c.origin === 'user' ? 'Delete' : 'Retire'}</button>`}</div>
    ${samples.length ? `<div class="t-samples"><h4>Recent</h4>${samples.map(r => `<button type="button" class="t-sample" data-open="${r.id}"><span>${esc((r.title || snippet(r, 80)).slice(0, 80))}</span><span class="muted">@${esc(r.author.handle)}</span></button>`).join('')}</div>` : ''}
  </form>`;
}

// ── settings ────────────────────────────────────────────────────────────
const SETTINGS_SECTIONS = [
  ['appearance', 'Appearance'], ['library', 'Library & inbox'], ['sources', 'Sources'], ['classification', 'Classification'],
  ['chat', 'Chat'], ['skills', 'Skills'], ['agents', 'Agents & MCP'], ['account', 'Account & data']
];
let cachedSkills = null;
let skillSel = null; // skill name, '__new', or null
async function loadSkills() { cachedSkills = (await api('/api/skills').catch(() => ({ skills: [] }))).skills; }

function settingsSection() {
  const s = location.pathname.split('/')[2];
  return SETTINGS_SECTIONS.some(([id]) => id === s) ? s : 'appearance';
}

function renderSettings() {
  const section = settingsSection();
  const s = store.status;
  const e = s?.enrichment;
  const enriched = store.records.filter(r => r.enrichment !== 'pending').length;
  const threads = store.records.filter(r => r.thread).length;
  const seg = (key, options) => `<div class="segmented">${options.map(([v, l]) => `<button data-pref="${key}" data-value="${v}" aria-pressed="${String(prefs[key]) === String(v)}">${l}</button>`).join('')}</div>`;
  const row = (title, desc, control) => `<div class="s-row"><div><strong>${title}</strong>${desc ? `<p>${desc}</p>` : ''}</div><div class="s-control">${control}</div></div>`;
  const toggle = (key, on, attr = 'data-pref-toggle') => `<button class="switch" ${attr}="${key}" role="switch" aria-checked="${on}"><span></span></button>`;
  const group = (title, rows) => `<section class="s-group">${title ? `<h4>${title}</h4>` : ''}${rows}</section>`;

  const bodies = {
    appearance: () => group('', `
      ${row('Theme', '', seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]))}
      ${row('Density', 'Spacing between cards and rows.', seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]))}
      ${row('Reader text', 'Size of text in the reader and chat answers.', seg('readerSize', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]))}
      ${row('Show sensitive media', 'Posts flagged as sensitive by X.', toggle('showSensitive', prefs.showSensitive))}`),
    library: () => group('Library', `
      ${row('Layout', 'How bookmarks are drawn in the library.', seg('layout', [['wall', 'Wall'], ['grid', 'Grid'], ['list', 'List']]))}
      ${row('Default order', '', `<select id="settings-sort" aria-label="Default order">${SORTS.map(([v, l]) => `<option value="${v}" ${prefs.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}`) +
      group('Inbox', `
      ${row('Clear the backlog', 'Mark every untriaged bookmark older than 30 days as kept.', '<button class="ghost" data-backlog>Mark as kept</button>')}
      ${row('Untriaged', `${num.format(inboxBase().length)} bookmarks waiting. Sort and filter them from the Inbox.`, '<a class="ghost" href="/inbox" data-link>Open inbox</a>')}`),
    sources: () => group('', `
      ${row('FieldTheory', `${esc(s?.source?.path || '—')}<br>Updated ${s?.source?.modifiedAt ? `${relDate(s.source.modifiedAt)} ago` : '—'} · Index built ${store.generatedAt ? `${relDate(store.generatedAt)} ago` : '—'} · ${num.format(store.records.length)} bookmarks`, '<button class="ghost" data-refresh>Rebuild now</button>')}
      ${row('Thread unrolling', e?.available ? `${num.format(enriched)} of ${num.format(store.records.length)} captured · ${num.format(threads)} threads unrolled${e.queued ? ` · ${num.format(e.queued)} queued` : ''}${e.yieldingTo ? ' · paused while the backfill script runs' : ''}${e.waitingUntil ? ` · rate-limited until ${new Date(e.waitingUntil).toLocaleTimeString()}` : ''}${e.lastError ? `<br><span class="warn">${esc(e.lastError)}</span>` : ''}` : 'X session cookies not found. Threads and articles can’t be expanded.', e?.available ? toggle('enrich', e.enabled, 'data-server-toggle') : '')}
      ${row('Saved web pages', `${num.format(store.records.filter(r => r.provider === 'web').length)} pages saved by URL (via Ask or MCP <code>create_bookmark</code>).`, '')}`),
    classification: () => group('', `
      ${row('TypeSafe Jev', s?.classifiers?.typesafe ? `${num.format(s?.build?.classified || 0)} of ${num.format(store.records.length)} classified from full thread content${s?.backfill ? ` · backfill ${s.backfill.running ? 'running' : s.backfill.stage}${s.backfill.running ? ` (${num.format(s.backfill.pending)} threads left to capture)` : ''}` : ''}. Run <code>npm run backfill</code> to process everything.` : 'Set TYPESAFE_API_KEY on the server.', `<span class="mono small">${s?.classifiers?.typesafe ? 'on' : 'off'}</span>`)}
      ${row('Keyword rules', 'Concept keywords from the taxonomy.', '<a class="ghost" href="/taxonomy" data-link>Open taxonomy</a>')}
      ${row('FieldTheory categories', 'Domains and categories from FieldTheory’s classifier.', '<span class="mono small">on</span>')}`),
    chat: () => group('', `
      ${row('OpenRouter', s?.chat?.available ? 'Chat and Ask run through OpenRouter.' : 'Set OPENROUTER_API_KEY on the server.', `<span class="mono small">${s?.chat?.available ? 'on' : 'off'}</span>`)}
      ${row('Default model', chatModels().map(m => `${esc(m.label)} <span class="muted">${esc(m.note)}</span>`).join('<br>'), `<select id="settings-model" aria-label="Default model">${chatModels().map(m => `<option value="${esc(m.id)}" ${(prefs.chatModel || chatModels()[0]?.id) === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`)}
      ${row('Tools', 'The assistant can search and read bookmarks, tag, triage and annotate them, save web pages, edit the taxonomy and skills, and run Jev. It asks before deleting or bulk changes.', '<a class="ghost" href="/ask" data-link>Open Ask</a>')}`),
    skills: () => skillsManager(),
    agents: () => group('', `
      ${row('MCP endpoint', 'Every Corpus capability as MCP tools; skills appear as prompts.', `<button class="ghost" data-copy-mcp="url">Copy URL</button>`)}
      ${row('Token', 'Send as <code>Authorization: Bearer …</code>. Stored on the server as CORPUS_MCP_TOKEN.', `<button class="ghost" data-copy-mcp="token">Copy token</button>`)}
      ${row('Claude Code', '<code>claude mcp add --transport http corpus &lt;url&gt; --header "Authorization: Bearer &lt;token&gt;"</code>', `<button class="ghost" data-copy-mcp="claude">Copy command</button>`)}
      ${row('Hermes', 'Add to <code>mcp_servers</code> in config.yaml.', `<button class="ghost" data-copy-mcp="hermes">Copy YAML</button>`)}
      ${row('stdio bridge', 'For clients that launch a command: <code>node scripts/mcp-stdio.mjs</code>', '')}`),
    account: () => group('This device', installRow(row)) +
      group('Access', row('Password', s?.passwordProtected ? 'Corpus is behind a password. Sessions last 30 days per device.' : 'Not protected. Set CORPUS_PASSWORD_HASH on the server.', s?.passwordProtected ? '<button class="ghost" data-logout>Sign out</button>' : '')) +
      group('Data', `
      ${row('Export', 'Bookmarks with your tags, notes and triage state.', '<button class="ghost" data-export>Download JSON</button>')}
      ${row('Reset this device', 'Clears layout and appearance preferences here. Your tags and notes are kept.', '<button class="ghost danger" data-reset-prefs>Reset</button>')}`)
  };
  const title = SETTINGS_SECTIONS.find(([id]) => id === section)[1];
  view().className = 'view settings';
  view().innerHTML = `
    <aside class="s-nav" aria-label="Settings sections">
      <h1 class="serif">Settings</h1>
      <nav>${SETTINGS_SECTIONS.map(([id, l]) => `<a href="/settings/${id}" data-link aria-current="${id === section ? 'page' : 'false'}">${esc(l)}${id === 'skills' && cachedSkills ? `<span class="n">${cachedSkills.length}</span>` : ''}</a>`).join('')}</nav>
    </aside>
    <section class="s-main"><h2 class="s-title">${esc(title)}</h2>${bodies[section]()}</section>`;
  // On phones the sections are a scrolling tab row: keep the current one in view.
  const nav = $('.s-nav nav'), cur = $('.s-nav a[aria-current="page"]');
  if (nav && cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
  if (section === 'skills' && !cachedSkills) loadSkills().then(() => { if (ui.view === 'settings' && settingsSection() === 'skills') renderSettings(); });
}

function skillsManager() {
  if (!cachedSkills) return '<p class="muted">Loading…</p>';
  const sel = skillSel === '__new' ? { name: '', description: '', instructions: '', isNew: true } : cachedSkills.find(k => k.name === skillSel) || null;
  return `<p class="s-lede">Skills are saved procedures the assistant follows on request — in Ask, and for any agent connected over MCP (they appear as prompts).</p>
  <div class="skills">
    <div class="skills-list">
      <button class="ghost skills-new" data-skill-new>New skill</button>
      ${cachedSkills.map(k => `<button class="skill-item ${k.name === skillSel ? 'on' : ''}" data-skill="${esc(k.name)}"><span class="mono">${esc(k.name)}</span><span class="muted">${esc(k.description)}</span></button>`).join('') || '<p class="muted small">No skills yet.</p>'}
    </div>
    <div class="skill-detail">${sel ? `
      <form class="skill-form" data-skill-form="${esc(sel.name)}">
        <label>Name<input class="field" name="name" value="${esc(sel.name)}" ${sel.isNew ? 'required placeholder="e.g. monthly-review"' : 'readonly'}></label>
        <label>Description<input class="field" name="description" value="${esc(sel.description)}" required placeholder="One line: what it does and when to use it"></label>
        <label>Instructions<textarea class="field" name="instructions" rows="14" required placeholder="Step by step: which tools to use, what to produce, when to ask before changing things.">${esc(sel.instructions)}</textarea></label>
        <div class="t-form-actions">
          <button class="primary" type="submit">${sel.isNew ? 'Create skill' : 'Save'}</button>
          ${sel.isNew ? '<button class="ghost" type="button" data-skill-cancel>Cancel</button>' : `<button class="ghost" type="button" data-skill-run="${esc(sel.name)}">Run in Ask</button><button class="ghost danger" type="button" data-skill-delete="${esc(sel.name)}">Delete</button>`}
        </div>
        ${sel.updatedAt ? `<p class="muted small mono">Updated ${relDate(sel.updatedAt)} ago</p>` : ''}
      </form>` : '<div class="t-empty"><p class="muted">Select a skill to read or edit it, or create a new one. You can also ask the assistant to “save this as a skill”.</p></div>'}
    </div>
  </div>`;
}

async function skillOp(tool, args) {
  const res = await fetch('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json.result;
}

// ── chat ────────────────────────────────────────────────────────────────
const sessions = new Map(); // key -> { key, scope, bookmarkId, conversationId, messages, streaming, status }
const chatModels = () => store.status?.chat?.models || [];
const modelLabel = (id) => chatModels().find(m => m.id === id)?.label || (id || '').split('/').pop();

function session(key, init) {
  if (!sessions.has(key)) sessions.set(key, { key, messages: [], conversationId: null, streaming: false, status: '', ...init });
  return sessions.get(key);
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

// Small Markdown renderer. Input is escaped first; [[id]] becomes a numbered citation.
function md(text, cites) {
  const out = [];
  const blocks = String(text).split(/```/);
  blocks.forEach((chunk, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(chunk.replace(/^\w*\n/, ''))}</code></pre>`); return; }
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para.length = 0; } };
    for (const raw of chunk.split('\n')) {
      let line = esc(raw).replace(/\[\[([\w-]{6,})\]\]/g, (m, id) => {
        const r = store.byId.get(id);
        if (!r) return '';
        if (!cites.includes(id)) cites.push(id);
        return `<button class="cite" data-open="${id}" title="${esc(`@${r.author.handle} — ${(r.title || '').slice(0, 80)}`)}">${cites.indexOf(id) + 1}</button>`;
      });
      const h = line.match(/^(#{1,4})\s+(.*)/), li = line.match(/^\s*[-*•]\s+(.*)/), oli = line.match(/^\s*\d+[.)]\s+(.*)/), q = line.match(/^&gt;\s?(.*)/);
      if (h) { flush(); close(); out.push(`<h4>${inline(h[2])}</h4>`); }
      else if (li || oli) { flush(); const tag = li ? 'ul' : 'ol'; if (list !== tag) { close(); out.push(`<${tag}>`); list = tag; } out.push(`<li>${inline((li || oli)[1])}</li>`); }
      else if (q) { flush(); close(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); }
      else if (!line.trim()) { flush(); close(); }
      else { close(); para.push(inline(line)); }
    }
    flush(); close();
  });
  return out.join('');
}

function messageHtml(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="msg-body">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
  const cites = [];
  const body = m.content ? md(m.content, cites) : '';
  const sources = cites.map(id => store.byId.get(id)).filter(Boolean);
  const meta = m.error ? `<span class="warn">${esc(m.error)}</span>` : m.streaming ? `<span class="thinking">${esc(m.status || 'Thinking')}</span>` : [modelLabel(m.model), m.usage?.cost ? `$${m.usage.cost < 0.001 ? m.usage.cost.toFixed(5) : m.usage.cost.toFixed(4)}` : m.model?.endsWith(':free') ? 'free' : ''].filter(Boolean).join(' · ');
  return `<div class="msg assistant ${m.streaming ? 'streaming' : ''}"><div class="msg-body">${body}</div>
    ${sources.length ? `<div class="msg-sources">${sources.map((r, i) => `<button data-open="${r.id}"><span class="n">${i + 1}</span>${avatar(r.author)}<span class="s-title">${esc((r.title || snippet(r, 80)).slice(0, 90))}</span><span class="muted">@${esc(r.author.handle)}</span></button>`).join('')}</div>` : ''}
    ${m.actions?.length ? `<ul class="msg-actions">${m.actions.map(a => `<li>${esc(a.summary)}</li>`).join('')}</ul>` : ''}
    <div class="msg-meta">${meta}</div></div>`;
}

function chatSuggestions(s) {
  if (s.scope === 'bookmark') return ['Summarize this', 'What are the key ideas, step by step?', 'How could I apply this?', 'What else have I saved like this?'];
  const counts = new Map();
  for (const r of store.records) for (const t of topTags(r, 2)) if (facetOf(t.id) === 'topic') counts.set(t.id, (counts.get(t.id) || 0) + 1);
  const [a, b] = [...counts].sort((x, y) => y[1] - x[1]).map(([id]) => label(id));
  return [`What have I saved about ${a || 'AI'}?`, 'Which threads from the last two weeks are worth reading first?', `What do the people I save say about ${b || 'design'}?`, 'Which tools keep coming up in my bookmarks?'];
}

function chatHtml(s) {
  const models = chatModels();
  const current = prefs.chatModel && models.some(m => m.id === prefs.chatModel) ? prefs.chatModel : models[0]?.id;
  const empty = !s.messages.length;
  return `<div class="chat ${empty ? 'is-empty' : ''}" data-chat="${esc(s.key)}">
    <div class="chat-log">${empty ? `<div class="chat-empty"><span class="kicker">${s.scope === 'bookmark' ? 'Ask about this bookmark' : 'Ask your corpus'}</span>${chatSuggestions(s).map(q => `<button class="suggestion" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : s.messages.map(messageHtml).join('')}</div>
    <form class="composer" data-composer="${esc(s.key)}">
      <textarea rows="1" placeholder="${s.scope === 'bookmark' ? 'Ask about this…' : 'Ask anything about what you’ve saved…'}" ${store.status?.chat?.available ? '' : 'disabled'}></textarea>
      <div class="composer-bar">
        <select class="chat-model" aria-label="Model">${models.map(m => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.label)} · ${esc(m.note)}</option>`).join('')}</select>
        ${s.messages.length ? '<button type="button" class="ghost small" data-chat-reset>New</button>' : ''}
        <button class="primary send" type="submit" ${s.streaming ? 'disabled' : ''}>Send <kbd>⏎</kbd></button>
      </div>
    </form></div>`;
}

function paintChat(s, { full = false } = {}) {
  for (const el of $$(`[data-chat="${CSS.escape(s.key)}"]`)) {
    if (full || !el.querySelector('.msg.streaming')) { const draft = el.querySelector('textarea')?.value || ''; el.outerHTML = chatHtml(s); const n = $(`[data-chat="${CSS.escape(s.key)}"] textarea`); if (n) n.value = draft; }
    else { el.querySelector('.msg.streaming').outerHTML = messageHtml(s.messages.at(-1)); }
    const log = $(`[data-chat="${CSS.escape(s.key)}"] .chat-log`);
    const scroller = log?.closest('.reader-sheet') || log;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

async function sendChat(s, text) {
  text = text.trim();
  if (!text || s.streaming) return;
  const model = $(`[data-chat="${CSS.escape(s.key)}"] .chat-model`)?.value || chatModels()[0]?.id;
  savePrefs({ chatModel: model });
  s.messages.push({ role: 'user', content: text });
  const msg = { role: 'assistant', content: '', streaming: true, status: 'Thinking', model };
  s.messages.push(msg);
  s.streaming = true;
  paintChat(s, { full: true });
  let raf = 0, mutated = false;
  const repaint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintChat(s); }); };
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: s.scope, bookmarkId: s.bookmarkId, conversationId: s.conversationId, message: text, model }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] || '{}');
        if (event === 'meta') { s.conversationId = data.conversationId; }
        else if (event === 'status') { msg.status = data.text; repaint(); }
        else if (event === 'delta') { msg.content += data.text; msg.status = 'Writing'; repaint(); }
        else if (event === 'action') { (msg.actions ||= []).push(data); repaint(); }
        else if (event === 'done') { msg.model = data.model; msg.usage = data.usage; mutated = data.mutated; }
        else if (event === 'error') throw new Error(data.message);
      }
    }
  } catch (e) { msg.error = e.message; }
  msg.streaming = false; s.streaming = false;
  if (mutated) { await loadAll(); updateInboxCount(); if (ui.readerId && store.byId.get(ui.readerId)) { for (const box of $$(`[data-tags="${ui.readerId}"]`)) box.innerHTML = tagEditor(store.byId.get(ui.readerId)); } toast('Library updated'); }
  paintChat(s, { full: true });
  if (s.scope === 'corpus' && ui.view === 'ask') { loadChatList().then(renderAskSide); if (location.pathname !== `/ask/${s.conversationId}`) history.replaceState({}, '', `/ask/${s.conversationId}`); }
}

async function loadConversation(s, id) {
  const c = await api(`/api/chats/${id}`).catch(() => null);
  if (!c) return;
  s.conversationId = c.id;
  s.messages = c.messages.map(m => ({ role: m.role, content: m.content, model: m.model, usage: m.usage, actions: m.actions }));
}

// Reader chat tab: one running conversation per bookmark.
async function showReaderTab(tab) {
  ui.readerTab = tab;
  $$('[data-rtab]').forEach(b => b.setAttribute('aria-pressed', b.dataset.rtab === tab));
  $('#reader-body').hidden = tab !== 'read';
  const box = $('#reader-chat');
  box.hidden = tab !== 'chat';
  if (tab !== 'chat') return;
  const s = session(`b:${ui.readerId}`, { scope: 'bookmark', bookmarkId: ui.readerId });
  if (!s.loaded) {
    s.loaded = true;
    const { chats } = await api(`/api/chats?bookmark=${ui.readerId}`).catch(() => ({ chats: [] }));
    if (chats[0]) await loadConversation(s, chats[0].id);
  }
  box.innerHTML = chatHtml(s);
  const sheet = $('.reader-sheet'); sheet.scrollTop = sheet.scrollHeight;
  $('textarea', box)?.focus();
}

// Ask page: conversations over the whole corpus.
let chatList = [];
async function loadChatList() { chatList = (await api('/api/chats?scope=corpus').catch(() => ({ chats: [] }))).chats; }
function renderAskSide() {
  const side = $('.ask-side ol');
  if (!side) return;
  const cur = sessions.get('corpus')?.conversationId;
  side.innerHTML = chatList.map(c => `<li class="${c.id === cur ? 'on' : ''}"><a href="/ask/${c.id}" data-link>${esc(c.title)}</a><span class="muted mono">${relDate(c.updatedAt)}</span><button class="x" data-del-chat="${c.id}" aria-label="Delete">×</button></li>`).join('') || '<li class="muted small">No conversations yet</li>';
}
async function renderAsk() {
  view().className = 'view ask';
  const id = location.pathname.split('/')[2] || null;
  const s = session('corpus', { scope: 'corpus' });
  if (id && s.conversationId !== id && !s.streaming) await loadConversation(s, id);
  if (!id && !s.streaming && s.conversationId) { s.conversationId = null; s.messages = []; }
  view().innerHTML = `<aside class="ask-side"><button class="ghost" data-new-chat>New chat</button><ol></ol></aside><section class="ask-main">${store.status?.chat?.available ? '' : '<p class="warn small">Set OPENROUTER_API_KEY on the server to enable chat.</p>'}${chatHtml(s)}</section>`;
  renderAskSide();
  loadChatList().then(renderAskSide);
  $('.ask-main textarea')?.focus();
}

// ── routing ───────────────────────────────────────────────────────────────
function route() {
  const p = location.pathname;
  const m = p.match(/^\/b\/([\w-]+)/);
  if (m) { if (!$('main').dataset.ready) { ui.view = 'library'; render(); } openReader(m[1]); return; }
  closeReader({ fromPop: true });
  ui.view = p.startsWith('/ask') ? 'ask' : p.startsWith('/inbox') ? 'inbox' : p.startsWith('/taxonomy') ? 'taxonomy' : p.startsWith('/settings') ? 'settings' : 'library';
  render();
}

function render() {
  $('main').dataset.ready = '1';
  $$('[data-nav]').forEach(a => a.setAttribute('aria-current', a.dataset.nav === ui.view ? 'page' : 'false'));
  $('#search-wrap').hidden = ui.view !== 'library';
  if (ui.view === 'library') renderLibrary();
  else if (ui.view === 'inbox') renderInbox();
  else if (ui.view === 'taxonomy') renderTaxonomy();
  else if (ui.view === 'ask') renderAsk();
  else renderSettings();
}

function navigate(path) { if (ui.mobileRail) setRail(false); history.pushState({}, '', path); window.scrollTo(0, 0); route(); }
function updateInboxCount() { const n = inboxBase().length; $('#inbox-count').textContent = n ? fmt.format(n) : ''; }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 2600); }

// ── events ────────────────────────────────────────────────────────────────
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, a, [data-open], [data-pick], [data-concept], [data-close], [data-rail-close]');
  if (!t) return;
  const d = t.dataset;
  if (t.matches('a[data-link]')) { ev.preventDefault(); navigate(t.getAttribute('href')); return; }
  if (d.close !== undefined) { closeReader(); return; }
  if (d.rtab) { showReaderTab(d.rtab); return; }
  if (d.ask) { const box = t.closest('[data-chat]'); await sendChat(sessions.get(box.dataset.chat), d.ask); return; }
  if (d.chatReset !== undefined) { const s = sessions.get(t.closest('[data-chat]').dataset.chat); s.messages = []; s.conversationId = null; if (s.scope === 'corpus') navigate('/ask'); else paintChat(s, { full: true }); return; }
  if (d.newChat !== undefined) { const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } navigate('/ask'); return; }
  if (d.delChat) { ev.preventDefault(); await api(`/api/chats/${d.delChat}`, { method: 'DELETE' }); if (sessions.get('corpus')?.conversationId === d.delChat) { navigate('/ask'); } else { await loadChatList(); renderAskSide(); } return; }
  if (d.step) { stepReader(Number(d.step)); return; }
  if (d.untag) { const r = store.byId.get(t.closest('[data-tags]').dataset.tags); await setTags(r, { remove: [d.untag] }); rerenderTags(r); return; }
  if (t.closest('.suggest') && (d.sid || d.create)) { await pickSuggestion(t); return; }
  if (d.open && !ev.target.closest('a[href]:not([data-open])')) { ev.preventDefault(); openReader(d.open, ui.view === 'library' ? ui.results : store.records.filter(r => r.id === d.open)); return; }
  if (d.filter) { ui.filters.has(d.filter) ? ui.filters.delete(d.filter) : ui.filters.add(d.filter); ui.visible = PAGE; syncUrl(); renderLibrary(); return; }
  if (d.unfilter) { ui.filters.delete(d.unfilter); ui.visible = PAGE; syncUrl(); renderLibrary(); return; }
  if (d.caret) { ui.railOpen.has(d.caret) ? ui.railOpen.delete(d.caret) : ui.railOpen.add(d.caret); $('.rail').innerHTML = renderRail(); return; }
  if (d.status) { ui.status = d.status; ui.visible = PAGE; renderLibrary(); return; }
  if (d.clear !== undefined) { ui.filters.clear(); ui.query = ''; $('#search').value = ''; ui.status = 'active'; ui.visible = PAGE; syncUrl(); renderLibrary(); return; }
  if (d.rail !== undefined) { setRail(!ui.mobileRail); return; }
  if (d.railClose !== undefined) { setRail(false); return; }
  if (d.layout) { savePrefs({ layout: d.layout }); ui.visible = Math.max(PAGE, ui.visible); renderLibrary(); return; }
  if (d.inboxFormat) { savePrefs({ inboxFormat: d.inboxFormat }); ui.inboxId = null; renderInbox(); return; }
  if (d.inboxClear !== undefined) { savePrefs({ inboxFormat: 'all', inboxTopic: '', inboxWindow: 'all' }); ui.inboxId = null; updateInboxCount(); renderInbox(); return; }
  if (d.triage) { await triageCurrent(d.triage); return; }
  if (d.skip !== undefined) { const q = ui.inboxQueue; ui.inboxId = q[q.findIndex(r => r.id === ui.inboxId) + 1]?.id || q[0]?.id; renderInbox(); return; }
  if (d.pick) { ui.inboxId = d.pick; renderInbox(); return; }
  if (d.facet) { ui.taxFacet = d.facet; ui.taxSelected = null; renderTaxonomy(); return; }
  if (d.concept) { ui.taxSelected = d.concept; renderTaxonomy(); return; }
  if (d.newConcept !== undefined) { ui.taxSelected = '__new'; renderTaxonomy(); $('.t-form input[name=label]')?.focus(); return; }
  if (d.cancelConcept !== undefined) { ui.taxSelected = null; renderTaxonomy(); return; }
  if (d.browse) { ui.filters = new Set([d.browse]); ui.query = ''; ui.status = 'active'; navigate(`/?t=${encodeURIComponent(d.browse)}`); return; }
  if (d.viewUntagged !== undefined) { ui.filters.clear(); ui.query = ''; navigate('/'); ui.results = ui.results.filter(r => !tagIds(r).some(id => facetOf(id) === 'topic')); paintResults(ui.results.slice(0, PAGE), true); $('.count').textContent = num.format(ui.results.length); return; }
  if (d.deleteConcept) {
    const c = store.conceptById.get(d.deleteConcept);
    if (!confirm(`${c.origin === 'user' ? 'Delete' : 'Retire'} “${c.label}”? Bookmarks keep their other tags.`)) return;
    await api('/api/taxonomy', { method: 'PUT', body: { id: c.id, patch: null } });
    await reloadTaxonomy(); ui.taxSelected = null; renderTaxonomy(); toast('Concept removed');
    return;
  }
  if (d.pref) { savePrefs({ [d.pref]: d.value }); renderSettings(); if (d.pref === 'inboxWindow') updateInboxCount(); return; }
  if (d.prefToggle) { savePrefs({ [d.prefToggle]: !prefs[d.prefToggle] }); renderSettings(); return; }
  if (d.serverToggle) { const on = t.getAttribute('aria-checked') !== 'true'; await api('/api/settings', { method: 'PUT', body: { [d.serverToggle]: on } }).catch(e => toast(e.message)); await loadStatus(); renderSettings(); return; }
  if (d.refresh !== undefined) { t.disabled = true; t.textContent = 'Rebuilding…'; try { await api('/api/refresh', { method: 'POST' }); await loadAll(); await loadStatus(); updateInboxCount(); toast(`Rebuilt · ${num.format(store.records.length)} bookmarks`); } catch (e) { toast(e.message); } renderSettings(); return; }
  if (d.backlog !== undefined) {
    const cutoff = Date.now() - 30 * 864e5;
    const ids = store.records.filter(r => !triage(r) && new Date(r.postedAt) < cutoff).map(r => r.id);
    if (!ids.length || !confirm(`Mark ${num.format(ids.length)} bookmarks as kept?`)) return;
    await saveOverride(ids, { triaged: 'kept' }); updateInboxCount(); toast(`${num.format(ids.length)} marked as kept`); return;
  }
  if (d.export !== undefined) {
    const out = store.records.map(r => ({ ...r, tags: tagsOf(r), note: store.overrides[r.id]?.note || null, triaged: triage(r) }));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), taxonomy: store.concepts, records: out })], { type: 'application/json' })), download: `corpus-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); URL.revokeObjectURL(a.href); return;
  }
  if (d.copyMcp) {
    const info = await api('/api/mcp');
    const text = { url: info.url, token: info.token, claude: `claude mcp add --transport http corpus ${info.url} --header "Authorization: Bearer ${info.token}"`, hermes: `mcp_servers:\n  corpus:\n    url: "${info.url}"\n    headers:\n      Authorization: "Bearer ${info.token}"\n` }[d.copyMcp];
    await navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast(text));
    return;
  }
  if (d.install !== undefined) { await installApp(); return; }
  if (d.skill) { skillSel = d.skill; renderSettings(); return; }
  if (d.skillNew !== undefined) { skillSel = '__new'; renderSettings(); $('.skill-form input[name=name]')?.focus(); return; }
  if (d.skillCancel !== undefined) { skillSel = null; renderSettings(); return; }
  if (d.skillDelete) { if (!confirm(`Delete the skill “${d.skillDelete}”?`)) return; try { await skillOp('delete_skill', { name: d.skillDelete, confirm: true }); await loadSkills(); skillSel = null; renderSettings(); toast('Skill deleted'); } catch (e) { toast(e.message); } return; }
  if (d.skillRun) { const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } navigate('/ask'); await sendChat(s, `Run the skill "${d.skillRun}".`); return; }
  if (d.logout !== undefined) { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; return; }
  if (d.resetPrefs !== undefined) { prefStorage.removeItem('corpus.prefs'); Object.assign(prefs, defaults); applyPrefs(); renderSettings(); toast('Preferences reset'); }
});

document.addEventListener('submit', async (ev) => {
  const skillForm = ev.target.closest('[data-skill-form]');
  if (skillForm) {
    ev.preventDefault();
    const fd = new FormData(skillForm);
    const isNew = skillForm.dataset.skillForm === '';
    try {
      const res = await skillOp(isNew ? 'create_skill' : 'update_skill', { name: String(fd.get('name')), description: String(fd.get('description')).trim(), instructions: String(fd.get('instructions')).trim() });
      await loadSkills(); skillSel = res.name; renderSettings(); toast(isNew ? 'Skill created' : 'Skill saved');
    } catch (e) { toast(e.message); }
    return;
  }
  const composer = ev.target.closest('[data-composer]');
  if (composer) { ev.preventDefault(); const ta = $('textarea', composer); const text = ta.value; ta.value = ''; await sendChat(sessions.get(composer.dataset.composer), text); return; }
  const form = ev.target.closest('[data-concept-form]');
  if (!form) return;
  ev.preventDefault();
  const fd = new FormData(form);
  const aliases = String(fd.get('aliases') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const parent = fd.get('parent') || null;
  try {
    if (form.dataset.conceptForm === '') {
      const id = await createConcept({ facet: fd.get('facet') || ui.taxFacet, labelText: String(fd.get('label')), parent, aliases });
      await reloadTaxonomy(); ui.taxSelected = id;
    } else {
      await api('/api/taxonomy', { method: 'PUT', body: { id: form.dataset.conceptForm, patch: { label: String(fd.get('label')).trim(), parent, aliases } } });
      await reloadTaxonomy();
    }
    renderTaxonomy(); toast('Saved · bookmarks re-tagged');
  } catch (e) { toast(e.message); }
});

async function reloadTaxonomy() {
  // Keyword edits change machine tags, so reload the rebuilt index too.
  await loadAll();
}

function rerenderTags(r) {
  for (const box of $$(`[data-tags="${r.id}"]`)) box.innerHTML = tagEditor(r);
}

async function pickSuggestion(el) {
  const box = el.closest('[data-tags]');
  const r = store.byId.get(box.dataset.tags);
  const input = $('[data-tag-input]', box);
  let id = el.dataset.sid;
  if (el.dataset.create) id = await createConcept({ facet: el.dataset.create, labelText: input.value });
  await setTags(r, { add: [id] });
  rerenderTags(r);
  $('[data-tag-input]', box)?.focus();
}

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'search') {
    ui.query = t.value; ui.visible = PAGE;
    clearTimeout(t._h); t._h = setTimeout(() => { if (ui.view !== 'library') navigate('/'); else { renderLibrary(); syncUrl(); } }, 140);
    return;
  }
  if (t.id === 'tax-search') { ui.taxQuery = t.value; clearTimeout(t._h); t._h = setTimeout(() => { const pos = t.selectionStart; renderTaxonomy(); const n = $('#tax-search'); n.focus(); n.setSelectionRange(pos, pos); }, 120); return; }
  if (t.matches('[data-tag-input]')) {
    const box = t.closest('[data-tags]'); const r = store.byId.get(box.dataset.tags);
    const list = $('.suggest', box); const items = suggestions(t.value, r);
    list.innerHTML = items.map((s, i) => `<button type="button" class="${i === 0 ? 'hi' : ''}" ${s.id ? `data-sid="${esc(s.id)}"` : `data-create="${s.create}"`}><span>${esc(s.text)}</span>${s.facet ? `<span class="muted mono">${s.facet}</span>` : ''}</button>`).join('');
    list.hidden = !items.length || !t.value.trim();
    return;
  }
  if (t.matches('.composer textarea')) { t.style.height = 'auto'; t.style.height = `${Math.min(220, t.scrollHeight)}px`; }
});

document.addEventListener('change', (ev) => {
  if (ev.target.id === 'settings-sort') { savePrefs({ sort: ev.target.value }); toast('Default order saved'); return; }
  if (ev.target.id === 'settings-model') { savePrefs({ chatModel: ev.target.value }); toast('Default model saved'); return; }
  const inboxPref = { 'inbox-sort': 'inboxSort', 'inbox-window': 'inboxWindow', 'inbox-topic': 'inboxTopic' }[ev.target.id];
  if (inboxPref) { savePrefs({ [inboxPref]: ev.target.value }); ui.inboxId = null; updateInboxCount(); renderInbox(); return; }
  if (ev.target.id === 'sort') { savePrefs({ sort: ev.target.value }); ui.visible = PAGE; renderLibrary(); }
  if (ev.target.matches('[data-note]')) saveOverride([ev.target.dataset.note], { note: ev.target.value.trim() || null });
});

document.addEventListener('focusin', (ev) => {
  if (ev.target.matches('[data-tag-input]')) ev.target.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('focusout', (ev) => {
  if (ev.target.matches('[data-tag-input]')) setTimeout(() => { const s = ev.target.closest('.tag-add')?.querySelector('.suggest'); if (s && !s.contains(document.activeElement)) s.hidden = true; }, 150);
});

// ── keyboard: command palette, shortcuts, spatial navigation ─────────────
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl ';
// Two spaces separate alternatives ("j k  ← →"); one space separates keys within a combo.
const keyHint = (k) => k.trim().split(/\s{2,}/).map(g => g.split(' ').filter(Boolean).map(x => `<kbd>${esc(x)}</kbd>`).join('')).join('<span class="key-or">or</span>');

const SHORTCUTS = [
  ['Anywhere', [[`${MOD}K`, 'Command palette'], ['/', 'Search the library'], ['?', 'Keyboard shortcuts'], ['g l', 'Go to Library'], ['g i', 'Go to Inbox'], ['g a', 'Go to Ask'], ['g t', 'Go to Taxonomy'], ['g s', 'Go to Settings'], ['⇧ D', 'Toggle dark mode'], ['esc', 'Close or step back']]],
  ['Library', [['← ↑ ↓ →', 'Move between cards'], ['h j k l', 'Move between cards'], ['⏎  o', 'Open the focused card'], ['1  2  3', 'Wall, grid, list'], ['x', 'Clear search and filters']]],
  ['Reader', [['j k  ← →', 'Next / previous bookmark'], ['r  c', 'Read / chat tab'], ['t', 'Add a tag'], ['n', 'Write a note'], ['o', 'Open on X'], ['m  e', 'Keep / archive'], ['esc', 'Back to the library']]],
  ['Inbox', [['⏎', 'Keep'], ['e', 'Archive'], ['s  j  ↓', 'Skip to next'], ['k  ↑', 'Previous'], ['o  space', 'Open in reader']]],
  ['Taxonomy', [['↑ ↓', 'Move between concepts'], ['⏎', 'Edit the selected concept'], ['n', 'New concept']]],
  ['Ask', [['⏎', 'Send'], ['⇧ ⏎', 'New line'], ['n', 'New chat'], ['/', 'Focus the composer']]]
];

function showHelp() {
  let el = $('#help');
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', `<div id="help" class="overlay" hidden><div class="overlay-scrim" data-hclose></div><div class="help-box" role="dialog" aria-label="Keyboard shortcuts"><div class="help-head"><h2 class="serif">Keyboard</h2><button class="ghost small" data-hclose>esc</button></div><div class="help-grid">${SHORTCUTS.map(([group, rows]) => `<section><h4>${group}</h4>${rows.map(([k, d]) => `<div class="help-row"><span>${esc(d)}</span><span class="keys">${keyHint(k)}</span></div>`).join('')}</section>`).join('')}</div></div></div>`);
    el = $('#help');
  }
  el.hidden = false;
}
const hideHelp = () => { const el = $('#help'); if (el) el.hidden = true; };

// Palette ------------------------------------------------------------------
const palette = { open: false, items: [], active: 0 };
const recent = () => (prefs.recent || []).map(id => store.byId.get(id)).filter(Boolean);
function rememberOpened(id) { savePrefs({ recent: [id, ...(prefs.recent || []).filter(x => x !== id)].slice(0, 8) }); }

const fuzzy = (text, q) => {
  // every query token must appear; prefix matches rank higher
  const t = text.toLowerCase(); let score = 0;
  for (const tok of q) { const i = t.indexOf(tok); if (i < 0) return -1; score += i === 0 || /\W/.test(t[i - 1]) ? 2 : 1; }
  return score;
};

function commands() {
  const r = ui.readerId && store.byId.get(ui.readerId);
  const go = (label, path, key) => ({ group: 'Go to', label, hint: key, run: () => { closeReader(); navigate(path); } });
  const lib = (fn) => () => { closeReader(); if (ui.view !== 'library') navigate('/'); fn(); renderLibrary(); syncUrl(); };
  const list = [
    ...(r ? [
      { group: 'This bookmark', label: 'Chat about this bookmark', hint: 'c', run: () => showReaderTab('chat') },
      { group: 'This bookmark', label: 'Open on X', hint: 'o', run: () => window.open(r.url, '_blank', 'noopener') },
      { group: 'This bookmark', label: 'Add a tag', hint: 't', run: () => focusTagInput() },
      { group: 'This bookmark', label: 'Keep', hint: 'm', run: () => triageReader('kept') },
      { group: 'This bookmark', label: 'Archive', hint: 'e', run: () => triageReader('archived') },
      { group: 'This bookmark', label: 'Copy link', run: () => { navigator.clipboard?.writeText(location.origin + `/b/${r.id}`); toast('Link copied'); } }
    ] : []),
    go('Library', '/', 'g l'), go('Inbox', '/inbox', 'g i'), go('Ask', '/ask', 'g a'), go('Taxonomy', '/taxonomy', 'g t'), go('Settings', '/settings', 'g s'),
    { group: 'Actions', label: 'New chat', run: () => { const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } closeReader(); navigate('/ask'); } },
    { group: 'Actions', label: 'Wall layout', hint: '1', run: lib(() => savePrefs({ layout: 'wall' })) },
    { group: 'Actions', label: 'Grid layout', hint: '2', run: lib(() => savePrefs({ layout: 'grid' })) },
    { group: 'Actions', label: 'List layout', hint: '3', run: lib(() => savePrefs({ layout: 'list' })) },
    { group: 'Actions', label: 'Clear search and filters', hint: 'x', run: lib(clearAll) },
    { group: 'Actions', label: 'Show untriaged', run: lib(() => { ui.status = 'inbox'; }) },
    { group: 'Actions', label: 'Show archived', run: lib(() => { ui.status = 'archived'; }) },
    ...[['newest', 'bookmarked', 'Sort: recently saved'], ['saves', 'saves', 'Sort: most saved'], ['longest', 'longest', 'Sort: longest reads']].map(([, v, l]) => ({ group: 'Actions', label: l, run: lib(() => savePrefs({ sort: v })) })),
    ...SORTS.map(([v, l]) => ({ group: 'Inbox', label: `Triage by: ${l}`, run: () => { closeReader(); savePrefs({ inboxSort: v }); ui.inboxId = null; navigate('/inbox'); } })),
    ...FORMAT_TABS.map(([v, l]) => ({ group: 'Inbox', label: v === 'all' ? 'Triage: all types' : `Triage only: ${l}`, run: () => { closeReader(); savePrefs({ inboxFormat: v }); ui.inboxId = null; navigate('/inbox'); } })),
    { group: 'Actions', label: `Toggle dark mode`, hint: '⇧ D', run: toggleTheme },
    { group: 'Actions', label: 'Rebuild index from FieldTheory', run: async () => { toast('Rebuilding…'); await api('/api/refresh', { method: 'POST' }).catch(e => toast(e.message)); await loadAll(); render(); toast('Rebuilt'); } },
    { group: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: showHelp },
    ...(isStandalone() ? [] : [{ group: 'Actions', label: 'Install Corpus as an app', run: installApp }]),
    { group: 'Actions', label: 'Sign out', run: async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; } }
  ];
  return list;
}

function paletteItems(qRaw) {
  const q = qRaw.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const out = [];
  const cmds = commands();
  if (!q.length) {
    out.push(...recent().slice(0, 5).map(r => bookmarkItem(r, 'Recent')));
    out.push(...cmds.filter(c => c.group === 'This bookmark' || c.group === 'Go to'));
    out.push(...cmds.filter(c => c.group === 'Actions').slice(0, 5));
    return out;
  }
  const scored = (arr, text) => arr.map(x => [x, fuzzy(text(x), q)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([x]) => x);
  out.push(...scored(cmds, c => `${c.group} ${c.label}`).slice(0, 6));
  // Bookmarks: title/author first, then full text.
  const hits = [];
  for (const r of store.records) {
    const head = `${r.title} ${r.author.name} @${r.author.handle}`;
    const s = fuzzy(head, q);
    if (s >= 0) hits.push([r, 10 + s]);
    else if (hits.length < 400 && matchesQuery(r, qRaw)) hits.push([r, 0]);
  }
  hits.sort((a, b) => b[1] - a[1] || b[0].order - a[0].order);
  out.push(...hits.slice(0, 8).map(([r]) => bookmarkItem(r, 'Bookmarks')));
  const concepts = scored(store.concepts.filter(c => ['topic', 'kind', 'format', 'label'].includes(c.facet)), c => `${c.label} ${c.parent ? label(c.parent) : ''}`).slice(0, 5);
  out.push(...concepts.map(c => ({ group: 'Filter by', label: c.parent ? `${label(c.parent)} / ${c.label}` : c.label, hint: c.facet, run: () => { closeReader(); ui.filters = new Set([c.id]); ui.query = ''; $('#search').value = ''; ui.visible = PAGE; navigate(`/?t=${encodeURIComponent(c.id)}`); } })));
  out.push({ group: 'Ask', label: `Ask Corpus: “${qRaw.trim()}”`, hint: '⏎', run: async () => { closeReader(); const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } navigate('/ask'); await sendChat(s, qRaw); } });
  out.push({ group: 'Ask', label: `Search the library for “${qRaw.trim()}”`, run: () => { closeReader(); ui.query = qRaw.trim(); $('#search').value = ui.query; ui.visible = PAGE; navigate(`/?q=${encodeURIComponent(ui.query)}`); } });
  return out;
}

function bookmarkItem(r, group) {
  return { group, label: (r.title || snippet(r, 80)).slice(0, 90) || `@${r.author.handle}`, meta: `@${r.author.handle} · ${label(formatOf(r))}`, avatar: r.author, run: () => openReader(r.id, ui.results?.length ? ui.results : store.records) };
}

function openPalette() {
  let el = $('#palette');
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', `<div id="palette" class="overlay palette" hidden><div class="overlay-scrim" data-pclose></div><div class="palette-box" role="dialog" aria-label="Command palette"><div class="palette-input"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg><input id="palette-input" placeholder="Search bookmarks, jump to a page, run an action…" autocomplete="off" spellcheck="false" role="combobox" aria-controls="palette-list"><kbd>esc</kbd></div><div id="palette-list" class="palette-list" role="listbox"></div><div class="palette-foot"><span>${keyHint('↑ ↓')} navigate</span><span>${keyHint('⏎')} open</span><span>${keyHint('?')} all shortcuts</span></div></div></div>`);
    el = $('#palette');
  }
  palette.open = true;
  el.hidden = false;
  const input = $('#palette-input');
  input.value = '';
  paintPalette('');
  input.focus();
}
function closePalette() { palette.open = false; const el = $('#palette'); if (el) el.hidden = true; }

function paintPalette(q) {
  palette.items = paletteItems(q);
  palette.active = 0;
  let group = null;
  $('#palette-list').innerHTML = palette.items.map((it, i) => {
    const head = it.group !== group ? `<div class="p-group">${esc(it.group)}</div>` : '';
    group = it.group;
    return `${head}<button class="p-item ${i === 0 ? 'on' : ''}" data-pi="${i}" role="option">${it.avatar ? avatar(it.avatar) : ''}<span class="p-label">${esc(it.label)}</span>${it.meta ? `<span class="p-meta">${esc(it.meta)}</span>` : ''}${it.hint ? `<span class="p-hint">${keyHint(it.hint)}</span>` : ''}</button>`;
  }).join('') || '<p class="p-empty">No matches</p>';
}
function movePalette(d) {
  const n = palette.items.length;
  if (!n) return;
  palette.active = (palette.active + d + n) % n;
  $$('.p-item').forEach((b, i) => b.classList.toggle('on', i === palette.active));
  $(`.p-item[data-pi="${palette.active}"]`)?.scrollIntoView({ block: 'nearest' });
}
async function runPalette(i = palette.active) { const it = palette.items[i]; if (!it) return; closePalette(); await it.run(); }

// Helpers used by shortcuts -------------------------------------------------
function clearAll() { ui.filters.clear(); ui.query = ''; $('#search').value = ''; ui.status = 'active'; ui.visible = PAGE; }
function toggleTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  savePrefs({ theme: dark ? 'light' : 'dark' });
  if (ui.view === 'settings') renderSettings();
}
function focusTagInput() { showReaderTab('read'); const i = $('#reader [data-tag-input]'); i?.scrollIntoView({ block: 'center' }); i?.focus(); }
async function triageReader(value) {
  const id = ui.readerId; if (!id) return;
  await saveOverride([id], { triaged: value }); updateInboxCount();
  toast(value === 'kept' ? 'Kept' : 'Archived');
  stepReader(1);
}

function focusCard(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect(), top = 120, bottom = window.innerHeight - 24;
  if (r.top < top || r.bottom > bottom) el.scrollIntoView({ block: r.height > bottom - top ? 'start' : 'center', behavior: 'smooth' });
}

// Spatial navigation works for every layout: wall columns, grid, and list.
function moveCard(dir) {
  const cards = $$('#results [data-open]');
  if (!cards.length) return;
  const cur = document.activeElement?.closest?.('#results [data-open]');
  if (!cur) return focusCard(cards.find(c => c.getBoundingClientRect().bottom > 130) || cards[0]);
  const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const c of cards) {
    if (c === cur) continue;
    const b = c.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let primary, secondary;
    if (dir === 'down') { if (b.top < a.bottom - 4) continue; primary = b.top - a.bottom; secondary = Math.abs(bx - ax); }
    else if (dir === 'up') { if (b.bottom > a.top + 4) continue; primary = a.top - b.bottom; secondary = Math.abs(bx - ax); }
    else if (dir === 'right') { if (b.left < a.right - 4) continue; primary = b.left - a.right; secondary = Math.abs(by - ay); }
    else { if (b.right > a.left + 4) continue; primary = a.left - b.right; secondary = Math.abs(by - ay); }
    const score = primary + secondary * 3;
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (best) return focusCard(best);
  if (dir === 'down' && ui.visible < (ui.results?.length || 0)) {
    // Past the last painted card: load the next page, then continue.
    const next = ui.results.slice(ui.visible, ui.visible + PAGE); ui.visible += PAGE; paintResults(next, false);
    requestAnimationFrame(() => moveCard(dir));
  }
}

function focusCardById(id) {
  if (ui.view !== 'library' || !id) return;
  const idx = ui.results?.findIndex(r => r.id === id) ?? -1;
  if (idx >= ui.visible) { const next = ui.results.slice(ui.visible, idx + PAGE); ui.visible = idx + PAGE; paintResults(next, false); }
  requestAnimationFrame(() => focusCard($(`#results [data-open="${CSS.escape(id)}"]`)));
}

function moveTaxonomy(d) {
  const rows = $$('.t-row[data-concept]');
  if (!rows.length) return;
  const i = rows.findIndex(r => r.dataset.concept === ui.taxSelected);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))];
  ui.taxSelected = next.dataset.concept;
  renderTaxonomy();
  const el = $(`.t-row[data-concept="${CSS.escape(ui.taxSelected)}"]`);
  el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest' });
}

function inboxStep(d) {
  const q = ui.inboxQueue || [];
  const i = q.findIndex(r => r.id === ui.inboxId);
  const next = q[i + d];
  if (!next) return;
  ui.inboxId = next.id; renderInbox();
  $('.triage-scroll')?.scrollTo(0, 0);
  $(`#queue-list [data-pick="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

// Dispatcher ---------------------------------------------------------------
let chord = 0;
const ARROWS = { ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right', j: 'down', k: 'up', h: 'left', l: 'right' };

document.addEventListener('keydown', async (ev) => {
  const t = ev.target;
  const mod = ev.metaKey || ev.ctrlKey;
  // ⌘K / Ctrl+K toggles the palette from anywhere, even while typing.
  if (mod && !ev.altKey && ev.key.toLowerCase() === 'k') { ev.preventDefault(); palette.open ? closePalette() : openPalette(); return; }
  if (palette.open) {
    if (ev.key === 'ArrowDown' || (ev.ctrlKey && ev.key === 'n')) { ev.preventDefault(); movePalette(1); }
    else if (ev.key === 'ArrowUp' || (ev.ctrlKey && ev.key === 'p')) { ev.preventDefault(); movePalette(-1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); await runPalette(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closePalette(); }
    return;
  }
  if (!$('#help')?.hidden && $('#help')) { if (ev.key === 'Escape' || ev.key === '?') { ev.preventDefault(); hideHelp(); } return; }

  if (t.matches('.composer textarea') && ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); t.form.requestSubmit(); return; }
  if (t.matches('[data-tag-input]')) {
    const list = $('.suggest', t.closest('.tag-add'));
    const btns = $$('button', list); const i = btns.findIndex(b => b.classList.contains('hi'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); btns[i]?.classList.remove('hi'); btns[(i + (ev.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.classList.add('hi'); }
    if (ev.key === 'Enter' && btns[i] && !list.hidden) { ev.preventDefault(); await pickSuggestion(btns[i]); }
    if (ev.key === 'Escape') { list.hidden = true; t.blur(); ev.stopPropagation(); }
    return;
  }
  const readerOpen = !$('#reader').hidden;
  const typing = t.matches('input, textarea, select, [contenteditable]');
  if (typing) {
    if (ev.key === 'Escape') { t.blur(); if (t.id === 'search' && ui.view === 'library') moveCard('down'); }
    if (t.id === 'search' && ev.key === 'ArrowDown') { ev.preventDefault(); t.blur(); moveCard('down'); }
    if (t.id === 'search' && ev.key === 'Enter') { ev.preventDefault(); t.blur(); moveCard('down'); }
    return;
  }
  if (ev.key === 'Escape' && readerOpen) { closeReader(); return; }
  if (ev.key === 'Escape' && ui.mobileRail) { setRail(false); return; }
  if (mod || ev.altKey) return;

  const key = ev.key;
  // "g" chords: g l / g i / g a / g t / g s
  if (chord && Date.now() - chord < 1200) {
    chord = 0;
    const path = { l: '/', i: '/inbox', a: '/ask', t: '/taxonomy', s: '/settings' }[key];
    if (path) { ev.preventDefault(); closeReader(); navigate(path); }
    return;
  }
  if (key === 'g') { chord = Date.now(); return; }
  if (key === '?') { ev.preventDefault(); showHelp(); return; }
  if (key === 'D' && ev.shiftKey) { toggleTheme(); return; }

  if (readerOpen) {
    const r = store.byId.get(ui.readerId);
    if (key === 'j' || key === 'ArrowRight') { ev.preventDefault(); stepReader(1); }
    else if (key === 'k' || key === 'ArrowLeft') { ev.preventDefault(); stepReader(-1); }
    else if (key === 'c') { ev.preventDefault(); showReaderTab('chat'); }
    else if (key === 'r') showReaderTab('read');
    else if (key === 't') { ev.preventDefault(); focusTagInput(); }
    else if (key === 'n') { ev.preventDefault(); showReaderTab('read'); const n = $('#reader [data-note]'); n?.scrollIntoView({ block: 'center' }); n?.focus(); }
    else if (key === 'o' && r) window.open(r.url, '_blank', 'noopener');
    else if (key === 'm') await triageReader('kept');
    else if (key === 'e') await triageReader('archived');
    return;
  }

  if (ui.view === 'library') {
    if (key === '/') { ev.preventDefault(); $('#search').focus(); $('#search').select(); return; }
    if (ARROWS[key]) { ev.preventDefault(); moveCard(ARROWS[key]); return; }
    if ((key === 'Enter' || key === 'o') && t.dataset?.open) { ev.preventDefault(); openReader(t.dataset.open, ui.results); return; }
    if (['1', '2', '3'].includes(key)) { const layout = ['wall', 'grid', 'list'][Number(key) - 1]; const focused = document.activeElement?.dataset?.open; savePrefs({ layout }); renderLibrary(); focusCardById(focused); return; }
    if (key === 'x') { clearAll(); syncUrl(); renderLibrary(); return; }
  }
  if (ui.view === 'inbox') {
    if (key === 'Enter') { ev.preventDefault(); await triageCurrent('kept'); }
    else if (key === 'e') await triageCurrent('archived');
    else if (key === 's' || key === 'j' || key === 'ArrowDown') { ev.preventDefault(); inboxStep(1); }
    else if (key === 'k' || key === 'ArrowUp') { ev.preventDefault(); inboxStep(-1); }
    else if (key === 'o' || key === ' ') { ev.preventDefault(); openReader(ui.inboxId, ui.inboxQueue); }
    return;
  }
  if (ui.view === 'taxonomy') {
    if (key === 'ArrowDown' || key === 'j') { ev.preventDefault(); moveTaxonomy(1); }
    else if (key === 'ArrowUp' || key === 'k') { ev.preventDefault(); moveTaxonomy(-1); }
    else if (key === 'Enter' && ui.taxSelected) { ev.preventDefault(); $('.t-form input[name=label]')?.focus(); }
    else if (key === 'n') { ev.preventDefault(); ui.taxSelected = '__new'; renderTaxonomy(); $('.t-form input[name=label]')?.focus(); }
    else if (key === '/') { ev.preventDefault(); $('#tax-search')?.focus(); }
    return;
  }
  if (ui.view === 'ask') {
    if (key === '/') { ev.preventDefault(); $('.ask-main textarea')?.focus(); }
    else if (key === 'n') { ev.preventDefault(); $('[data-new-chat]')?.click(); }
  }
});

document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-pclose]')) closePalette();
  if (ev.target.closest('[data-hclose]')) hideHelp();
  const pi = ev.target.closest('[data-pi]'); if (pi) runPalette(Number(pi.dataset.pi));
  if (ev.target.closest('[data-palette]')) openPalette();
});
document.addEventListener('input', (ev) => { if (ev.target.id === 'palette-input') paintPalette(ev.target.value); });
document.addEventListener('mousemove', (ev) => { const pi = ev.target.closest?.('[data-pi]'); if (pi && Number(pi.dataset.pi) !== palette.active) { palette.active = Number(pi.dataset.pi); $$('.p-item').forEach((b, i) => b.classList.toggle('on', i === palette.active)); } });

window.addEventListener('popstate', route);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (ui.view === 'library' && prefs.layout === 'wall') { const box = $('#results'); const cols = Math.max(1, Math.min(5, Math.floor(((box?.clientWidth || 0) + 20) / 300))); if (box?._cols?.length !== cols) paintResults([], true); } }, 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

function syncUrl() {
  if (ui.view !== 'library') return;
  const p = new URLSearchParams();
  if (ui.query) p.set('q', ui.query);
  for (const f of ui.filters) p.append('t', f);
  const next = `/${p.toString() ? `?${p}` : ''}`;
  if (next !== location.pathname + location.search) history.replaceState({}, '', next);
}

async function loadStatus() { store.status = await api('/api/status').catch(() => null); }

// Pick up rebuilds from the background worker without a manual refresh.
async function poll() {
  const s = await api('/api/status').catch(() => null);
  if (!s) return;
  store.status = s;
  if (s.build?.at && store.generatedAt && s.build.at > store.generatedAt && $('#reader').hidden && ui.view !== 'taxonomy') {
    const y = window.scrollY;
    await loadAll(); updateInboxCount();
    if (ui.view === 'library' && window.scrollY < 400) { renderLibrary(); window.scrollTo(0, y); }
    else if (ui.view === 'settings') renderSettings();
  }
}

// ── PWA: service worker + install ─────────────────────────────────────────
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (ui.view === 'settings') renderSettings(); });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Installed'); });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(reg => reg.active?.postMessage('cache-shell')).catch(() => {});
}
async function installApp() {
  if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; if (ui.view === 'settings') renderSettings(); return; }
  toast(isIOS ? 'In Safari: Share → Add to Home Screen' : 'Use your browser menu → Install app / Add to Home screen');
}
function installRow(row) {
  if (isStandalone()) return row('App', 'Running as an installed app.', '<span class="mono small">installed</span>');
  const how = installPrompt ? 'Install Corpus as an app on this device.' : isIOS ? 'In Safari, tap Share, then <strong>Add to Home Screen</strong>.' : 'Use your browser’s menu → <strong>Install app</strong> (or Add to Home screen).';
  return row('Install app', how, installPrompt ? '<button class="primary" data-install>Install</button>' : '');
}

(async function init() {
  applyPrefs();
  $('.mod-k').textContent = isMac ? '⌘K' : 'Ctrl K';
  const params = new URLSearchParams(location.search);
  ui.query = params.get('q') || '';
  ui.filters = new Set(params.getAll('t'));
  $('#search').value = ui.query;
  view().innerHTML = '<div class="loading"><span class="mono muted">Loading</span></div>';
  try { await Promise.all([loadAll(), loadStatus()]); }
  catch (e) { view().innerHTML = `<div class="empty"><p class="serif">Couldn’t load the index.</p><p class="muted">${esc(e.message)}</p></div>`; return; }
  updateInboxCount();
  route();
  setInterval(poll, 60_000);
})();
