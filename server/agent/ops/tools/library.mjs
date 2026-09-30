// Reading the library: an overview, search, one bookmark in full, and a file's text.
import { listSkills } from '../../../library/skills.mjs';
import { lockHolder } from '../../../capture/lock.mjs';
import { recordText } from '../../../classify/jev.mjs';
import { readDoc, readSections } from '../../../files/store.mjs';
import { fetchPage } from '../../../capture/pages.mjs';

const day = (iso) => (iso || '').slice(0, 10);

export default function libraryTools(kit) {
  const { jobs, effectiveTags, statusOf, ctx, compact, select, filterProps, whereOf } = kit;
  return [
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
      name: 'read_bookmark', description: 'Full content of one bookmark: every thread part, article text, link card, quoted post, tags with confidence and sources, triage state, its scratchpad and the passages the user highlighted. Set include_page to also fetch the linked web page.',
      input: { type: 'object', properties: { id: { type: 'string' }, include_page: { type: 'boolean', default: false } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); const r = c.ix.byId.get(String(a.id));
        if (!r) throw new Error(`No bookmark ${a.id}`);
        const o = c.state.overrides[r.id] || {};
        const out = { ...compact(c, r, 0), snippet: undefined, tags: effectiveTags(r, o).filter(t => !t.id.startsWith('source:')).map(t => ({ id: t.id, name: c.path(t.id), confidence: t.score, sources: t.sources || [t.by] })), highlights: (o.highlights || []).map(h => ({ text: h.quote || h.text, note: h.note || undefined, where: whereOf(r, h), at: h.at })), content: recordText(r, 40000), links: r.links, captured: r.enrichment !== 'pending', classified_by: r.classifiedBy };
        if (r.doc) {
          const d = { doc: await readDoc(r.id) || {} };
          out.document = { kind: r.doc.kind, file_name: r.doc.name, pages: r.doc.pages, words: r.doc.words, authors: r.doc.authors, publisher: r.doc.publisher, published: r.doc.published, language: r.doc.language, isbn: r.doc.isbn, subjects: r.doc.subjects, description: r.doc.description,
            // section is what read_document takes (0-based); PDFs also give the printed page number.
            contents: (d.doc.toc?.length ? d.doc.toc.map(t => ({ title: t.title, section: t.page ?? t.ch, ...(t.page != null && { page: t.page + 1 }) })) : (d.doc.chapters || []).map((ch, i) => ({ title: ch.title || `Section ${i + 1}`, section: i }))).slice(0, 200),
            sections: d.doc.kind === 'pdf' ? d.doc.pages : d.doc.chapters?.length, read_more: 'read_document(id, from, to) returns the full text of sections (chapters, or PDF pages), by the section numbers above' };
          if (r.suggested?.length) out.suggested_new_tags = r.suggested.map(x => ({ name: x.label, under: x.parent ? c.path(x.parent) : null, confidence: x.score }));
        }
        if (a.include_page) { const link = r.card?.url || r.links?.find(l => !/(x|twitter)\.com\//.test(l)); const page = link && await fetchPage(link); if (page?.ok) out.linked_page = { url: page.url, title: page.title, text: page.text.slice(0, 20000) }; }
        return out;
      }
    },
    {
      name: 'read_document', description: 'Full text of a file the user added (PDF, EPUB/MOBI book, text), by section: a book\'s chapter files or a PDF\'s pages, numbered from 0. read_bookmark lists the contents with their section numbers; highlights say which section they are in.',
      input: { type: 'object', properties: { id: { type: 'string' }, from: { type: 'integer', minimum: 0, default: 0 }, to: { type: 'integer', minimum: 0, description: 'Inclusive; defaults to from. At most 40 000 characters are returned.' } }, required: ['id'] },
      run: async (a) => {
        const res = await readSections(String(a.id), { from: a.from || 0, to: a.to ?? a.from ?? 0 });
        if (!res) throw new Error(`${a.id} is not a file (only files have documents to read)`);
        let budget = 40000;
        const sections = [];
        for (const t of res.texts) { if (budget <= 0) break; sections.push({ ...t, text: t.text.slice(0, budget) }); budget -= t.text.length; }
        return { id: res.doc.id, title: res.doc.title, unit: res.doc.kind === 'pdf' ? 'page' : 'chapter', total: res.total, sections, truncated: budget < 0 || undefined };
      }
    }
  ];
}
