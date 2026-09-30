// The taxonomy: listing, adding, changing and removing concepts.
import { slugify } from '../../../library/skills.mjs';
import { writeState } from '../../../library/state.mjs';
import { defaultConcepts } from '../../../library/taxonomy.mjs';

const defaultIds = new Set(defaultConcepts().map(c => c.id));

export default function taxonomyTools(kit) {
  const { effectiveTags, ctx, resolveConcept, createConceptRaw, rebuild } = kit;
  return [
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
    }
  ];
}
