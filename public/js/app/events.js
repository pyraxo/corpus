// Clicks, form submits and inputs across the app, handled in one place per kind of event.
import { installApp } from './pwa.js';
import { navigate, updateInboxCount } from './router.js';
import { startRecording } from './shortcuts.js';
import { $, esc, num } from '../core/dom.js';
import { applyPrefs, defaults, prefStorage, prefs, savePrefs } from '../core/prefs.js';
import { PAGE, store, ui } from '../core/state.js';
import { saveOverride, setTags, undo } from '../data/history.js';
import { api, facetOf, isRead, loadAll, loadStatus, stackList, tagIds, tagsOf, triage } from '../data/library.js';
import { reshuffleRandomSort } from '../data/query.js';
import { messageAction, paintChat, sendChat, session, sessions, toggleInboxChat } from '../features/chat.js';
import { toggleRead, toggleStack } from '../features/marks.js';
import { pad } from '../features/scratchpad.js';
import { acceptSuggestion, createConcept, pickSuggestion, reloadTaxonomy, rerenderTags, suggestions } from '../features/tags.js';
import { openAddDialog } from '../views/add-dialog.js';
import { startEdit } from '../features/edit.js';
import { openShare } from '../features/share.js';
import { toast } from '../ui/toast.js';
import { loadChatList, renderAskSide } from '../views/ask.js';
import { closeReader, openBookmark, openReader, restoreReader, showReaderTab, stepReader, triageReader } from '../views/dialog.js';
import { renderHighlights } from '../views/highlights.js';
import { paintResults, renderLibrary, renderRail, setRail, syncUrl } from '../views/library.js';
import { fitScratchpad, repaintBookmark } from '../views/post.js';
import { inboxStep, paintDock, pickQueued, readTriage, renderInbox, setMode, triageCurrent } from '../views/reader/index.js';
import { keyTestResult, loadSkills, renderSettings, skillOp } from '../views/settings.js';
import { renderTaxonomy } from '../views/taxonomy.js';



// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupEvents() {
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button, a, [data-open], [data-pick], [data-concept], [data-close], [data-rail-close]');
    if (!t) return;
    const d = t.dataset;
    if (t.matches('a[data-link]')) { ev.preventDefault(); navigate(t.getAttribute('href')); return; }
    if (d.close !== undefined) { closeReader(); return; }
    if (d.rtab) { showReaderTab(d.rtab); return; }
    if (d.msgAct) { await messageAction(sessions.get(t.closest('[data-chat]').dataset.chat), d.msgAct, Number(d.i)); return; }
    if (d.ask) { const box = t.closest('[data-chat]'); await sendChat(sessions.get(box.dataset.chat), d.ask); return; }
    if (d.chatReset !== undefined) { const s = sessions.get(t.closest('[data-chat]').dataset.chat); s.messages = []; s.conversationId = null; s.editing = null; s.pendingTruncate = undefined; if (s.scope === 'corpus') navigate('/ask'); else paintChat(s, { full: true }); return; }
    if (d.newChat !== undefined) { const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } navigate('/ask'); return; }
    if (d.delChat) { ev.preventDefault(); if (!confirm('Delete this conversation? This can’t be undone.')) return; await api(`/api/chats/${d.delChat}`, { method: 'DELETE' }); if (sessions.get('corpus')?.conversationId === d.delChat) { navigate('/ask'); } else { await loadChatList(); renderAskSide(); } return; }
    if (d.archiveChat) { ev.preventDefault(); const archived = d.archiveTo === '1'; await api(`/api/chats/${d.archiveChat}`, { method: 'PUT', body: { archived } }); if (archived && sessions.get('corpus')?.conversationId === d.archiveChat) { navigate('/ask'); } else { await loadChatList(); renderAskSide(); } toast(archived ? 'Archived' : 'Restored'); return; }
    if (d.askTab) { const archived = d.askTab === 'archived'; if (archived === ui.askArchived) return; ui.askArchived = archived; await loadChatList(); renderAskSide(); return; }
    if (d.step) { stepReader(Number(d.step)); return; }
    if (d.untag) { const r = store.byId.get(t.closest('[data-tags]').dataset.tags); await setTags(r, { remove: [d.untag] }); rerenderTags(r); return; }
    if (t.closest('.suggest') && (d.sid || d.create)) { await pickSuggestion(t); return; }
    if (d.unstack) { await toggleStack(d.unstack); return; }
    if (d.open && !ev.target.closest('a[href]:not([data-open])')) {
      ev.preventDefault();
      // Citations in a chat open over it, so the conversation stays where it is.
      if (t.closest('.msg, .chat, .side-dock, .t-samples') && !t.closest('.stack')) { openReader(d.open, store.records.filter(r => r.id === d.open)); return; }
      if (t.closest('.stack')) openBookmark(d.open, stackList(), 'The stack');
      else openBookmark(d.open, ui.view === 'library' ? ui.results : undefined);
      return;
    }
    if (d.filter) { ui.filters.has(d.filter) ? ui.filters.delete(d.filter) : ui.filters.add(d.filter); ui.visible = PAGE; syncUrl(); renderLibrary(); return; }
    if (d.unfilter) { ui.filters.delete(d.unfilter); ui.visible = PAGE; syncUrl(); renderLibrary(); return; }
    if (d.caret) { ui.railOpen.has(d.caret) ? ui.railOpen.delete(d.caret) : ui.railOpen.add(d.caret); $('.rail').innerHTML = renderRail(); return; }
    if (d.status) { ui.status = d.status; ui.visible = PAGE; syncUrl(); renderLibrary(); return; }
    if (d.searchClear !== undefined) { ui.query = ''; $('#search').value = ''; ui.visible = PAGE; syncUrl(); renderLibrary(); $('#search').focus(); return; }
    if (d.clear !== undefined) { ui.filters.clear(); ui.query = ''; $('#search').value = ''; ui.status = 'active'; ui.visible = PAGE; syncUrl(); renderLibrary(); return; }
    if (d.rail !== undefined) { setRail(!ui.mobileRail); return; }
    if (d.railClose !== undefined) { setRail(false); return; }
    if (d.layout) { savePrefs({ layout: d.layout }); ui.visible = Math.max(PAGE, ui.visible); renderLibrary(); return; }
    if (d.inboxFormat) { savePrefs({ inboxFormat: d.inboxFormat }); ui.inboxId = null; renderInbox(); return; }
    if (d.inboxClear !== undefined) { savePrefs({ inboxFormat: 'all', inboxTopic: '', inboxWindow: 'all' }); ui.inboxId = null; updateInboxCount(); renderInbox(); return; }
    if (d.triage) { await triageCurrent(d.triage); return; }
    if (d.skip !== undefined) { const q = ui.inboxQueue; pickQueued(q[q.findIndex(r => r.id === ui.inboxId) + 1]?.id || q[0]?.id); return; }
    if (d.pick) { pickQueued(d.pick, { scroll: true }); return; }
    if (d.mode) { setMode(d.mode); return; }
    if (d.readStep) { inboxStep(Number(d.readStep)); return; }
    if (d.readTriage) { await readTriage(d.readTriage); return; }
    if (d.readRestore !== undefined) { await saveOverride([ui.inboxId], { deleted: null }, { label: 'Restore' }); updateInboxCount(); paintDock(); repaintBookmark(ui.inboxId); toast('Restored', { undo: true }); return; }
    if (d.readAll !== undefined) { const first = ui.results?.[0]; if (first) { const was = prefs.openIn; prefs.openIn = 'reader'; openBookmark(first.id, ui.results); prefs.openIn = was; } return; }
    if (d.addFiles !== undefined) { openAddDialog(); return; }
    if (d.shareOpen) { openShare(t, store.byId.get(d.shareOpen)); return; }
    if (d.editOpen) { startEdit(t.closest('.reader-body'), store.byId.get(d.editOpen)); return; }
    if (d.suggest) { await acceptSuggestion(t); return; }
    if (d.dismissSuggest) { const id = t.closest('[data-tags]')?.dataset.tags || ui.readerId; const o = store.overrides[id] || {}; await saveOverride([id], { dismissed: [...(o.dismissed || []), d.dismissSuggest] }, { label: 'Dismiss suggestion' }); rerenderTags(store.byId.get(id)); return; }
    if (d.inboxAsk !== undefined) { toggleInboxChat(); return; }
    if (d.inboxAskClose !== undefined) { toggleInboxChat(false); return; }
    if (d.facet) { ui.taxFacet = d.facet; ui.taxSelected = null; renderTaxonomy(); return; }
    if (d.concept) { ui.taxSelected = d.concept; renderTaxonomy(); return; }
    if (d.newConcept !== undefined) { ui.taxSelected = '__new'; renderTaxonomy(); $('.t-form input[name=label]')?.focus(); return; }
    if (d.cancelConcept !== undefined) { ui.taxSelected = null; renderTaxonomy(); return; }
    if (d.browse) { ui.filters = new Set([d.browse]); ui.query = ''; ui.status = 'active'; navigate(`/?t=${encodeURIComponent(d.browse)}`); return; }
    if (d.viewUntagged !== undefined) { ui.filters.clear(); ui.query = ''; navigate('/'); ui.results = ui.results.filter(r => !tagIds(r).some(id => facetOf(id) === 'topic')); paintResults(ui.results.slice(0, PAGE), true); $('.count').textContent = num.format(ui.results.length); return; }
    if (d.deleteConcept) {
      const c = store.conceptById.get(d.deleteConcept);
      if (!confirm(`${c.origin === 'user' ? 'Delete' : 'Retire'} “${c.label}”? Bookmarks keep their other tags.`)) return;
      await api('/api/taxonomy', { method: 'PUT', body: { id: c.id, patch: null } });
      await reloadTaxonomy(); ui.taxSelected = null; renderTaxonomy(); toast('Concept removed');
      return;
    }
    if (d.pref) { savePrefs({ [d.pref]: d.value }); renderSettings(); if (d.pref === 'inboxWindow') updateInboxCount(); return; }
    if (d.prefToggle) { savePrefs({ [d.prefToggle]: !prefs[d.prefToggle] }); renderSettings(); return; }
    if (d.serverToggle) { const on = t.getAttribute('aria-checked') !== 'true'; await api('/api/settings', { method: 'PUT', body: { [d.serverToggle]: on } }).catch(e => toast(e.message)); await loadStatus(); renderSettings(); return; }
    if (d.refresh !== undefined) { t.disabled = true; t.textContent = 'Rebuilding…'; try { await api('/api/refresh', { method: 'POST' }); await loadAll(); await loadStatus(); updateInboxCount(); toast(`Rebuilt · ${num.format(store.records.length)} bookmarks`); } catch (e) { toast(e.message); } renderSettings(); return; }
    if (d.backfill !== undefined) { t.disabled = true; t.textContent = 'Starting…'; try { await api('/api/backfill', { method: 'POST' }); await loadStatus(); toast('Backfill started'); } catch (e) { toast(e.message); } renderSettings(); return; }
    if (d.backlog !== undefined) {
      const cutoff = Date.now() - 30 * 864e5;
      const ids = store.records.filter(r => !triage(r) && new Date(r.postedAt) < cutoff).map(r => r.id);
      if (!ids.length || !confirm(`Mark ${num.format(ids.length)} bookmarks as kept?`)) return;
      await saveOverride(ids, { triaged: 'kept' }, { label: `Keep ${num.format(ids.length)} bookmarks` }); updateInboxCount(); toast(`${num.format(ids.length)} marked as kept`, { undo: true }); return;
    }
    if (d.export !== undefined) {
      const out = store.records.map(r => ({ ...r, tags: tagsOf(r), scratchpad: store.overrides[r.id]?.scratchpad || null, highlights: (store.overrides[r.id]?.highlights || []).map(h => ({ text: h.quote || h.text, at: h.at })), triaged: triage(r), read: isRead(r), readAt: isRead(r) ? store.overrides[r.id].readAt : null }));
      const pad = await api('/api/scratchpad').catch(() => null);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), taxonomy: store.concepts, scratchpad: pad?.text || '', records: out })], { type: 'application/json' })), download: `corpus-${new Date().toISOString().slice(0, 10)}.json` });
      a.click(); URL.revokeObjectURL(a.href); return;
    }
    if (d.copyMcp) {
      const info = await api('/api/mcp');
      const origin = info.url.replace(/\/mcp$/, '');
      const text = { prompt: `Connect yourself to my Corpus bookmark library over MCP. Fetch and follow the instructions at ${origin}/connect.md.\n\nURL: ${info.url}\nToken: ${info.token}`, url: info.url, token: info.token, claude: `claude mcp add --transport http corpus ${info.url} --header "Authorization: Bearer ${info.token}"`, hermes: `mcp_servers:\n  corpus:\n    url: "${info.url}"\n    headers:\n      Authorization: "Bearer ${info.token}"\n` }[d.copyMcp];
      await navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast(text));
      return;
    }
    if (d.install !== undefined) { await installApp(); return; }
    if (d.rec) { startRecording(d.rec); return; }
    if (d.keyReset) { const k = { ...(prefs.keys || {}) }; delete k[d.keyReset]; savePrefs({ keys: k }); renderSettings(); return; }
    if (d.keysReset !== undefined) { savePrefs({ keys: {} }); renderSettings(); toast('Shortcuts reset'); return; }
    if (d.keyEdit) { ui.keyEdit = d.keyEdit; delete keyTestResult[d.keyEdit]; renderSettings(); return; }
    if (d.keyCancel) { ui.keyEdit = null; renderSettings(); return; }
    if (d.keyClear) { if (!confirm('Clear this key? Chat or classification will stop working unless it’s also set in the server .env.')) return; try { await api('/api/keys', { method: 'PUT', body: { name: d.keyClear, value: '' } }); await loadStatus(); toast('Key cleared'); } catch (e) { toast(e.message); } renderSettings(); return; }
    if (d.keyTest) { const name = d.keyTest; t.disabled = true; t.textContent = 'Testing…'; try { keyTestResult[name] = { ok: true, ...(await api('/api/keys/test', { method: 'POST', body: { name } })) }; } catch (e) { keyTestResult[name] = { ok: false, error: e.message }; } renderSettings(); return; }
    if (d.modelToggle) {
      const id = d.modelToggle;
      const disabled = new Set(store.settings.disabledModels || []);
      disabled.has(id) ? disabled.delete(id) : disabled.add(id);
      try { await api('/api/settings', { method: 'PUT', body: { disabledModels: [...disabled] } }); store.settings.disabledModels = [...disabled]; await loadStatus(); } catch (e) { toast(e.message); }
      renderSettings(); return;
    }
    if (d.act) { if (d.act === 'restore') await restoreReader(); else await triageReader(d.act); return; }
    if (d.stack) { await toggleStack(d.stack); return; }
    if (d.markRead) { await toggleRead(d.markRead); return; }
    if (d.undo !== undefined) { await undo(); return; }
    if (d.toastAct !== undefined) { const run = $('#toast')._act; $('#toast').hidden = true; run?.(); return; }
    if (d.mobileSearch !== undefined) { if (ui.view !== 'library') navigate('/'); $('#search').focus(); $('#search').select(); return; }
    if (d.skill) { ui.skillSel = d.skill; renderSettings(); return; }
    if (d.skillNew !== undefined) { ui.skillSel = '__new'; renderSettings(); $('.skill-form input[name=name]')?.focus(); return; }
    if (d.skillCancel !== undefined) { ui.skillSel = null; renderSettings(); return; }
    if (d.skillDelete) { if (!confirm(`Delete the skill “${d.skillDelete}”?`)) return; try { await skillOp('delete_skill', { name: d.skillDelete, confirm: true }); await loadSkills(); ui.skillSel = null; renderSettings(); toast('Skill deleted'); } catch (e) { toast(e.message); } return; }
    if (d.skillRun) { const s = session('corpus', { scope: 'corpus' }); if (!s.streaming) { s.messages = []; s.conversationId = null; } navigate('/ask'); await sendChat(s, `Run the skill "${d.skillRun}".`); return; }
    if (d.logout !== undefined) { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; return; }
    if (d.resetPrefs !== undefined) { prefStorage.removeItem('corpus.prefs'); Object.assign(prefs, defaults); applyPrefs(); renderSettings(); toast('Preferences reset'); }
  });
  document.addEventListener('submit', async (ev) => {
    const editForm = ev.target.closest('[data-msg-edit]');
    if (editForm) { ev.preventDefault(); const text = $('textarea', editForm).value; if (text.trim()) await sendChat(sessions.get(editForm.closest('[data-chat]').dataset.chat), text, { from: Number(editForm.dataset.msgEdit) }); return; }
    const skillForm = ev.target.closest('[data-skill-form]');
    if (skillForm) {
      ev.preventDefault();
      const fd = new FormData(skillForm);
      const isNew = skillForm.dataset.skillForm === '';
      try {
        const res = await skillOp(isNew ? 'create_skill' : 'update_skill', { name: String(fd.get('name')), description: String(fd.get('description')).trim(), instructions: String(fd.get('instructions')).trim() });
        await loadSkills(); ui.skillSel = res.name; renderSettings(); toast(isNew ? 'Skill created' : 'Skill saved');
      } catch (e) { toast(e.message); }
      return;
    }
    const keyForm = ev.target.closest('[data-key-form]');
    if (keyForm) {
      ev.preventDefault();
      const name = keyForm.dataset.keyForm;
      const value = String(new FormData(keyForm).get('value') || '').trim();
      if (!value) return;
      try { await api('/api/keys', { method: 'PUT', body: { name, value } }); ui.keyEdit = null; delete keyTestResult[name]; await loadStatus(); toast('Key saved'); } catch (e) { toast(e.message); }
      renderSettings();
      return;
    }
    const composer = ev.target.closest('[data-composer]');
    if (composer) { ev.preventDefault(); const ta = $('textarea', composer); const text = ta.value; ta.value = ''; await sendChat(sessions.get(composer.dataset.composer), text); return; }
    const form = ev.target.closest('[data-concept-form]');
    if (!form) return;
    ev.preventDefault();
    const fd = new FormData(form);
    const aliases = String(fd.get('aliases') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const parent = fd.get('parent') || null;
    try {
      if (form.dataset.conceptForm === '') {
        const id = await createConcept({ facet: fd.get('facet') || ui.taxFacet, labelText: String(fd.get('label')), parent, aliases });
        await reloadTaxonomy(); ui.taxSelected = id;
      } else {
        await api('/api/taxonomy', { method: 'PUT', body: { id: form.dataset.conceptForm, patch: { label: String(fd.get('label')).trim(), parent, aliases } } });
        await reloadTaxonomy();
      }
      renderTaxonomy(); toast('Saved · bookmarks re-tagged');
    } catch (e) { toast(e.message); }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.id === 'search') {
      ui.query = t.value; ui.visible = PAGE;
      clearTimeout(t._h); t._h = setTimeout(() => { if (ui.view !== 'library') navigate('/'); else { renderLibrary(); syncUrl(); } }, 140);
      return;
    }
    if (t.id === 'hl-search') { ui.hlQuery = t.value; clearTimeout(t._h); t._h = setTimeout(() => { const pos = t.selectionStart; renderHighlights(); const n = $('#hl-search'); n.focus(); n.setSelectionRange(pos, pos); }, 120); return; }
    if (t.id === 'tax-search') { ui.taxQuery = t.value; clearTimeout(t._h); t._h = setTimeout(() => { const pos = t.selectionStart; renderTaxonomy(); const n = $('#tax-search'); n.focus(); n.setSelectionRange(pos, pos); }, 120); return; }
    if (t.matches('[data-tag-input]')) {
      const box = t.closest('[data-tags]'); const r = store.byId.get(box.dataset.tags);
      const list = $('.suggest', box); const items = suggestions(t.value, r);
      list.innerHTML = items.map((s, i) => `<button type="button" class="${i === 0 ? 'hi' : ''}" ${s.id ? `data-sid="${esc(s.id)}"` : `data-create="${s.create}"`}><span>${esc(s.text)}</span>${s.facet ? `<span class="muted mono">${s.facet}</span>` : ''}</button>`).join('');
      list.hidden = !items.length || !t.value.trim();
      // On phones the docked tag row scrolls sideways, so its menu is fixed and opens upward from the input.
      if (!list.hidden && t.closest('.triage-dock') && getComputedStyle(list).position === 'fixed') list.style.bottom = `${innerHeight - t.getBoundingClientRect().top + 6}px`;
      return;
    }
    if (t.matches('textarea[data-scratchpad]')) { fitScratchpad(t); return; }
    if (t.matches('.composer textarea, .msg-edit textarea')) { t.style.height = 'auto'; t.style.height = `${Math.min(220, t.scrollHeight)}px`; }
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'settings-sort') { if (ev.target.value === 'random') reshuffleRandomSort(); savePrefs({ sort: ev.target.value }); toast('Default order saved'); return; }
    if (ev.target.id === 'settings-model') { savePrefs({ chatModel: ev.target.value }); toast('Default model saved'); return; }
    const inboxPref = { 'inbox-sort': 'inboxSort', 'inbox-window': 'inboxWindow', 'inbox-topic': 'inboxTopic' }[ev.target.id];
    if (inboxPref) { if (ev.target.id === 'inbox-sort' && ev.target.value === 'random') reshuffleRandomSort(); savePrefs({ [inboxPref]: ev.target.value }); ui.inboxId = null; updateInboxCount(); renderInbox(); return; }
    if (ev.target.id === 'sort') { if (ev.target.value === 'random') reshuffleRandomSort(); savePrefs({ sort: ev.target.value }); ui.visible = PAGE; renderLibrary(); }
    if (ev.target.matches('[data-scratchpad]')) saveOverride([ev.target.dataset.scratchpad], { scratchpad: ev.target.value.trim() || null }, { label: 'Edit scratchpad' });
  });
  // Clicking a suggestion shouldn't take focus from the tag box, so typing and Enter carry on there.
  document.addEventListener('pointerdown', (ev) => { if (ev.target.closest('.suggest button')) ev.preventDefault(); });
  document.addEventListener('focusin', (ev) => {
    if (ev.target.matches('[data-tag-input]')) ev.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.addEventListener('focusout', (ev) => {
    if (ev.target.matches('[data-tag-input]')) setTimeout(() => { const s = ev.target.closest('.tag-add')?.querySelector('.suggest'); if (s && !s.contains(document.activeElement)) s.hidden = true; }, 150);
  });
}
