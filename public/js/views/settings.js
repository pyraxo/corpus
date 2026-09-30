// Settings: appearance, library, sources, chat, shortcuts, skills, account.
import { KEYMAP, capsOf, keyHint } from '../app/keymap.js';
import { installRow } from '../app/pwa.js';
import { recordingKey } from '../app/shortcuts.js';
import { $, esc, num } from '../core/dom.js';
import { prefs } from '../core/prefs.js';
import { store, ui, view } from '../core/state.js';
import { KIND_NAME, api, isFile } from '../data/library.js';
import { SORTS } from '../data/query.js';
import { chatModels } from '../features/chat.js';
import { bytesFmt, relDate } from '../ui/format.js';
import { inboxBase } from './reader/queue.js';

const SETTINGS_SECTIONS = [
  ['appearance', 'Appearance'], ['library', 'Library & inbox'], ['sources', 'Sources & classification'],
  ['chat', 'Chat & models'], ['shortcuts', 'Shortcuts'], ['skills', 'Skills'], ['account', 'Account & integrations']
];
let cachedSkills = null;
export let keyTestResult = {}; // key name -> { ok, error } from the last test
export async function loadSkills() { cachedSkills = (await api('/api/skills').catch(() => ({ skills: [] }))).skills; }
function settingsSection() {
  const s = location.pathname.split('/')[2];
  return SETTINGS_SECTIONS.some(([id]) => id === s) ? s : 'appearance';
}
export function renderSettings() {
  const section = settingsSection();
  const s = store.status;
  const e = s?.enrichment;
  const enriched = store.records.filter(r => r.enrichment !== 'pending').length;
  const threads = store.records.filter(r => r.thread).length;
  const seg = (key, options) => `<div class="segmented">${options.map(([v, l]) => `<button data-pref="${key}" data-value="${v}" aria-pressed="${String(prefs[key]) === String(v)}">${l}</button>`).join('')}</div>`;
  const row = (title, desc, control) => `<div class="s-row"><div><strong>${title}</strong>${desc ? `<p>${desc}</p>` : ''}</div><div class="s-control">${control}</div></div>`;
  const toggle = (key, on, attr = 'data-pref-toggle') => `<button class="switch" ${attr}="${key}" role="switch" aria-checked="${on}"><span></span></button>`;
  const group = (title, rows) => `<section class="s-group">${title ? `<h4>${title}</h4>` : ''}${rows}</section>`;
  const backfillChip = (st) => {
    if (st?.backfill?.running) return '<span class="pill running">Running</span>';
    if (!st?.classifiers?.typesafe) return '<span class="pill">Off</span>';
    const pending = Math.max(0, store.records.length - (st?.build?.classified || 0));
    return pending > 0 ? `<span class="pill">${num.format(pending)} to classify</span>` : '<span class="pill ok">Up to date</span>';
  };
  const keyRow = (name, title, desc, status) => {
    const st = status?.[name] || { set: false, source: 'none', last4: null };
    const editing = ui.keyEdit === name;
    const result = keyTestResult[name];
    const control = editing
      ? `<form class="key-edit" data-key-form="${name}"><input class="field mono" type="password" name="value" placeholder="Paste new key" autocomplete="off" autofocus><button class="ghost small" type="submit">Save</button><button class="ghost small" type="button" data-key-cancel="${name}">Cancel</button></form>`
      : `<div class="key-edit"><span class="mono small">${st.set ? `•••• ${esc(st.last4)}${st.source === 'env' ? ' (.env)' : ''}` : 'Not set'}</span><button class="ghost small" data-key-edit="${name}">${st.set ? 'Change' : 'Set'}</button>${st.set ? `<button class="ghost small" data-key-test="${name}">Test</button>` : ''}${st.source === 'saved' ? `<button class="ghost small danger" data-key-clear="${name}">Clear</button>` : ''}</div>`;
    const msg = !editing && result ? `<p class="small ${result.ok ? '' : 'warn'}">${result.ok ? '✓ Key works' : esc(result.error)}</p>` : '';
    return row(title, desc + msg, control);
  };

  const bodies = {
    appearance: () => group('', `
      ${row('Theme', '', seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]))}
      ${row('Density', 'Comfortable gives each inbox entry three lines with room around them. Compact fits two lines per entry and tightens the library’s cards.', seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]))}
      ${row('Reader text', 'Size of text in the reader and chat answers.', seg('readerSize', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]))}
      ${row('Show sensitive media', 'Posts flagged as sensitive by X.', toggle('showSensitive', prefs.showSensitive))}`),
    library: () => group('Library', `
      ${row('Layout', 'How bookmarks are drawn in the library.', seg('layout', [['wall', 'Wall'], ['grid', 'Grid'], ['list', 'List']]))}
      ${row('Open bookmarks in', 'The reader keeps a list beside the post and your tags, scratchpad and actions below it, like the inbox. You go through the list you opened from. The dialog opens over the library instead.', seg('openIn', [['reader', 'Reader'], ['dialog', 'Dialog']]))}
      ${row('Default order', '', `<select id="settings-sort" aria-label="Default order">${SORTS.map(([v, l]) => `<option value="${v}" ${prefs.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}`) +
      group('Inbox', `
      ${row('Clear the backlog', 'Mark every untriaged bookmark older than 30 days as kept.', '<button class="ghost" data-backlog>Mark as kept</button>')}
      ${row('Untriaged', `${num.format(inboxBase().length)} bookmarks waiting. Sort and filter them from the Inbox.`, '<a class="ghost" href="/inbox" data-link>Open inbox</a>')}`),
    sources: () => group('Sources', `
      ${row('FieldTheory', `${esc(s?.source?.path || '—')}<br>Updated ${s?.source?.modifiedAt ? `${relDate(s.source.modifiedAt)} ago` : '—'} · Index built ${store.generatedAt ? `${relDate(store.generatedAt)} ago` : '—'} · ${num.format(store.records.length)} bookmarks`, '<button class="ghost" data-refresh>Rebuild now</button>')}
      ${row('Thread unrolling', e?.available ? `${num.format(enriched)} of ${num.format(store.records.length)} captured · ${num.format(threads)} threads unrolled${e.queued ? ` · ${num.format(e.queued)} queued` : ''}${e.yieldingTo ? ' · paused while the backfill script runs' : ''}${e.waitingUntil ? ` · rate-limited until ${new Date(e.waitingUntil).toLocaleTimeString()}` : ''}${e.lastError ? `<br><span class="warn">${esc(e.lastError)}</span>` : ''}` : 'X session cookies not found. Threads and articles can’t be expanded.', e?.available ? toggle('enrich', e.enabled, 'data-server-toggle') : '')}
      ${row('Local archive', `${s?.archive ? `${num.format(s.archive.saved)} images and avatars saved (${bytesFmt(s.archive.bytes)})${s.archive.queued ? ` · ${num.format(s.archive.queued)} downloading` : ''}${s.archive.gone ? ` · ${num.format(s.archive.gone)} were already gone from X` : ''}<br>` : ''}Local copies of every post’s images (video isn’t kept, only its poster frame), shown when X no longer serves them. FieldTheory keeps the post text; captured threads, articles and quoted posts are in <code>data/enrich/</code>.${s?.archive?.lastError && s.archive.retrying ? `<br><span class="warn">${esc(s.archive.lastError)}</span>` : ''}`, s?.archive ? toggle('archive', s.archive.enabled, 'data-server-toggle') : '')}
      ${row('Your files', `${num.format(store.records.filter(isFile).length)} files added: ${['image', 'pdf', 'epub', 'mobi', 'text'].map(k => [k, store.records.filter(r => r.doc?.kind === k).length]).filter(([, n]) => n).map(([k, n]) => `${num.format(n)} ${KIND_NAME[k]}`).join(', ') || 'none yet'}. Drop images, PDFs, EPUB or MOBI books, or text and Markdown files anywhere in Corpus, paste them, or use <strong>Add files</strong>. Jev tags each one and suggests new topics.`, '<button class="ghost" data-add-files>Add files</button>')}
      ${row('Saved web pages', `${num.format(store.records.filter(r => r.provider === 'web').length)} pages saved by URL (via Ask or MCP <code>create_bookmark</code>).`, '')}`) +
      group('Classification', `
      ${keyRow('TYPESAFE_API_KEY', 'TypeSafe Jev key', 'Classifies bookmarks from full thread content.', s?.keys)}
      ${row('Status', `${num.format(s?.build?.classified || 0)} of ${num.format(store.records.length)} classified${s?.backfill?.running ? ` · ${num.format(s.backfill.pending)} threads left to capture` : ''}${!s?.classifiers?.typesafe ? ' · set a key above to enable' : ''}`, `<div class="key-edit">${backfillChip(s)}<button class="ghost small" data-backfill ${s?.backfill?.running || !s?.classifiers?.typesafe ? 'disabled' : ''}>${s?.backfill?.running ? 'Running…' : 'Reverify'}</button></div>`)}
      ${row('Keyword rules', 'Concept keywords from the taxonomy.', '<a class="ghost" href="/taxonomy" data-link>Open taxonomy</a>')}
      ${row('FieldTheory categories', 'Domains and categories from FieldTheory’s classifier.', '<span class="mono small">on</span>')}`),
    chat: () => group('OpenRouter', `
      ${keyRow('OPENROUTER_API_KEY', 'OpenRouter key', 'Powers Chat and Ask.', s?.keys)}
      ${row('Default model', 'Used when you don’t pick one in the message composer.', `<select id="settings-model" aria-label="Default model">${chatModels().map(m => `<option value="${esc(m.id)}" ${(prefs.chatModel || chatModels()[0]?.id) === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`)}
      ${row('Tools', 'The assistant can search and read bookmarks, tag and triage them, read and write scratchpads, see your highlights, save web pages, edit the taxonomy and skills, and run Jev. It asks before deleting or bulk changes.', '<a class="ghost" href="/ask" data-link>Open Ask</a>')}`) +
      group('Available models', `<p class="muted small" style="margin:0 0 4px">Turn models off to keep them out of the picker. At least one must stay on.</p>` +
      (s?.chat?.allModels || []).map(m => row(esc(m.label), esc(m.note), toggle(m.id, m.enabled, 'data-model-toggle'))).join('')),
    skills: () => skillsManager(),
    shortcuts: () => `<p class="s-lede">Click a shortcut to change it, then press the new keys. A letter followed quickly by another makes a two-key sequence, like <kbd>g</kbd><kbd>l</kbd>. Esc cancels.</p>` +
      [...new Set(KEYMAP.map(k => k[1]))].map(g => group(g, KEYMAP.filter(k => k[1] === g).map(([id, , l, def]) => {
        const custom = !!prefs.keys?.[id];
        const rec = recordingKey?.id === id;
        return row(esc(l), '', `<div class="key-edit">${rec ? `<span class="key-rec">${recordingKey.first ? capsOf(recordingKey.first) + ' …' : 'Press keys…'}</span>` : `<button class="key-btn" data-rec="${id}" title="Change">${keyHint(id)}</button>`}${custom && !rec ? `<button class="ghost small" data-key-reset="${id}" title="Default: ${esc(def.join(' / '))}">Reset</button>` : ''}</div>`);
      }).join(''))).join('') + group('', row('Reset all shortcuts', 'Restore every default.', `<button class="ghost" data-keys-reset ${prefs.keys && Object.keys(prefs.keys).length ? '' : 'disabled'}>Reset all</button>`)),
    account: () => group('This device', installRow(row)) +
      group('Access', row('Password', s?.passwordProtected ? 'Corpus is behind a password. Sessions last 30 days per device.' : 'Not protected. Set CORPUS_PASSWORD_HASH on the server.', s?.passwordProtected ? '<button class="ghost" data-logout>Sign out</button>' : '')) +
      group('Data', `
      ${row('Export', 'Bookmarks with your tags, scratchpads, highlights and triage state, plus the inbox scratchpad.', '<button class="ghost" data-export>Download JSON</button>')}
      ${row('Reset this device', 'Clears layout and appearance preferences here. Your tags, scratchpads and highlights are kept.', '<button class="ghost danger" data-reset-prefs>Reset</button>')}`) +
      group('Agents & MCP', `
      ${row('Connect an agent', 'Paste this prompt into Claude Code, Hermes, Cursor, Codex or any MCP-capable agent. It includes your URL and token, and points the agent to <a href="/connect.md" target="_blank">/connect.md</a> for setup.', `<button class="primary" data-copy-mcp="prompt">Copy setup prompt</button>`)}
      ${row('MCP endpoint', 'Streamable HTTP. Every Corpus capability as tools; skills as prompts.', `<button class="ghost" data-copy-mcp="url">Copy URL</button>`)}
      ${row('Token', 'Sent as <code>Authorization: Bearer …</code>. Stored on the server as CORPUS_MCP_TOKEN.', `<button class="ghost" data-copy-mcp="token">Copy token</button>`)}`)
  };
  const title = SETTINGS_SECTIONS.find(([id]) => id === section)[1];
  view().className = 'view settings';
  view().innerHTML = `
    <div class="page-head"><h1 class="serif">Settings</h1></div>
    <div class="s-layout">
    <aside class="s-nav" aria-label="Settings sections">
      <nav>${SETTINGS_SECTIONS.map(([id, l]) => `<a href="/settings/${id}" data-link aria-current="${id === section ? 'page' : 'false'}">${esc(l)}${id === 'skills' && cachedSkills ? `<span class="n">${cachedSkills.length}</span>` : ''}</a>`).join('')}</nav>
    </aside>
    <section class="s-main"><h2 class="s-title">${esc(title)}</h2>${bodies[section]()}</section>
    </div>`;
  // On phones the sections are a scrolling tab row: keep the current one in view.
  const nav = $('.s-nav nav'), cur = $('.s-nav a[aria-current="page"]');
  if (nav && cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
  if (section === 'skills' && !cachedSkills) loadSkills().then(() => { if (ui.view === 'settings' && settingsSection() === 'skills') renderSettings(); });
}
function skillsManager() {
  if (!cachedSkills) return '<p class="muted">Loading…</p>';
  const sel = ui.skillSel === '__new' ? { name: '', description: '', instructions: '', isNew: true } : cachedSkills.find(k => k.name === ui.skillSel) || null;
  return `<p class="s-lede">Skills are saved procedures the assistant follows on request — in Ask, and for any agent connected over MCP (they appear as prompts).</p>
  <div class="skills">
    <div class="skills-list">
      <button class="ghost skills-new" data-skill-new>New skill</button>
      ${cachedSkills.map(k => `<button class="skill-item ${k.name === ui.skillSel ? 'on' : ''}" data-skill="${esc(k.name)}"><span class="mono">${esc(k.name)}</span><span class="muted">${esc(k.description)}</span></button>`).join('') || '<p class="muted small">No skills yet.</p>'}
    </div>
    <div class="skill-detail">${sel ? `
      <form class="skill-form" data-skill-form="${esc(sel.name)}">
        <label>Name<input class="field" name="name" value="${esc(sel.name)}" ${sel.isNew ? 'required placeholder="e.g. monthly-review"' : 'readonly'}></label>
        <label>Description<input class="field" name="description" value="${esc(sel.description)}" required placeholder="One line: what it does and when to use it"></label>
        <label>Instructions<textarea class="field" name="instructions" rows="14" required placeholder="Step by step: which tools to use, what to produce, when to ask before changing things.">${esc(sel.instructions)}</textarea></label>
        <div class="t-form-actions">
          <button class="primary" type="submit">${sel.isNew ? 'Create skill' : 'Save'}</button>
          ${sel.isNew ? '<button class="ghost" type="button" data-skill-cancel>Cancel</button>' : `<button class="ghost" type="button" data-skill-run="${esc(sel.name)}">Run in Ask</button><button class="ghost danger" type="button" data-skill-delete="${esc(sel.name)}">Delete</button>`}
        </div>
        ${sel.updatedAt ? `<p class="muted small mono">Updated ${relDate(sel.updatedAt)} ago</p>` : ''}
      </form>` : '<div class="t-empty"><p class="muted">Select a skill to read or edit it, or create a new one. You can also ask the assistant to “save this as a skill”.</p></div>'}
    </div>
  </div>`;
}
export async function skillOp(tool, args) {
  const res = await fetch('/api/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json.result;
}
