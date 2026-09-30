// Adding files (images, PDFs, EPUB/MOBI books, text) and their covers.
import { FILE_ID, setCover } from '../../files/store.mjs';
import { send, readRaw } from '../respond.mjs';

const COVER_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export function fileRoutes(r) {
  // Dropped, pasted or picked files, as the raw body; the name comes in x-file-name.
  r.post('/api/files', async ({ req, res, core }) => {
    let name = String(req.headers['x-file-name'] || 'file');
    try { name = decodeURIComponent(name); } catch {}
    name = name.slice(0, 300);
    try { send(res, 200, { ok: true, ...(await core.ops.ingest(await readRaw(req), name)) }); }
    catch (e) { core.log(`[files] ${name}: ${e.message}`); send(res, e.status || 400, { ok: false, error: e.message }); }
  });
  // PDF covers are drawn in the browser (the server has no canvas) and sent back here.
  r.put('/api/files/:id/cover', async ({ req, res, params, core }) => {
    const type = String(req.headers['content-type'] || '');
    if (!FILE_ID.test(params.id) || !COVER_EXT[type]) return send(res, 400, { ok: false });
    const doc = await setCover(params.id, await readRaw(req, 8e6), COVER_EXT[type]);
    if (!doc) return send(res, 404, { ok: false });
    await core.rebuild('cover');
    send(res, 200, { ok: true, cover: `/files/${params.id}/${doc.cover}` });
  });
}
