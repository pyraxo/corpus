// Chat over one bookmark or the whole corpus via OpenRouter.
// Streams text to the client; the model has every Corpus capability as tools (lib/ops.mjs).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './paths.mjs';
import { recordText } from './jev.mjs';
import { fetchPage } from './pages.mjs';
import { listSkills } from './skills.mjs';

export const MODELS = [
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', note: '$0.15 / $0.50 per M' },
  { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', note: '$0.02 / $0.32 per M' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super', note: 'free', fallbacks: ['nvidia/nemotron-3.5-lightning:free', 'thinkingmachines/inkling-small:free', 'google/gemma-4-31b-it:free', 'qwen/qwen3.8-27b:free'] }
];
const chatsDir = paths.chats;
const MAX_TOOL_ROUNDS = 8;

const label = (ix, id) => ix.conceptById.get(id)?.label || id;
const topTags = (ix, r) => r.tags.filter(t => /^(topic|kind|label):/.test(t.id)).slice(0, 3).map(t => label(ix, t.id));
const day = (iso) => (iso || '').slice(0, 10);

function compact(ix, r, n = 360) {
  const text = recordText(r, n).replace(/\s+/g, ' ');
  return { id: r.id, author: `@${r.author.handle}`, posted: day(r.postedAt), format: r.format.replace('format:', ''), parts: r.thread?.length || 1, tags: topTags(ix, r), title: r.title?.slice(0, 120), text };
}

async function fullRecord(ix, r, { withPage = true } = {}) {
  const lines = [
    `id: ${r.id}`, `author: ${r.author.name} (@${r.author.handle})`, `posted: ${day(r.postedAt)}`, `url: ${r.url}`,
    `format: ${r.format.replace('format:', '')}${r.thread ? ` (${r.thread.length} parts)` : ''}`,
    `tags: ${r.tags.filter(t => /^(topic|kind|label):/.test(t.id)).map(t => label(ix, t.id)).join(', ')}`,
    r.links?.length ? `links: ${r.links.slice(0, 6).join(' ')}` : null,
    '', recordText(r, 30000)
  ].filter(x => x !== null);
  const link = r.card?.url || r.links?.find(l => !/(x|twitter)\.com\//.test(l));
  if (withPage && link && r.format !== 'format:article' && r.provider !== 'web') {
    const page = await fetchPage(link);
    if (page?.ok) lines.push('', `--- Linked page: ${page.title || page.url} (${page.url}) ---`, page.text);
  }
  return lines.join('\n');
}

function overview(ix) {
  const counts = new Map();
  for (const r of ix.records) for (const t of r.tags) if (t.id.startsWith('topic:') && t.score >= 0.5) counts.set(t.id, (counts.get(t.id) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([id, n]) => `${label(ix, id)} (${n})`).join(', ');
  const dates = ix.records.map(r => r.postedAt).filter(Boolean).sort();
  return `The library has ${ix.records.length} bookmarks posted between ${day(dates[0])} and ${day(dates.at(-1))}. Most common topics: ${top}.`;
}

async function systemPrompt(ix, scope) {
  const today = new Date().toISOString().slice(0, 10);
  const skills = await listSkills();
  const common = `Cite bookmarks inline as [[id]] immediately after the claim they support (the id only, e.g. [[2101014004927729737]] or [[web-1a2b3c4d5e6f]]); the interface turns these into links. Never invent ids. Write concisely in plain Markdown: short paragraphs, lists when they help, no preamble. Today is ${today}.

You can also change the library with tools: tag/untag, triage (keep/archive), notes, save any URL (create_bookmark), delete, edit the taxonomy, manage skills, run Jev classification, capture missing threads, rebuild. Act directly on small, clearly requested changes. When a tool returns needs_confirmation, or before deleting anything or changing more than a handful of bookmarks, state exactly what you'll do and ask first; call again with confirm: true only after the user agrees. After changing things, say briefly what changed.
${skills.length ? `\nSkills (reusable procedures; when the user asks for one or a request matches, call get_skill and follow it):\n${skills.map(s => `- ${s.name}: ${s.description}`).join('\n')}` : ''}`;
  if (scope === 'bookmark') return `You are Corpus, helping the user with one bookmark they saved. Its full captured content, and the linked page when available, are below. Answer from it first. You can use search_bookmarks to find related things they saved, and update_bookmark to tag, triage or annotate this one when asked. If something isn't in the material, say so, and mark general knowledge as such. ${common}`;
  return `You are Corpus, a research assistant and operator for the user's personal library of saved bookmarks (mostly X posts, threads and long-form articles, plus saved web pages). Ground answers in the bookmarks: use search_bookmarks (several phrasings or filters if needed) and read_bookmark for detail. If the library doesn't cover something, say so plainly before adding general knowledge. ${overview(ix)} ${common}`;
}

// Parse an OpenRouter SSE stream: forward text deltas, assemble tool calls.
async function streamCompletion(body, onText) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': process.env.CORPUS_PUBLIC_URL || 'http://localhost', 'X-Title': 'Corpus' },
    body: JSON.stringify({ ...body, stream: true, usage: { include: true } })
  });
  if (!res.ok) { const t = await res.text(); let msg = t; try { msg = JSON.parse(t).error?.message || t; } catch {} throw new Error(`OpenRouter ${res.status}: ${String(msg).slice(0, 200)}`); }
  const decoder = new TextDecoder();
  let buf = '', content = '', finish = null, usage = null, model = null;
  const calls = [];
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'OpenRouter stream error');
      model = j.model || model;
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.delta?.content) { content += ch.delta.content; onText(ch.delta.content); }
      for (const tc of ch.delta?.tool_calls || []) {
        const c = calls[tc.index ?? calls.length] ||= { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { content, calls: calls.filter(Boolean), finish, usage, model };
}

export async function listChats({ scope, bookmark } = {}) {
  let names = [];
  try { names = await fs.readdir(chatsDir); } catch { return []; }
  const out = [];
  for (const n of names.filter(n => n.endsWith('.json'))) {
    try {
      const c = JSON.parse(await fs.readFile(path.join(chatsDir, n), 'utf8'));
      if (scope && c.scope !== scope) continue;
      if (bookmark && c.bookmarkId !== bookmark) continue;
      out.push({ id: c.id, scope: c.scope, bookmarkId: c.bookmarkId, title: c.title, updatedAt: c.updatedAt, count: c.messages.length });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
const chatFile = (id) => path.join(chatsDir, `${String(id).replace(/[^a-z0-9-]/gi, '')}.json`);
export async function getChat(id) { try { return JSON.parse(await fs.readFile(chatFile(id), 'utf8')); } catch { return null; } }
export async function deleteChat(id) { await fs.rm(chatFile(id), { force: true }); }

// send(event, data) writes an SSE event. Returns when the answer is complete.
export async function runChat({ ix, ops, conversationId, scope = 'corpus', bookmarkId, message, model }, send) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set on the server');
  const spec = MODELS.find(m => m.id === model) || MODELS[0];
  const record = scope === 'bookmark' ? ix.byId.get(String(bookmarkId)) : null;
  if (scope === 'bookmark' && !record) throw new Error('Unknown bookmark');
  const chat = (conversationId && await getChat(conversationId)) || {
    id: crypto.randomUUID(), scope, bookmarkId: record?.id || null,
    title: message.trim().replace(/\s+/g, ' ').slice(0, 80), createdAt: new Date().toISOString(), messages: []
  };
  send('meta', { conversationId: chat.id, model: spec.id });
  chat.messages.push({ role: 'user', content: message, at: new Date().toISOString() });

  const context = [{ role: 'system', content: await systemPrompt(ix, scope) }];
  if (record) {
    send('status', { text: 'Reading the bookmark' });
    context.push({ role: 'system', content: `The bookmark:\n\n${await fullRecord(ix, record)}` });
  }
  const history = chat.messages.slice(-16).map(m => ({ role: m.role, content: m.content }));
  // Seed retrieval so even tool-shy models have material for corpus questions.
  if (!record) {
    const prevUser = chat.messages.filter(m => m.role === 'user').slice(-2).map(m => m.content).join(' ');
    const hits = ix.search(prevUser, { limit: 8 });
    if (hits.length) context.push({ role: 'system', content: `Possibly relevant bookmarks (from a keyword search of the latest question; search further as needed):\n${JSON.stringify(hits.map(h => compact(ix, h.r)))}` });
  }
  const messages = [...context, ...history];
  const tools = ops.openaiTools();
  const actions = [];
  let answer = '', usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 }, usedModel = spec.id;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Free models are often overloaded; move to the next one if nothing has streamed yet.
    const candidates = [usedModel, ...(spec.fallbacks || []).filter(m => m !== usedModel)];
    let out;
    for (const [k, candidate] of candidates.entries()) {
      const body = { model: candidate, messages, temperature: 0.3, max_tokens: 2500 };
      if (round < MAX_TOOL_ROUNDS) body.tools = tools;
      let streamed = false;
      try { out = await streamCompletion(body, (t) => { streamed = true; answer += t; send('delta', { text: t }); }); usedModel = candidate; break; }
      catch (e) { if (streamed || k === candidates.length - 1) throw e; send('status', { text: 'Model busy, trying another' }); }
    }
    if (out.usage) { usage.prompt_tokens += out.usage.prompt_tokens || 0; usage.completion_tokens += out.usage.completion_tokens || 0; usage.cost += out.usage.cost || 0; }
    if (!out.calls.length) break;
    messages.push({ role: 'assistant', content: out.content || '', tool_calls: out.calls });
    for (const call of out.calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const name = call.function.name;
      send('status', { text: statusText(name, args) });
      let content;
      try {
        const { result, write, summary } = await ops.call(name, args);
        if (write && summary && !result?.needs_confirmation) { actions.push({ tool: name, summary }); send('action', { tool: name, summary }); }
        content = JSON.stringify(result);
      } catch (e) { content = JSON.stringify({ error: e.message }); }
      messages.push({ role: 'tool', tool_call_id: call.id, content: content.slice(0, 24000) });
    }
    if (answer && !/\n\n$/.test(answer)) { answer += '\n\n'; send('delta', { text: '\n\n' }); }
  }
  answer = answer.trim();
  const cited = [...new Set([...answer.matchAll(/\[\[([\w-]{6,})\]\]/g)].map(m => m[1]))].filter(id => ix.byId.has(id));
  chat.messages.push({ role: 'assistant', content: answer, model: usedModel, usage, cited, actions, at: new Date().toISOString() });
  chat.updatedAt = new Date().toISOString();
  await fs.mkdir(chatsDir, { recursive: true });
  await fs.writeFile(chatFile(chat.id), JSON.stringify(chat));
  send('done', { conversationId: chat.id, model: usedModel, usage, cited, mutated: actions.length > 0 });
}

function statusText(name, a) {
  return {
    search_bookmarks: `Searching${a.query ? ` “${a.query}”` : ''}${a.topic ? ` in ${a.topic}` : ''}`,
    read_bookmark: 'Reading a bookmark', get_overview: 'Looking at the library', list_concepts: 'Checking the taxonomy',
    list_skills: 'Checking skills', get_skill: `Loading skill ${a.name || ''}`, get_job: 'Checking the job',
    update_bookmark: 'Updating a bookmark', bulk_update_bookmarks: a.dry_run ? 'Previewing a bulk change' : 'Updating bookmarks',
    create_bookmark: 'Saving the page', delete_bookmark: 'Deleting a bookmark', create_concept: 'Adding a concept', update_concept: 'Editing a concept',
    delete_concept: 'Removing a concept', create_skill: 'Saving a skill', update_skill: 'Updating a skill', delete_skill: 'Deleting a skill',
    run_classification: 'Starting Jev classification', capture_threads: 'Queueing thread capture', rebuild_index: 'Rebuilding the index'
  }[name] || name;
}
