// Ask, agents and shared notes: every capability as ops (the same tools MCP exposes), the chat
// stream and saved conversations, skills, the inbox scratchpad, and what an agent needs to connect.
import { runChat, listChats, getChat, deleteChat, setChatArchived } from '../../agent/chat.mjs';
import { listSkills } from '../../library/skills.mjs';
import { readPad, writePad } from '../../library/scratchpad.mjs';
import { send, readJson } from '../respond.mjs';

const chatLimit = Number(process.env.CHAT_LIMIT_PER_HOUR || 200);

export function agentRoutes(r) {
  r.post('/api/ops', async ({ req, res, core }) => {
    const { tool, args } = await readJson(req);
    try { send(res, 200, await core.ops.call(tool, args, { by: 'you' })); } catch (e) { send(res, 400, { ok: false, error: e.message }); }
  });
  r.get('/api/mcp', ({ req, res, core }) => send(res, 200, { url: `${req.headers['x-forwarded-proto'] === 'https' || req.headers['cf-visitor'] ? 'https' : 'http'}://${req.headers.host}/mcp`, token: process.env.CORPUS_MCP_TOKEN || null, tools: core.ops.tools.length }));
  r.get('/api/skills', async ({ res }) => send(res, 200, { skills: await listSkills() }));

  r.get('/api/chats', async ({ res, url }) => send(res, 200, { chats: await listChats({ scope: url.searchParams.get('scope'), bookmark: url.searchParams.get('bookmark'), archived: url.searchParams.get('archived') === '1' }) }));
  r.get('/api/chats/:id', async ({ res, params }) => { const c = await getChat(params.id); c ? send(res, 200, c) : send(res, 404, { ok: false }); });
  r.put('/api/chats/:id', async ({ req, res, params }) => {
    const { archived } = await readJson(req);
    const c = await setChatArchived(params.id, archived);
    c ? send(res, 200, { ok: true, chat: c }) : send(res, 404, { ok: false });
  });
  r.delete('/api/chats/:id', async ({ res, params }) => { await deleteChat(params.id); send(res, 200, { ok: true }); });

  // Answers stream as server-sent events: meta, status, delta, action, done or error.
  const window = [];
  r.post('/api/chat', async ({ req, res, core }) => {
    const now = Date.now();
    while (window.length && window[0] < now - 3600_000) window.shift();
    if (window.length >= chatLimit) return send(res, 429, { ok: false, error: 'Chat limit reached for this hour' });
    window.push(now);
    const body = await readJson(req);
    if (!String(body.message || '').trim()) return send(res, 400, { ok: false, error: 'Empty message' });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try { await runChat({ ix: await core.getIndex(), ops: core.ops, ...body, message: String(body.message).slice(0, 8000) }, emit); }
    catch (e) { core.log(`[chat] ${e.message}`); emit('error', { message: e.message }); }
    res.end();
  });

  r.get('/api/scratchpad', async ({ res }) => { const p = await readPad(); send(res, 200, { text: p.text, updatedAt: p.updatedAt, updatedBy: p.updatedBy, revisions: p.history.length }); });
  r.put('/api/scratchpad', async ({ req, res }) => {
    const { text, base } = await readJson(req);
    try { const p = await writePad({ text: String(text ?? ''), mode: 'replace', by: 'you', base }); send(res, 200, { ok: true, text: p.text, updatedAt: p.updatedAt, updatedBy: p.updatedBy, merged: !!p.merged }); }
    catch (e) { send(res, 400, { ok: false, error: e.message }); }
  });
}
