// What the tools share: the library as the user sees it (machine tags plus their edits),
// resolving tag names, the common filter behind search and bulk changes, applying changes,
// background jobs, and adding files.
import { readState, writeState } from '../../library/state.mjs';
import { slugify } from '../../library/skills.mjs';
import { recordText, classifyFile, classifyMany } from '../../classify/jev.mjs';
import { addManual } from '../../library/manual.mjs';
import { ingestFile, updateDoc, maxSortIndex, FILE_TYPES } from '../../files/store.mjs';
import crypto from 'node:crypto';

const day = (iso) => (iso || '').slice(0, 10);
const GENERIC_NAME = /^(img|image|photo|pic|picture|screenshot|screen shot|scan|pxl|dsc|dcim|mvimg|signal|whatsapp image|pasted( image)?|untitled|file|download)?[\s_.-]*[\d\s_.:at-]*$/i;

export function createToolkit({ getIndex, rebuild, enricher, log = () => {} }) {
  const jobs = new Map();
  const tagging = new Set(); // files whose upload is still being tagged (with suggestions)

  // ── effective view: machine tags + the user's overrides ──
  const facetOf = (id) => String(id).split(':')[0];
  function effectiveTags(r, o = {}) {
    const removed = new Set(o.remove || []);
    const m = new Map();
    for (const t of r.tags) if (!removed.has(t.id)) m.set(t.id, t);
    for (const id of o.add || []) m.set(id, { id, by: 'you', score: 1, sources: ['you'] });
    if ((o.add || []).some(id => facetOf(id) === 'format')) for (const [id, t] of m) if (facetOf(id) === 'format' && t.by !== 'you') m.delete(id);
    return [...m.values()].sort((a, b) => (b.by === 'you') - (a.by === 'you') || b.score - a.score);
  }
  const statusOf = (o = {}) => o.purged ? 'purged' : o.deleted ? 'deleted' : o.triaged || 'inbox';

  async function ctx() {
    const [ix, state] = await Promise.all([getIndex(), readState()]);
    const label = (id) => ix.conceptById.get(id)?.label || id;
    const path = (id) => { const c = ix.conceptById.get(id); if (!c) return id; const p = c.parent && ix.conceptById.get(c.parent); return p ? `${p.label} / ${c.label}` : c.label; };
    const descendants = (id) => ix.concepts.filter(c => c.id === id || c.id.startsWith(`${id}/`)).map(c => c.id);
    return { ix, state, label, path, descendants };
  }

  // Accepts ids ("topic:ai/evals"), labels ("Evals") or paths ("AI / Evals").
  function resolveConcept(c, name, { createAs } = {}) {
    if (!name) return null;
    const s = String(name).trim();
    if (c.ix.conceptById.has(s)) return s;
    const lower = s.toLowerCase();
    const hit = c.ix.concepts.find(x => x.label.toLowerCase() === lower || c.path(x.id).toLowerCase() === lower || x.id.split(':')[1]?.toLowerCase() === lower || x.id.endsWith(`/${lower}`));
    if (hit) return hit.id;
    return createAs ? { create: `${createAs}:${slugify(s)}`, label: s, facet: createAs } : null;
  }

  function compact(c, r, n = 300) {
    const o = c.state.overrides[r.id] || {};
    const tags = effectiveTags(r, o).filter(t => /^(topic|kind|label):/.test(t.id)).slice(0, 5).map(t => c.path(t.id));
    return {
      id: r.id, url: r.url, source: r.provider, author: r.provider === 'file' ? r.author.name || undefined : `@${r.author.handle}`, posted: day(r.postedAt), saved: day(r.capturedAt),
      format: (effectiveTags(r, o).find(t => facetOf(t.id) === 'format')?.id || r.format).replace('format:', ''),
      parts: r.thread?.length || 1, ...(r.doc && { file: { kind: r.doc.kind, pages: r.doc.pages || undefined, chapters: r.doc.chapters || undefined, authors: r.doc.authors?.length ? r.doc.authors : undefined } }), tags, status: statusOf(o), scratchpad: o.scratchpad || undefined, highlights: o.highlights?.length || undefined,
      title: (r.title || '').slice(0, 140), snippet: recordText(r, n).replace(/\s+/g, ' ')
    };
  }

  // Shared filter: query (BM25), topic/kind/label/format, status, author, dates, sort.
  function select(c, f = {}) {
    const { ix, state } = c;
    let list = f.query ? ix.search(String(f.query), { limit: 5000 }).map(h => h.r) : [...ix.records];
    const want = (name, facet) => { const id = resolveConcept(c, name); if (!id) throw new Error(`Unknown ${facet} "${name}". Use list_concepts to see options.`); return new Set(c.descendants(id)); };
    const groups = [['topic', f.topic], ['kind', f.kind], ['label', f.label]].filter(([, v]) => v).map(([facet, v]) => want(v, facet));
    const formatId = f.format ? `format:${String(f.format).replace('format:', '')}` : null;
    const status = f.status || 'active';
    const ids = f.ids ? new Set(f.ids.map(String)) : null;
    list = list.filter(r => {
      if (ids && !ids.has(r.id)) return false;
      const o = state.overrides[r.id] || {};
      const st = statusOf(o);
      if (st === 'purged') return false;
      if (status === 'active' ? st === 'archived' || st === 'deleted' : status !== 'all' && st !== status) return false;
      if (f.author && r.author.handle.toLowerCase() !== String(f.author).replace('@', '').toLowerCase()) return false;
      if (f.source && r.provider !== f.source) return false;
      if (f.since && (r.postedAt || '') < f.since) return false;
      if (f.until && (r.postedAt || '') > `${f.until}T23:59:59`) return false;
      if (f.saved_since && (r.capturedAt || '') < f.saved_since) return false;
      if (formatId || groups.length) {
        const tags = effectiveTags(r, o).map(t => t.id);
        if (formatId && !tags.includes(formatId)) return false;
        if (!groups.every(g => tags.some(t => g.has(t)))) return false;
      }
      if (f.unclassified && r.classifiedBy) return false;
      return true;
    });
    const eng = (r, k) => r.engagement?.[k] || 0;
    const len = (r) => recordText(r, 1e7).length;
    const sorts = {
      saved: (a, b) => b.order - a.order, saved_oldest: (a, b) => a.order - b.order,
      posted: (a, b) => String(b.postedAt).localeCompare(String(a.postedAt)), posted_oldest: (a, b) => String(a.postedAt).localeCompare(String(b.postedAt)),
      most_saved: (a, b) => eng(b, 'bookmarkCount') - eng(a, 'bookmarkCount'), most_liked: (a, b) => eng(b, 'likeCount') - eng(a, 'likeCount'),
      longest: (a, b) => len(b) - len(a), shortest: (a, b) => len(a) - len(b)
    };
    if (f.sort && sorts[f.sort]) list.sort(sorts[f.sort]);
    else if (!f.query) list.sort(sorts.saved);
    return list;
  }

  const filterProps = {
    query: { type: 'string', description: 'Keywords (full-text over posts, threads, articles, link cards)' },
    topic: { type: 'string', description: 'Topic name, path or id, e.g. "Evals", "AI / Agents", "topic:health/sleep"' },
    kind: { type: 'string', description: 'Kind, e.g. "How-to / technique", "Tool / product"' },
    label: { type: 'string', description: 'A personal label' },
    format: { type: 'string', enum: ['thread', 'article', 'link', 'repo', 'video', 'image', 'quote', 'post', 'book', 'document', 'note'] },
    status: { type: 'string', enum: ['active', 'inbox', 'kept', 'archived', 'deleted', 'all'], description: 'active (default) = everything not archived/deleted; inbox = untriaged; deleted = Trash' },
    author: { type: 'string', description: 'X handle without @' },
    source: { type: 'string', enum: ['twitter', 'web', 'file'], description: 'file = images, PDFs, books and text the user added' },
    since: { type: 'string', description: 'Posted on/after YYYY-MM-DD' },
    until: { type: 'string', description: 'Posted on/before YYYY-MM-DD' },
    saved_since: { type: 'string', description: 'Saved on/after YYYY-MM-DD' },
    sort: { type: 'string', enum: ['saved', 'saved_oldest', 'posted', 'posted_oldest', 'most_saved', 'most_liked', 'longest', 'shortest'] }
  };
  const selector = { type: 'object', description: 'Which bookmarks: either explicit ids or a filter', properties: { ids: { type: 'array', items: { type: 'string' } }, ...filterProps } };

  async function applyPatch(c, ids, patch) {
    const add = [], remove = [], created = [];
    for (const name of patch.add_tags || []) {
      const res = resolveConcept(c, name, { createAs: 'label' });
      if (res?.create) { await createConceptRaw({ id: res.create, label: res.label, facet: 'label' }); created.push(res.label); add.push(res.create); }
      else if (res) add.push(res);
    }
    for (const name of patch.remove_tags || []) { const id = resolveConcept(c, name); if (id) remove.push(id); }
    await writeState(st => {
      for (const id of ids) {
        const r = c.ix.byId.get(id);
        const o = { ...(st.overrides[id] || {}) };
        if (add.length || remove.length) {
          const machine = new Set((r?.tags || []).map(t => t.id));
          const A = new Set(o.add || []), R = new Set(o.remove || []);
          for (const t of add) { R.delete(t); if (!machine.has(t)) A.add(t); }
          for (const t of remove) { A.delete(t); if (machine.has(t)) R.add(t); }
          if (add.some(t => facetOf(t) === 'format')) for (const t of A) if (facetOf(t) === 'format' && !add.includes(t)) A.delete(t);
          o.add = [...A]; o.remove = [...R];
        }
        if ('triage' in patch) { if (!patch.triage || patch.triage === 'untriaged') delete o.triaged; else o.triaged = patch.triage; }
        if ('scratchpad' in patch) { if (patch.scratchpad) o.scratchpad = String(patch.scratchpad); else delete o.scratchpad; }
        if ('deleted' in patch) { if (patch.deleted) { o.deleted = true; o.deletedAt ||= new Date().toISOString(); } else { delete o.deleted; delete o.deletedAt; } }
        o.updatedAt = new Date().toISOString();
        st.overrides[id] = o;
      }
    });
    return { add, remove, created };
  }

  async function createConceptRaw({ id, label, facet, parent = null, aliases = [] }) {
    await writeState(st => { st.taxonomy.concepts[id] = { ...(st.taxonomy.concepts[id] || {}), label, facet, parent, aliases }; });
    await rebuild('ops:taxonomy');
  }

  // Where a highlight sits in a book or PDF, for agents and lists.
  const whereOf = (r, h) => !r.doc || !h.loc ? undefined : h.loc.page != null ? `page ${h.loc.page + 1} (section ${h.loc.page})` : h.loc.ch != null ? `section ${h.loc.ch}` : undefined;

  // A new file: parse and store it, add it to the index, then tag it with Jev in the background.
  // A web page by link: read as an article, saved, added to the index, and tagged by Jev in the background.
  async function saveLink({ url, title, text }) {
    const item = await addManual({ url, title, text }, { maxSortIndex: await maxSortIndex() });
    const about = { id: item.id, title: item.title, site: item.site, words: item.article?.words ?? item.text.split(/\s+/).length, isArticle: !!item.article?.isArticle };
    if (item.duplicate) return { ...about, duplicate: true };
    await rebuild('link');
    let job = null;
    if (process.env.TYPESAFE_API_KEY) {
      tagging.add(item.id);
      job = { id: crypto.randomUUID().slice(0, 8), kind: 'link-tagging', bookmark: item.id, status: 'running', startedAt: new Date().toISOString() };
      jobs.set(job.id, job);
      (async () => {
        try {
          const c = await ctx();
          const res = await classifyMany([c.ix.byId.get(item.id)], c.ix.concepts, { concurrency: 1, log });
          if (!res.ok) throw new Error('Jev couldn’t classify it');
          const done = await rebuild('link:jev');
          Object.assign(job, { status: 'done', tags: (done.records.find(r => r.id === item.id)?.tags || []).filter(t => /^(topic|kind):/.test(t.id)).map(t => t.id) });
        } catch (e) { Object.assign(job, { status: 'failed', error: e.message }); log(`[links] tagging ${item.id}: ${e.message}`); }
        tagging.delete(item.id);
        job.finishedAt = new Date().toISOString();
      })();
    }
    return { ...about, job: job?.id || null };
  }

  async function ingest(data, name) {
    const doc = await ingestFile({ data, name });
    if (doc.duplicate) return { id: doc.id, title: doc.title, kind: doc.kind, duplicate: true };
    await rebuild('file');
    let job = null;
    if (process.env.TYPESAFE_API_KEY) {
      tagging.add(doc.id);
      job = { id: crypto.randomUUID().slice(0, 8), kind: 'file-tagging', bookmark: doc.id, status: 'running', startedAt: new Date().toISOString() };
      jobs.set(job.id, job);
      (async () => {
        try {
          const c = await ctx();
          const r = c.ix.byId.get(doc.id);
          const res = await classifyFile(r, c.ix.concepts, { log });
          // Images named IMG_2231, Screenshot 2026-…, photo: titled by what they show instead.
          if (doc.kind === 'image' && res.described[0] && GENERIC_NAME.test(doc.title)) await updateDoc(doc.id, { title: res.described[0].split(/(?<=[.!?])\s/)[0].replace(/^(this|the) (image|photo|picture|screenshot) (shows|is|depicts)( of)? /i, '').replace(/^./, ch => ch.toUpperCase()).slice(0, 90) });
          await rebuild('file:jev');
          Object.assign(job, { status: 'done', tags: res.tags.map(t => t.id), suggested: res.suggest?.map(x => x.label) || [] });
        } catch (e) { Object.assign(job, { status: 'failed', error: e.message }); log(`[files] tagging ${doc.id}: ${e.message}`); }
        tagging.delete(doc.id);
        job.finishedAt = new Date().toISOString();
      })();
    }
    return { id: doc.id, title: doc.title, kind: doc.kind, job: job?.id || null };
  }
  // A URL that is a document or image rather than a page: its bytes and a file name.
  async function fetchFile(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    const ext = (new URL(url).pathname.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    const known = FILE_TYPES[ext] && !FILE_TYPES[ext].startsWith('text/');
    // Unknown extensions: ask first, so ordinary pages aren't downloaded twice.
    if (!known) {
      const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (!/^(application\/(pdf|epub\+zip|x-mobipocket-ebook)|image\/)/.test(head?.headers.get('content-type') || '')) return null;
    }
    let res;
    try { res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; Corpus/1.0; personal reader)' } }); } catch { return null; }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const isFile = /^(application\/(pdf|epub\+zip|x-mobipocket-ebook|octet-stream)|image\/)/.test(type);
    if (!res.ok || !isFile) { res.body?.cancel().catch(() => {}); return null; }
    const data = Buffer.from(await res.arrayBuffer());
    const last = new URL(res.url).pathname.split('/').pop() || 'file';
    let name; try { name = decodeURIComponent(last); } catch { name = last; }
    name = name + (ext ? '' : { 'application/pdf': '.pdf', 'application/epub+zip': '.epub' }[type] || '');
    return { data, name };
  }

  const needConfirm = (count, what, sample) => ({ needs_confirmation: true, count, message: `This would ${what} ${count} bookmarks. Ask the user, then call again with confirm: true.`, sample });

  // ── tool definitions ──

  return { getIndex, rebuild, enricher, log, jobs, tagging, facetOf, effectiveTags, statusOf, ctx, resolveConcept, compact, select, filterProps, selector, applyPatch, createConceptRaw, whereOf, ingest, saveLink, fetchFile, needConfirm };
}
