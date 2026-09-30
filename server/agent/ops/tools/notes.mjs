// Scratchpads (the inbox-wide one and each bookmark's) and highlights.
import { readPad, writePad, appendBlock } from '../../../library/scratchpad.mjs';
import { writeState } from '../../../library/state.mjs';

export default function notesTools(kit) {
  const { ctx, whereOf } = kit;
  return [
    {
      name: 'read_scratchpad', description: 'Read a scratchpad. Without id: the inbox-wide scratchpad, one running Markdown document shared by the user and every agent (plans, findings, lists, reading notes across bookmarks). With id: that bookmark\'s own scratchpad. Read it before writing so you build on what is there.',
      input: { type: 'object', properties: { id: { type: 'string', description: 'A bookmark id; omit for the inbox-wide scratchpad' } } },
      run: async (a) => {
        if (!a.id) { const p = await readPad(); return { scope: 'inbox', text: p.text, updated_at: p.updatedAt, updated_by: p.updatedBy, chars: p.text.length }; }
        const c = await ctx(); const r = c.ix.byId.get(String(a.id));
        if (!r) throw new Error(`No bookmark ${a.id}`);
        return { scope: 'bookmark', id: r.id, title: r.title, text: c.state.overrides[r.id]?.scratchpad || '' };
      }
    },
    {
      name: 'write_scratchpad', write: true, description: 'Write to a scratchpad (Markdown). Without id: the inbox-wide scratchpad shared with the user and other agents. With id: that bookmark\'s scratchpad. mode "append" (default) adds a block at the end; "replace" rewrites the whole pad, so only use it when the user asks or to tidy what you wrote yourself. Earlier versions of the inbox pad are kept. Cite bookmarks as [[id]].',
      input: { type: 'object', properties: { id: { type: 'string', description: 'A bookmark id; omit for the inbox-wide scratchpad' }, text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'], default: 'append' } }, required: ['text'] },
      run: async (a, meta = {}) => {
        const mode = a.mode === 'replace' ? 'replace' : 'append';
        if (!a.id) {
          const p = await writePad({ text: String(a.text ?? ''), mode, by: meta.by || 'agent' });
          return { ok: true, scope: 'inbox', chars: p.text.length, summary: mode === 'append' ? 'Added to the inbox scratchpad' : 'Rewrote the inbox scratchpad' };
        }
        const c = await ctx(); const r = c.ix.byId.get(String(a.id));
        if (!r) throw new Error(`No bookmark ${a.id}`);
        let text;
        await writeState(st => {
          const o = { ...(st.overrides[r.id] || {}) };
          text = mode === 'append' ? appendBlock(o.scratchpad, a.text) : String(a.text ?? '').trim();
          if (text) o.scratchpad = text; else delete o.scratchpad;
          o.updatedAt = new Date().toISOString();
          st.overrides[r.id] = o;
        });
        return { ok: true, scope: 'bookmark', id: r.id, chars: text.length, summary: `${mode === 'append' ? 'Added to' : 'Rewrote'} the scratchpad of “${(r.title || r.id).slice(0, 60)}”` };
      }
    },
    {
      name: 'list_highlights', description: 'Passages the user highlighted while reading, newest first, with any note they attached, where it is (chapter or page, for books and PDFs) and the bookmark each comes from. Filter by bookmark id or by words in the highlight or note.',
      input: { type: 'object', properties: { id: { type: 'string', description: 'Only this bookmark' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
      run: async (a) => {
        const c = await ctx(); const q = String(a.query || '').toLowerCase();
        const out = [];
        for (const [id, o] of Object.entries(c.state.overrides)) {
          if (!o.highlights?.length || o.deleted || (a.id && id !== String(a.id))) continue;
          const r = c.ix.byId.get(id); if (!r) continue;
          for (const h of o.highlights) { const text = h.quote || h.text; if (!q || `${text} ${h.note || ''}`.toLowerCase().includes(q)) out.push({ bookmark: id, title: (r.title || '').slice(0, 120), author: r.provider === 'file' ? r.author.name || 'file' : `@${r.author.handle}`, url: r.url, text, note: h.note || undefined, where: whereOf(r, h), at: h.at }); }
        }
        out.sort((x, y) => String(y.at).localeCompare(String(x.at)));
        return { total: out.length, highlights: out.slice(0, Math.min(200, a.limit || 50)) };
      }
    }
  ];
}
