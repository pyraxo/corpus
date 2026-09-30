// Changing bookmarks: tags, triage and scratchpads, one or many; what they say (edit); adding and deleting.
import { editManual, restoreManual, rereadManual } from '../../../library/manual.mjs';
import { updateDoc } from '../../../files/store.mjs';
import { writeState } from '../../../library/state.mjs';

const CONFIRM_OVER = 25;

export default function bookmarksTools(kit) {
  const { ctx, select, selector, applyPatch, ingest, fetchFile, needConfirm, saveLink, rebuild } = kit;
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
      name: 'edit_bookmark', write: true, description: 'Edit what a bookmark says. Links saved by URL: title, author, site, published (YYYY-MM-DD), cover (an image URL), description, and blocks: the whole article body, as [{type: p|h2|h3|h4|li|oli|quote|code|caption, text} | {type: image, url} | {type: divider}]. action "restore" goes back to the page as it was first read; "reread" reads the page again from the web. Files: title, author (comma-separated for several), publisher, published, description. Posts from X: title only (the post itself comes from X).',
      input: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, author: { type: 'string' }, site: { type: 'string' }, published: { type: 'string' }, cover: { type: 'string' }, description: { type: 'string' }, blocks: { type: 'array', items: { type: 'object' } }, action: { type: 'string', enum: ['save', 'restore', 'reread'] } }, required: ['id'] },
      run: async (a) => {
        const c = await ctx(); const r = c.ix.byId.get(String(a.id));
        if (!r) throw new Error(`No bookmark ${a.id}`);
        const has = (k) => k in a && a[k] !== undefined;
        if (r.provider === 'web') {
          const item = a.action === 'restore' ? await restoreManual(r.id) : a.action === 'reread' ? await rereadManual(r.id) : await editManual(r.id, Object.fromEntries(['title', 'author', 'site', 'published', 'cover', 'description', 'blocks'].filter(has).map(k => [k, a[k]])));
          if (!item) throw new Error(`${r.id} isn't a saved link`);
        } else if (r.provider === 'file') {
          const patch = {};
          if (has('title') && String(a.title).trim()) patch.title = String(a.title).trim().slice(0, 300);
          if (has('author')) patch.authors = String(a.author || '').split(/\s*[,;]\s*/).filter(Boolean);
          for (const k of ['publisher', 'published', 'description']) if (has(k)) patch[k] = String(a[k] || '').trim() || null;
          await updateDoc(r.id, patch);
        } else {
          if (!has('title')) throw new Error('Only the title of a post from X can be changed');
          await writeState(st => { const o = { ...(st.overrides[r.id] || {}) }; if (String(a.title).trim()) o.title = String(a.title).trim().slice(0, 300); else delete o.title; o.updatedAt = new Date().toISOString(); st.overrides[r.id] = o; });
        }
        // Restoring and re-reading change what the reader shows, so they wait for the index; an edit
        // is already on screen (the page applies it), so the index catches up in the background.
        if (a.action === 'restore' || a.action === 'reread') {
          const now = (await rebuild('edit')).records.find(x => x.id === r.id);
          return { ok: true, id: r.id, title: now?.title, summary: a.action === 'restore' ? `Restored “${now?.title}” to the page as first read` : `Read “${now?.title}” again from the web` };
        }
        rebuild('edit').catch(() => {});
        return { ok: true, id: r.id, summary: `Edited “${String(a.title || r.title || r.id).slice(0, 60)}”; search and agents see it once the index is rebuilt, in a few seconds` };
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
      name: 'create_bookmark', write: true, description: 'Save any web page into Corpus by URL. The page is read as an article (title, author, date, cover and body) so it can be read in the reader, searched, chatted with and classified by Jev. A link to a PDF, EPUB or MOBI book, or an image, is downloaded and added as a file with its own reader and Jev tagging. Optionally tag it and start its scratchpad.',
      input: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, text: { type: 'string', description: 'Use instead of fetching the page' }, scratchpad: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['url'] },
      run: async (a) => {
        const file = await fetchFile(a.url);
        if (file) {
          const res = await ingest(file.data, file.name);
          if (a.tags?.length || a.scratchpad) await applyPatch(await ctx(), [res.id], { add_tags: a.tags, scratchpad: a.scratchpad });
          return { ok: true, id: res.id, title: res.title, kind: res.kind, job: res.job, summary: res.duplicate ? `Already saved as ${res.id}` : `Added “${res.title}” (${res.kind}) as ${res.id}` };
        }
        const res = await saveLink({ url: a.url, title: a.title, text: a.text });
        if (a.tags?.length || a.scratchpad) await applyPatch(await ctx(), [res.id], { add_tags: a.tags, scratchpad: a.scratchpad });
        return { ok: true, ...res, kind: 'web', summary: res.duplicate ? `Already saved as ${res.id}` : `Saved “${res.title}” (${res.isArticle ? `article, ${res.words} words` : 'page'}) as ${res.id}` };
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
