// Chat with Corpus: sessions, streaming answers, the Markdown they come in, and Ask AI beside a bookmark.
import { updateInboxCount } from '../app/router.js';
import { $, $$, copyText, esc } from '../core/dom.js';
import { prefs, savePrefs } from '../core/prefs.js';
import { store, ui } from '../core/state.js';
import { api, facetOf, label, loadAll, who } from '../data/library.js';
import { loadPad } from './scratchpad.js';
import { GRIP } from './sidebar.js';
import { avatarOf, snippet, topTags } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { loadChatList, renderAskSide } from '../views/ask.js';
import { inQueue } from '../views/dialog.js';
import { fitScratchpad, tagEditor } from '../views/post.js';
import { renderInbox } from '../views/reader/index.js';

export const sessions = new Map(); // key -> { key, scope, bookmarkId, conversationId, messages, streaming, status }
export const chatModels = () => store.status?.chat?.models || [];
const modelLabel = (id) => chatModels().find(m => m.id === id)?.label || (id || '').split('/').pop();
export function session(key, init) {
  if (!sessions.has(key)) sessions.set(key, { key, messages: [], conversationId: null, streaming: false, status: '', ...init });
  return sessions.get(key);
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}
// Small Markdown renderer. Input is escaped first; [[id]] becomes a numbered citation.
export function md(text, cites) {
  const out = [];
  const blocks = String(text).split(/```/);
  blocks.forEach((chunk, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(chunk.replace(/^\w*\n/, ''))}</code></pre>`); return; }
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para.length = 0; } };
    for (const raw of chunk.split('\n')) {
      let line = esc(raw).replace(/\[\[([\w-]{6,})\]\]/g, (m, id) => {
        const r = store.byId.get(id);
        if (!r) return '';
        if (!cites.includes(id)) cites.push(id);
        return `<button class="cite" data-open="${id}" title="${esc(`${who(r)} — ${(r.title || '').slice(0, 80)}`)}">${cites.indexOf(id) + 1}</button>`;
      });
      const h = line.match(/^(#{1,4})\s+(.*)/), li = line.match(/^\s*[-*•]\s+(.*)/), oli = line.match(/^\s*\d+[.)]\s+(.*)/), q = line.match(/^&gt;\s?(.*)/);
      if (h) { flush(); close(); out.push(`<h4>${inline(h[2])}</h4>`); }
      else if (li || oli) { flush(); const tag = li ? 'ul' : 'ol'; if (list !== tag) { close(); out.push(`<${tag}>`); list = tag; } out.push(`<li>${inline((li || oli)[1])}</li>`); }
      else if (q) { flush(); close(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); }
      else if (!line.trim()) { flush(); close(); }
      else { close(); para.push(inline(line)); }
    }
    flush(); close();
  });
  return out.join('');
}
// Time a message was sent or its answer arrived: "14:32" today, "Sep 28, 14:32" before.
function msgTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), today = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const text = today ? t : `${d.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}, ${t}`;
  return `<time datetime="${esc(iso)}" title="${esc(d.toLocaleString('en', { dateStyle: 'full', timeStyle: 'medium' }))}">${text}</time>`;
}
function msgTools(m, i, s) {
  if (s?.streaming || m.streaming) return '';
  const b = (act, l) => `<button type="button" data-msg-act="${act}" data-i="${i}">${l}</button>`;
  return `<span class="msg-tools">${m.content ? b('copy', 'Copy') : ''}${m.role === 'user' ? b('edit', 'Edit') : ''}${b('retry', 'Retry')}</span>`;
}
function messageHtml(m, i, s) {
  if (m.role === 'user') {
    if (s?.editing === i) return `<div class="msg user editing"><form class="msg-edit" data-msg-edit="${i}"><textarea rows="2" aria-label="Edit message">${esc(m.content)}</textarea><div class="msg-edit-bar"><button type="button" class="ghost small" data-msg-act="cancel-edit">Cancel <kbd>esc</kbd></button><button class="primary" type="submit">Send <kbd>enter</kbd></button></div></form></div>`;
    return `<div class="msg user"><div class="msg-body">${esc(m.content).replace(/\n/g, '<br>')}</div><div class="msg-meta">${msgTools(m, i, s)}${msgTime(m.at)}</div></div>`;
  }
  const cites = [];
  const body = m.content ? md(m.content, cites) : '';
  const sources = cites.map(id => store.byId.get(id)).filter(Boolean);
  const meta = m.error ? `<span class="warn">${esc(m.error)}</span>` : m.streaming ? `<span class="thinking">${esc(m.status || 'Thinking')}</span>` : [msgTime(m.at), modelLabel(m.model), m.usage?.cost ? `$${m.usage.cost < 0.001 ? m.usage.cost.toFixed(5) : m.usage.cost.toFixed(4)}` : m.model?.endsWith(':free') ? 'free' : ''].filter(Boolean).join(' · ');
  return `<div class="msg assistant ${m.streaming ? 'streaming' : ''}"><div class="msg-body">${body}</div>
    ${sources.length ? `<div class="msg-sources">${sources.map((r, i) => `<button data-open="${r.id}"><span class="n">${i + 1}</span>${avatarOf(r)}<span class="s-title">${esc((r.title || snippet(r, 80)).slice(0, 90))}</span><span class="muted">${esc(who(r))}</span></button>`).join('')}</div>` : ''}
    ${m.actions?.length ? `<ul class="msg-actions">${m.actions.map(a => `<li>${esc(a.summary)}</li>`).join('')}</ul>` : ''}
    <div class="msg-meta">${m.error ? `${msgTime(m.at)}${meta}` : `<span>${meta}</span>`}${msgTools(m, i, s)}</div></div>`;
}
function chatSuggestions(s) {
  if (s.scope === 'bookmark') return ['Summarize this', 'What are the key ideas, step by step?', 'How could I apply this?', 'What else have I saved like this?'];
  const counts = new Map();
  for (const r of store.records) for (const t of topTags(r, 2)) if (facetOf(t.id) === 'topic') counts.set(t.id, (counts.get(t.id) || 0) + 1);
  const [a, b] = [...counts].sort((x, y) => y[1] - x[1]).map(([id]) => label(id));
  return [`What have I saved about ${a || 'AI'}?`, 'Which threads from the last two weeks are worth reading first?', `What do the people I save say about ${b || 'design'}?`, 'Which tools keep coming up in my bookmarks?'];
}
export function chatHtml(s) {
  const models = chatModels();
  const current = prefs.chatModel && models.some(m => m.id === prefs.chatModel) ? prefs.chatModel : models[0]?.id;
  const empty = !s.messages.length;
  return `<div class="chat ${empty ? 'is-empty' : ''}" data-chat="${esc(s.key)}">
    <div class="chat-log">${empty ? `<div class="chat-empty"><span class="kicker">${s.scope === 'bookmark' ? 'Ask about this bookmark' : 'Ask your corpus'}</span>${chatSuggestions(s).map(q => `<button class="suggestion" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : s.messages.map((m, i) => messageHtml(m, i, s)).join('')}</div>
    <form class="composer" data-composer="${esc(s.key)}">
      <textarea rows="1" placeholder="${s.scope === 'bookmark' ? 'Ask about this…' : 'Ask anything about what you’ve saved…'}" ${store.status?.chat?.available ? '' : 'disabled'}></textarea>
      <div class="composer-bar">
        <select class="chat-model" aria-label="Model">${models.map(m => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.label)} · ${esc(m.note)}</option>`).join('')}</select>
        ${s.messages.length ? '<button type="button" class="ghost small" data-chat-reset>New</button>' : ''}
        <button class="primary send" type="submit" ${s.streaming ? 'disabled' : ''}>Send <kbd>enter</kbd></button>
      </div>
    </form></div>`;
}
export function paintChat(s, { full = false } = {}) {
  for (const el of $$(`[data-chat="${CSS.escape(s.key)}"]`)) {
    if (full || !el.querySelector('.msg.streaming')) { const draft = el.querySelector('.composer textarea')?.value || ''; el.outerHTML = chatHtml(s); const n = $(`[data-chat="${CSS.escape(s.key)}"] .composer textarea`); if (n) n.value = draft; }
    else { el.querySelector('.msg.streaming').outerHTML = messageHtml(s.messages.at(-1), s.messages.length - 1, s); }
    const log = $(`[data-chat="${CSS.escape(s.key)}"] .chat-log`);
    const scroller = log?.closest('.reader-sheet') || log;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}
// Messages the server hasn't stored (a request that failed before it started, or a failed answer)
// are marked unsaved, so this count matches the server's copy of the conversation.
const savedBefore = (s, i) => s.messages.slice(0, i).filter(m => !m.unsaved).length;
// from: resend from this message index, dropping it and everything after (retry / edit).
export async function sendChat(s, text, { from } = {}) {
  text = text.trim();
  if (!text || s.streaming) return;
  const model = $(`[data-chat="${CSS.escape(s.key)}"] .chat-model`)?.value || chatModels()[0]?.id;
  savePrefs({ chatModel: model });
  let truncate = s.pendingTruncate;
  if (from != null) { truncate = savedBefore(s, from); s.messages = s.messages.slice(0, from); }
  s.editing = null;
  const userMsg = { role: 'user', content: text, at: new Date().toISOString() };
  s.messages.push(userMsg);
  const msg = { role: 'assistant', content: '', streaming: true, status: 'Thinking', model };
  s.messages.push(msg);
  s.streaming = true;
  paintChat(s, { full: true });
  let raf = 0, mutated = false, started = false;
  const repaint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintChat(s); }); };
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: s.scope, bookmarkId: s.bookmarkId, conversationId: s.conversationId, message: text, model, truncate }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] || '{}');
        if (event === 'meta') { s.conversationId = data.conversationId; started = true; s.pendingTruncate = undefined; }
        else if (event === 'status') { msg.status = data.text; repaint(); }
        else if (event === 'delta') { msg.content += data.text; msg.status = 'Writing'; repaint(); }
        else if (event === 'action') { (msg.actions ||= []).push(data); repaint(); }
        else if (event === 'done') { msg.model = data.model; msg.usage = data.usage; mutated = data.mutated; }
        else if (event === 'error') throw new Error(data.message);
      }
    }
  } catch (e) {
    msg.error = e.message; msg.unsaved = true;
    // Never reached the server: it still has the old history, so the next send re-applies the cut.
    if (!started) { userMsg.unsaved = true; if (truncate != null) s.pendingTruncate = truncate; }
  }
  msg.at = new Date().toISOString();
  msg.streaming = false; s.streaming = false;
  if (mutated) { await loadAll(); updateInboxCount(); for (const id of new Set([ui.readerId, s.bookmarkId])) { const r = id && store.byId.get(id); if (!r) continue; for (const box of $$(`[data-tags="${id}"]`)) box.innerHTML = tagEditor(r); for (const ta of $$(`[data-scratchpad="${id}"]`)) if (document.activeElement !== ta) { ta.value = store.overrides[id]?.scratchpad || ''; fitScratchpad(ta); } } if (ui.inboxPad) loadPad(); toast('Library updated'); }
  paintChat(s, { full: true });
  if (s.scope === 'corpus' && ui.view === 'ask') { loadChatList().then(renderAskSide); if (location.pathname !== `/ask/${s.conversationId}`) history.replaceState({}, '', `/ask/${s.conversationId}`); }
}
export async function messageAction(s, act, i) {
  if (!s || s.streaming) return;
  const m = s.messages[i];
  if (act === 'cancel-edit') { s.editing = null; paintChat(s, { full: true }); return; }
  if (!m) return;
  if (act === 'copy') return copyText(m.content);
  if (act === 'edit') {
    s.editing = i; paintChat(s, { full: true });
    const ta = $(`[data-chat="${CSS.escape(s.key)}"] .msg-edit textarea`);
    if (ta) { ta.style.height = `${Math.min(220, ta.scrollHeight)}px`; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.closest('.msg').scrollIntoView({ block: 'nearest' }); }
    return;
  }
  if (act === 'retry') {
    // Retrying an answer re-asks the question before it; retrying a question resends it.
    let j = i; while (j >= 0 && s.messages[j].role !== 'user') j--;
    if (j >= 0) await sendChat(s, s.messages[j].content, { from: j });
  }
}
export async function loadConversation(s, id) {
  const c = await api(`/api/chats/${id}`).catch(() => null);
  if (!c) return;
  s.conversationId = c.id;
  s.messages = c.messages.map(m => ({ role: m.role, content: m.content, model: m.model, usage: m.usage, actions: m.actions, at: m.at }));
}
// One running conversation per bookmark, shared by the reader's Chat tab and the inbox's Ask AI panel.
export async function bookmarkSession(id) {
  const s = session(`b:${id}`, { scope: 'bookmark', bookmarkId: id });
  s.loading ||= (async () => {
    const { chats } = await api(`/api/chats?bookmark=${id}`).catch(() => ({ chats: [] }));
    if (chats[0] && !s.messages.length) await loadConversation(s, chats[0].id);
  })();
  await s.loading;
  return s;
}
// Inbox Ask AI: a docked chat beside the post, with the current entry attached as context.
export function inboxChatHtml(r) {
  return `<section class="side-panel" data-panel="chat" aria-label="Ask AI">
    <div class="tc-head">
      ${GRIP}<span class="kicker">Ask AI</span>${ui.inboxPad ? '' : '<button class="ghost small side-add" data-inbox-pad title="Open the inbox scratchpad below">+ Scratchpad</button>'}
      <button class="x" data-inbox-ask-close aria-label="Close" title="Close (esc)">×</button>
    </div>
    <div class="tc-attached" title="This entry is attached to the conversation">${avatarOf(r)}<span class="tc-title">${esc((r.title || snippet(r, 80)).slice(0, 90))}</span><span class="muted">${esc(who(r))}</span></div>
    ${chatHtml(session(`b:${r.id}`, { scope: 'bookmark', bookmarkId: r.id }))}
  </section>`;
}
export async function loadInboxChat(id, { focus = false } = {}) {
  const s = await bookmarkSession(id);
  if (!inQueue() || ui.inboxId !== id || !ui.inboxChat) return;
  paintChat(s, { full: true });
  if (focus) $('.side-panel[data-panel="chat"] textarea')?.focus();
}
export function toggleInboxChat(open = !ui.inboxChat) {
  ui.inboxChat = open;
  renderInbox();
  if (open && ui.inboxId) loadInboxChat(ui.inboxId, { focus: true });
}
