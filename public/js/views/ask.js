// The Ask page: conversations over the whole library.
import { $, $$, esc } from '../core/dom.js';
import { store, ui, view } from '../core/state.js';
import { api } from '../data/library.js';
import { chatHtml, loadConversation, session, sessions } from '../features/chat.js';
import { relDate } from '../ui/format.js';

// Ask page: conversations over the whole corpus.
let chatList = [];
export async function loadChatList() { chatList = (await api(`/api/chats?scope=corpus${ui.askArchived ? '&archived=1' : ''}`).catch(() => ({ chats: [] }))).chats; }
export function renderAskSide() {
  const side = $('.ask-side ol');
  if (!side) return;
  const cur = sessions.get('corpus')?.conversationId;
  $$('.ask-tabs button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.askTab === 'archived') === ui.askArchived)));
  side.innerHTML = chatList.map(c => `<li class="${c.id === cur ? 'on' : ''}"><a href="/ask/${c.id}" data-link>${esc(c.title)}</a><span class="muted mono">${relDate(c.updatedAt)}</span><span class="li-actions"><button class="x" data-archive-chat="${c.id}" data-archive-to="${c.archived ? '0' : '1'}" aria-label="${c.archived ? 'Restore' : 'Archive'}" title="${c.archived ? 'Restore' : 'Archive'}">${c.archived ? '↩' : '⤓'}</button><button class="x" data-del-chat="${c.id}" aria-label="Delete" title="Delete">×</button></span></li>`).join('') || `<li class="muted small ask-empty">${ui.askArchived ? 'No archived conversations' : 'No conversations yet'}</li>`;
}
export async function renderAsk() {
  view().className = 'view ask';
  const id = location.pathname.split('/')[2] || null;
  const s = session('corpus', { scope: 'corpus' });
  if (id && s.conversationId !== id && !s.streaming) await loadConversation(s, id);
  if (!id && !s.streaming && s.conversationId) { s.conversationId = null; s.messages = []; }
  view().innerHTML = `<aside class="ask-side"><button class="ghost" data-new-chat>New chat</button><div class="segmented ask-tabs" role="tablist"><button data-ask-tab="chats" aria-pressed="${!ui.askArchived}">Chats</button><button data-ask-tab="archived" aria-pressed="${ui.askArchived}">Archived</button></div><ol></ol></aside><section class="ask-main">${store.status?.chat?.available ? '' : '<p class="warn small">Set OPENROUTER_API_KEY on the server to enable chat.</p>'}${chatHtml(s)}</section>`;
  renderAskSide();
  loadChatList().then(renderAskSide);
  $('.ask-main textarea')?.focus();
}
