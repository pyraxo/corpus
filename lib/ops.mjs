// Every capability Corpus has, as tools with JSON schemas. The web chat, the MCP
// endpoint (/mcp) and the stdio bridge all call these, so an agent can do
// anything the site can: search/read, tag/triage/note, add or delete bookmarks,
// edit the taxonomy, manage skills, run Jev classification and thread capture.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { paths } from './paths.mjs';
import { recordText, classifyMany } from './jev.mjs';
import { fetchPage } from './pages.mjs';
import { readState, writeState } from './state.mjs';
import { defaultConcepts } from './taxonomy.mjs';
import { addManual, readManual } from './manual.mjs';
import { listSkills, getSkill, saveSkill, deleteSkill, slugify } from './skills.mjs';
import { requestPriority } from './priority.mjs';
import { lockHolder } from './lock.mjs';

const defaultIds = new Set(defaultConcepts().map(c => c.id));
const day = (iso) => (iso || '').slice(0, 10);
const CONFIRM_OVER = 25;

export function createOps({ getIndex, rebuild, enricher, log = () => {} }) {
  const jobs = new Map();

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
      id: r.id, url: r.url, source: r.provider, author: `@${r.author.handle}`, posted: day(r.postedAt), saved: day(r.capturedAt),
      format: (effectiveTags(r, o).find(t => facetOf(t.id) === 'format')?.id || r.format).replace('format:', ''),
      parts: r.thread?.length || 1, tags, status: statusOf(o), note: o.note || undefined,
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
    format: { type: 'string', enum: ['thread', 'article', 'link', 'repo', 'video', 'image', 'quote', 'post'] },
    status: { type: 'string', enum: ['active', 'inbox', 'kept', 'archived', 'deleted', 'all'], description: 'active (default) = everything not archived/deleted; inbox = untriaged; deleted = Trash' },
    author: { type: 'string', description: 'X handle without @' },
    source: { type: 'string', enum: ['twitter', 'web'] },
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
        if ('note' in patch) { if (patch.note) o.note = patch.note; else delete o.note; }
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

  const needConfirm = (count, what, sample) => ({ needs_confirmation: true, count, message: `This would ${what} ${count} bookmarks. Ask the user, then call again with confirm: true.`, sample });

  // ── tool definitions ──
  const tools = [
    {
      name: 'get_overview', description: 'Library stats: totals, triage counts, capture/classification progress, top topics, skills. Good first call.',
      input: { type: 'object', properties: {} },
      run: async () => {
        const c = await ctx();
        const counts = { total: 0, inbox: 0, kept: 0, archived: 0, deleted: 0, threads: 0, articles: 0, web: 0, captured: 0, classified: 0 };
        const topics = new Map();
        for (const r of c.ix.records) {
          const o = c.state.overrides[r.id] || {}; const st = statusOf(o);
          if (st === 'purged') continue;
          counts.total++; counts[st]++;
          if (r.thread) counts.threads++; if (r.format === 'format:article') counts.articles++; if (r.provider === 'web') counts.web++;
          if (r.enrichment !== 'pending') counts.captured++; if (r.classifiedBy) counts.classified++;
          for (const t of effectiveTags(r, o)) if (t.id.startsWith('topic:') && t.score >= 0.5) topics.set(t.id, (topics.get(t.id) || 0) + 1);
        }
        const dates = c.ix.records.map(r => r.postedAt).filter(Boolean).sort();
        return { ...counts, posted_range: [day(dates[0]), day(dates.at(-1))], top_topics: [...topics].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, n]) => ({ topic: c.path(id), id, count: n })), skills: (await listSkills()).map(s => s.name), backfill_running: !!lockHolder(), running_jobs: [...jobs.values()].filter(j => j.status === 'running').map(j => j.id) };
      }
    },
    {
      name: 'search_bookmarks', description: 'Find bookmarks by keywords and/or filters. Returns compact results with ids, tags, status and a snippet. Call several times with different phrasings when useful.',
      input: { type: 'object', properties: { ...filterProps, limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 }, offset: { type: 'integer', minimum: 0, default: 0 } } },
      run: async (a) => { const c = await ctx(); const list = select(c, a); const off = a.offset || 0, lim = Math.min(50, a.limit || 12); return { total: list.length, offset: off, results: list.slice(off, off + lim).map(r => compact(c, r)) }; }
    },
    {
      name: 'read_bookmark', description: 'Full content of one bookmark: every thread part, article text, link card, quoted post, tags with confidence and sources, triage state and note. Set include_page to also fetch the linked web page.',
      input: { type: 'object', properties: { id: { type: 'string' }, include_page: { type: 'boolean', default: false } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); const r = c.ix.byId.get(String(a.id));
        if (!r) throw new Error(`No bookmark ${a.id}`);
        const o = c.state.overrides[r.id] || {};
        const out = { ...compact(c, r, 0), snippet: undefined, tags: effectiveTags(r, o).filter(t => !t.id.startsWith('source:')).map(t => ({ id: t.id, name: c.path(t.id), confidence: t.score, sources: t.sources || [t.by] })), content: recordText(r, 40000), links: r.links, captured: r.enrichment !== 'pending', classified_by: r.classifiedBy };
        if (a.include_page) { const link = r.card?.url || r.links?.find(l => !/(x|twitter)\.com\//.test(l)); const page = link && await fetchPage(link); if (page?.ok) out.linked_page = { url: page.url, title: page.title, text: page.text.slice(0, 20000) }; }
        return out;
      }
    },
    {
      name: 'update_bookmark', write: true, description: 'Change one bookmark: add/remove tags (names, paths or ids; unknown names become new personal labels), set triage (kept | archived | untriaged), set or clear the note, or restore a deleted bookmark (deleted: false).',
      input: { type: 'object', properties: { id: { type: 'string' }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } }, triage: { type: 'string', enum: ['kept', 'archived', 'untriaged'] }, note: { type: 'string' }, deleted: { type: 'boolean' } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); if (!c.ix.byId.has(String(a.id))) throw new Error(`No bookmark ${a.id}`);
        const res = await applyPatch(c, [String(a.id)], a);
        if (res.created.length) Object.assign(c, await ctx()); // newly created labels need the fresh taxonomy for names
        const bits = [res.add.length && `Tagged ${res.add.map(c.path).join(', ')}`, res.remove.length && `untagged ${res.remove.map(c.path).join(', ')}`, a.triage && `marked ${a.triage}`, 'note' in a && (a.note ? 'updated the note' : 'cleared the note'), a.deleted === false && 'restored it'].filter(Boolean);
        const t = (c.ix.byId.get(String(a.id))?.title || a.id).slice(0, 60);
        return { ok: true, summary: `${bits.join(', ') || 'no change'} · “${t}”`, created_labels: res.created };
      }
    },
    {
      name: 'bulk_update_bookmarks', write: true, description: `Apply the same change to many bookmarks selected by ids or a filter: add/remove tags, triage, note. Use dry_run to preview. More than ${CONFIRM_OVER} bookmarks requires confirm: true after the user agrees.`,
      input: { type: 'object', properties: { select: selector, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } }, triage: { type: 'string', enum: ['kept', 'archived', 'untriaged'] }, note: { type: 'string' }, dry_run: { type: 'boolean' }, confirm: { type: 'boolean' } }, required: ['select'] },
      run: async (a) => {
        const c = await ctx();
        const list = select(c, { status: 'all', ...a.select }).slice(0, 2000);
        const sample = list.slice(0, 5).map(r => ({ id: r.id, title: r.title?.slice(0, 80) }));
        if (a.dry_run) return { count: list.length, sample };
        if (list.length > CONFIRM_OVER && !a.confirm) return needConfirm(list.length, 'change', sample);
        const patch = Object.fromEntries(['add_tags', 'remove_tags', 'triage', 'note'].filter(k => k in a).map(k => [k, a[k]]));
        const res = await applyPatch(c, list.map(r => r.id), patch);
        if (res.created.length) Object.assign(c, await ctx());
        return { ok: true, count: list.length, summary: `Updated ${list.length} bookmark${list.length === 1 ? '' : 's'}${res.add.length ? ` · +${res.add.map(c.path).join(', ')}` : ''}${res.remove.length ? ` · −${res.remove.map(c.path).join(', ')}` : ''}${a.triage ? ` · ${a.triage}` : ''}` };
      }
    },
    {
      name: 'create_bookmark', write: true, description: 'Save any web page into Corpus by URL (fetches its text so it can be read, searched, chatted with and classified). Optionally tag it and add a note.',
      input: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, text: { type: 'string', description: 'Use instead of fetching the page' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['url'] },
      run: async (a) => {
        const item = await addManual(a, { maxSortIndex: await maxSortIndex() });
        await rebuild('ops:create');
        if (a.tags?.length || a.note) await applyPatch(await ctx(), [item.id], { add_tags: a.tags, note: a.note });
        return { ok: true, id: item.id, title: item.title, fetched_chars: item.text.length, summary: `Saved “${item.title}” as ${item.id}` };
      }
    },
    {
      name: 'delete_bookmark', write: true, description: 'Move a bookmark to Trash. It stays restorable for 30 days (update_bookmark deleted: false), then is purged. FieldTheory\'s files are never modified. Requires confirm: true after the user agrees.',
      input: { type: 'object', properties: { id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); const r = c.ix.byId.get(String(a.id));
        if (!r) throw new Error(`No bookmark ${a.id}`);
        if (!a.confirm) return { needs_confirmation: true, message: `Delete “${r.title?.slice(0, 80)}”? Ask the user, then call again with confirm: true.` };
        await applyPatch(c, [r.id], { deleted: true });
        return { ok: true, summary: `Moved “${(r.title || r.id).slice(0, 60)}” to Trash (kept 30 days)` };
      }
    },
    {
      name: 'list_concepts', description: 'The taxonomy: concepts per facet (topic, kind, format, contains, label) with parent, keywords and bookmark counts.',
      input: { type: 'object', properties: { facet: { type: 'string', enum: ['topic', 'kind', 'format', 'contains', 'label'] }, query: { type: 'string' } } },
      run: async (a) => {
        const c = await ctx(); const counts = new Map();
        for (const r of c.ix.records) { const o = c.state.overrides[r.id] || {}; if (o.deleted) continue; for (const t of effectiveTags(r, o)) counts.set(t.id, (counts.get(t.id) || 0) + 1); }
        const q = (a.query || '').toLowerCase();
        return { concepts: c.ix.concepts.filter(x => x.facet !== 'source' && (!a.facet || x.facet === a.facet) && (!q || x.label.toLowerCase().includes(q) || x.id.includes(q) || (x.aliases || []).some(k => k.includes(q)))).map(x => ({ id: x.id, name: c.path(x.id), facet: x.facet, parent: x.parent, keywords: x.aliases || [], bookmarks: c.descendants(x.id).reduce((s, id) => s + (counts.get(id) || 0), 0), origin: x.origin })) };
      }
    },
    {
      name: 'create_concept', write: true, description: 'Add a concept to the taxonomy (topic, kind, format, contains or label), optionally under a parent and with keywords that route matching bookmarks to it on the next build.',
      input: { type: 'object', properties: { label: { type: 'string' }, facet: { type: 'string', enum: ['topic', 'kind', 'format', 'contains', 'label'] }, parent: { type: 'string', description: 'Parent concept name or id (same facet)' }, keywords: { type: 'array', items: { type: 'string' } } }, required: ['label', 'facet'] },
      run: async (a) => {
        const c = await ctx();
        const parent = a.parent ? resolveConcept(c, a.parent) : null;
        if (a.parent && !parent) throw new Error(`Unknown parent "${a.parent}"`);
        const id = `${a.facet}:${parent ? `${parent.split(':')[1]}/` : ''}${slugify(a.label)}`;
        if (c.ix.conceptById.has(id)) throw new Error(`Concept ${id} already exists`);
        await createConceptRaw({ id, label: a.label.trim(), facet: a.facet, parent, aliases: (a.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean) });
        return { ok: true, id, summary: `Created ${a.facet} “${a.label}”${parent ? ` under ${c.path(parent)}` : ''}` };
      }
    },
    {
      name: 'update_concept', write: true, description: 'Rename a concept, move it under another parent (or to top level with parent: ""), or replace its keywords. Keyword changes re-tag the library on rebuild.',
      input: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, parent: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); const id = resolveConcept(c, a.id); if (!id) throw new Error(`Unknown concept ${a.id}`);
        const patch = {};
        if (a.label) patch.label = a.label.trim();
        if ('parent' in a) patch.parent = a.parent ? resolveConcept(c, a.parent) : null;
        if (a.keywords) patch.aliases = a.keywords.map(k => k.toLowerCase().trim()).filter(Boolean);
        await writeState(st => { st.taxonomy.concepts[id] = { ...(st.taxonomy.concepts[id] || {}), ...patch }; });
        await rebuild('ops:taxonomy');
        return { ok: true, id, summary: `Updated ${c.path(id)}` };
      }
    },
    {
      name: 'delete_concept', write: true, description: 'Remove a concept (user-created concepts are deleted; built-in ones are retired). Bookmarks keep their other tags. Requires confirm: true after the user agrees.',
      input: { type: 'object', properties: { id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); const id = resolveConcept(c, a.id); if (!id) throw new Error(`Unknown concept ${a.id}`);
        if (!a.confirm) return { needs_confirmation: true, message: `Remove “${c.path(id)}”? Ask the user, then call again with confirm: true.` };
        await writeState(st => { if (defaultIds.has(id)) st.taxonomy.concepts[id] = { deleted: true }; else delete st.taxonomy.concepts[id]; });
        await rebuild('ops:taxonomy');
        return { ok: true, summary: `Removed ${c.path(id)}` };
      }
    },
    {
      name: 'list_skills', description: 'Saved skills: reusable instructions (e.g. weekly-digest, triage-assistant) you can follow on request.',
      input: { type: 'object', properties: {} },
      run: async () => ({ skills: (await listSkills()).map(s => ({ name: s.name, description: s.description })) })
    },
    {
      name: 'get_skill', description: 'Read a skill\'s full instructions before following it.',
      input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      run: async (a) => { const s = await getSkill(a.name); if (!s) throw new Error(`No skill named ${a.name}`); return s; }
    },
    {
      name: 'create_skill', write: true, description: 'Save a new skill: a short kebab-case name, a one-line description, and step-by-step instructions (which tools to use, what to produce, when to ask before changing things).',
      input: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } }, required: ['name', 'description', 'instructions'] },
      run: async (a) => { const s = await saveSkill(a, { create: true }); return { ok: true, name: s.name, summary: `Created skill ${s.name}` }; }
    },
    {
      name: 'update_skill', write: true, description: 'Change a skill\'s description and/or instructions.',
      input: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } }, required: ['name'] },
      run: async (a) => { const s = await saveSkill(a); return { ok: true, name: s.name, summary: `Updated skill ${s.name}` }; }
    },
    {
      name: 'delete_skill', write: true, description: 'Delete a skill. Requires confirm: true after the user agrees.',
      input: { type: 'object', properties: { name: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['name'] },
      run: async (a) => { if (!a.confirm) return { needs_confirmation: true, message: `Delete skill ${a.name}? Ask the user, then call again with confirm: true.` }; await deleteSkill(a.name); return { ok: true, summary: `Deleted skill ${slugify(a.name)}` }; }
    },
    {
      name: 'run_classification', write: true, description: 'Run TypeSafe Jev over bookmarks (full thread/article content) to re-score topic and kind tags. Choose bookmarks with select, or scope "unclassified". Runs in the background; returns a job id for get_job. Over 200 bookmarks requires confirm: true. Cost ≈ $0.04 per million tokens (~$0.0002 per bookmark).',
      input: { type: 'object', properties: { select: selector, scope: { type: 'string', enum: ['selection', 'unclassified'] }, confirm: { type: 'boolean' } } },
      run: async (a) => {
        if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not configured on the server');
        const c = await ctx();
        let list = a.scope === 'unclassified' ? select(c, { status: 'all', unclassified: true, ...(a.select || {}) }) : select(c, { status: 'all', ...(a.select || {}) });
        list = list.filter(r => r.enrichment !== 'pending' || r.provider === 'web');
        if (!list.length) return { ok: true, count: 0, summary: 'Nothing to classify (uncaptured bookmarks are classified once their thread is captured)' };
        if (list.length > 200 && !a.confirm) return needConfirm(list.length, 'classify', list.slice(0, 3).map(r => r.id));
        const job = { id: crypto.randomUUID().slice(0, 8), kind: 'classification', status: 'running', total: list.length, done: 0, failed: 0, tokens: 0, startedAt: new Date().toISOString() };
        jobs.set(job.id, job);
        (async () => {
          try {
            for (let i = 0; i < list.length; i += 25) {
              const res = await classifyMany(list.slice(i, i + 25), c.ix.concepts, { concurrency: 6, log });
              job.done += res.ok; job.failed += res.failed; job.tokens += res.tokens;
            }
            await rebuild('ops:classify');
            job.status = 'done';
          } catch (e) { job.status = 'failed'; job.error = e.message; }
          job.finishedAt = new Date().toISOString();
          job.cost_usd = Math.round(job.tokens * 0.042 / 1e6 * 10000) / 10000;
        })();
        return { ok: true, job: job.id, count: list.length, summary: `Started Jev classification of ${list.length} bookmark${list.length === 1 ? '' : 's'} (job ${job.id})` };
      }
    },
    {
      name: 'get_job', description: 'Progress of a background job (classification). Omit id to list recent jobs.',
      input: { type: 'object', properties: { id: { type: 'string' } } },
      run: async (a) => a.id ? (jobs.get(a.id) || { error: 'No such job' }) : { jobs: [...jobs.values()].slice(-10).reverse() }
    },
    {
      name: 'capture_threads', write: true, description: 'Fetch the full thread / X article / link card for bookmarks now (front of the capture queue). Useful for bookmarks whose content is missing.',
      input: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
      run: async (a) => {
        const c = await ctx();
        const ids = a.ids.map(String).filter(id => c.ix.byId.get(id)?.enrichment === 'pending').slice(0, 100);
        for (const id of ids.reverse()) requestPriority(id);
        enricher?.kick();
        return { ok: true, queued: ids.length, summary: ids.length ? `Queued ${ids.length} bookmark${ids.length === 1 ? '' : 's'} for capture` : 'Those bookmarks are already captured' };
      }
    },
    {
      name: 'rebuild_index', write: true, description: 'Rebuild the index from the FieldTheory source (picks up newly synced bookmarks and taxonomy edits).',
      input: { type: 'object', properties: {} },
      run: async () => { const r = await rebuild('ops:rebuild'); return { ok: true, total: r.total, summary: `Rebuilt · ${r.total} bookmarks` }; }
    }
  ];

  // Hand-added items sort just after the newest FieldTheory bookmark at the time they're saved.
  async function maxSortIndex() {
    let max = 0n;
    const raw = await fs.readFile(paths.source, 'utf8').catch(() => '');
    for (const m of raw.matchAll(/"sortIndex":"(\d+)"/g)) { const v = BigInt(m[1]); if (v > max) max = v; }
    for (const m of await readManual()) { const v = BigInt(m.sortIndex || 0); if (v > max) max = v; }
    return max;
  }

  const byName = new Map(tools.map(t => [t.name, t]));
  async function call(name, args = {}) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const result = await tool.run(args || {});
    return { result, write: !!tool.write, summary: result?.summary || null };
  }
  const openaiTools = () => tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } }));
  const mcpTools = () => tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.input, annotations: { readOnlyHint: !t.write, destructiveHint: /delete/.test(t.name) } }));
  return { tools, call, openaiTools, mcpTools, jobs };
}
