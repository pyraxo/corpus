// Changing bookmarks: tags, triage and scratchpads, one or many; adding and deleting.
import { addManual } from '../../../library/manual.mjs';
import { maxSortIndex } from '../../../files/store.mjs';

const CONFIRM_OVER = 25;

export default function bookmarksTools(kit) {
  const { ctx, select, selector, applyPatch, ingest, fetchFile, needConfirm, rebuild } = kit;
  return [
    {
      name: 'update_bookmark', write: true, description: 'Change one bookmark: add/remove tags (names, paths or ids; unknown names become new personal labels), set triage (kept | archived | untriaged), replace or clear its scratchpad (to add to it instead, use write_scratchpad), or restore a deleted bookmark (deleted: false).',
      input: { type: 'object', properties: { id: { type: 'string' }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } }, triage: { type: 'string', enum: ['kept', 'archived', 'untriaged'] }, scratchpad: { type: 'string', description: 'Replaces the bookmark\'s scratchpad; empty clears it' }, deleted: { type: 'boolean' } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); if (!c.ix.byId.has(String(a.id))) throw new Error(`No bookmark ${a.id}`);
        const res = await applyPatch(c, [String(a.id)], a);
        if (res.created.length) Object.assign(c, await ctx()); // newly created labels need the fresh taxonomy for names
        const bits = [res.add.length && `Tagged ${res.add.map(c.path).join(', ')}`, res.remove.length && `untagged ${res.remove.map(c.path).join(', ')}`, a.triage && `marked ${a.triage}`, 'scratchpad' in a && (a.scratchpad ? 'updated its scratchpad' : 'cleared its scratchpad'), a.deleted === false && 'restored it'].filter(Boolean);
        const t = (c.ix.byId.get(String(a.id))?.title || a.id).slice(0, 60);
        return { ok: true, summary: `${bits.join(', ') || 'no change'} · “${t}”`, created_labels: res.created };
      }
    },
    {
      name: 'bulk_update_bookmarks', write: true, description: `Apply the same change to many bookmarks selected by ids or a filter: add/remove tags, triage, scratchpad. Use dry_run to preview. More than ${CONFIRM_OVER} bookmarks requires confirm: true after the user agrees.`,
      input: { type: 'object', properties: { select: selector, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } }, triage: { type: 'string', enum: ['kept', 'archived', 'untriaged'] }, scratchpad: { type: 'string' }, dry_run: { type: 'boolean' }, confirm: { type: 'boolean' } }, required: ['select'] },
      run: async (a) => {
        const c = await ctx();
        const list = select(c, { status: 'all', ...a.select }).slice(0, 2000);
        const sample = list.slice(0, 5).map(r => ({ id: r.id, title: r.title?.slice(0, 80) }));
        if (a.dry_run) return { count: list.length, sample };
        if (list.length > CONFIRM_OVER && !a.confirm) return needConfirm(list.length, 'change', sample);
        const patch = Object.fromEntries(['add_tags', 'remove_tags', 'triage', 'scratchpad'].filter(k => k in a).map(k => [k, a[k]]));
        const res = await applyPatch(c, list.map(r => r.id), patch);
        if (res.created.length) Object.assign(c, await ctx());
        return { ok: true, count: list.length, summary: `Updated ${list.length} bookmark${list.length === 1 ? '' : 's'}${res.add.length ? ` · +${res.add.map(c.path).join(', ')}` : ''}${res.remove.length ? ` · −${res.remove.map(c.path).join(', ')}` : ''}${a.triage ? ` · ${a.triage}` : ''}` };
      }
    },
    {
      name: 'create_bookmark', write: true, description: 'Save any web page into Corpus by URL (fetches its text so it can be read, searched, chatted with and classified). A link to a PDF, EPUB or MOBI book, or an image, is downloaded and added as a file with its own reader and Jev tagging. Optionally tag it and start its scratchpad.',
      input: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, text: { type: 'string', description: 'Use instead of fetching the page' }, scratchpad: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['url'] },
      run: async (a) => {
        const file = await fetchFile(a.url);
        if (file) {
          const res = await ingest(file.data, file.name);
          if (a.tags?.length || a.scratchpad) await applyPatch(await ctx(), [res.id], { add_tags: a.tags, scratchpad: a.scratchpad });
          return { ok: true, id: res.id, title: res.title, kind: res.kind, job: res.job, summary: res.duplicate ? `Already saved as ${res.id}` : `Added “${res.title}” (${res.kind}) as ${res.id}` };
        }
        const item = await addManual({ url: a.url, title: a.title, text: a.text }, { maxSortIndex: await maxSortIndex() });
        await rebuild('ops:create');
        if (a.tags?.length || a.scratchpad) await applyPatch(await ctx(), [item.id], { add_tags: a.tags, scratchpad: a.scratchpad });
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
    }
  ];
}
