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
// The ⓘ beside a setting's name: a button (focusable, tappable) whose explanation shows as a
// tooltip on hover or focus.
let hintN = 0;
function hint(title, help) {
  const id = `tip-${++hintN}`;
  return `<span class="s-hint"><button type="button" class="s-hint-btn" aria-label="About ${esc(String(title).replace(/<[^>]+>/g, ''))}" aria-describedby="${id}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 7.3v4M8 4.8v.2"/></svg></button><span class="s-tip" role="tooltip" id="${id}">${help}</span></span>`;
}

export function renderSettings() {
  const section = settingsSection();
  const s = store.status;
  const e = s?.enrichment;
  const enriched = store.records.filter(r => r.enrichment !== 'pending').length;
  const threads = store.records.filter(r => r.thread).length;
  const seg = (key, options) => `<div class="segmented">${options.map(([v, l]) => `<button data-pref="${key}" data-value="${v}" aria-pressed="${String(prefs[key]) === String(v)}">${l}</button>`).join('')}</div>`;
  // A row: its title with an ⓘ explaining it (help), a short line or live status (desc), and its control.
  const row = (title, desc, control, help = '') => `<div class="s-row"><div><div class="s-name"><strong>${title}</strong>${help ? hint(title, help) : ''}</div>${desc ? `<p>${desc}</p>` : ''}</div><div class="s-control">${control}</div></div>`;
  const toggle = (key, on, attr = 'data-pref-toggle') => `<button class="switch" ${attr}="${key}" role="switch" aria-checked="${on}"><span></span></button>`;
  const group = (title, rows) => `<section class="s-group">${title ? `<h4>${title}</h4>` : ''}${rows}</section>`;
  const backfillChip = (st) => {
    if (st?.backfill?.running) return '<span class="pill running">Running</span>';
    if (!st?.classifiers?.typesafe) return '<span class="pill">Off</span>';
    const pending = Math.max(0, store.records.length - (st?.build?.classified || 0));
    return pending > 0 ? `<span class="pill">${num.format(pending)} to classify</span>` : '<span class="pill ok">Up to date</span>';
  };
  const keyRow = (name, title, desc, status, help) => {
    const st = status?.[name] || { set: false, source: 'none', last4: null };
    const editing = ui.keyEdit === name;
    const result = keyTestResult[name];
    const control = editing
      ? `<form class="key-edit" data-key-form="${name}"><input class="field mono" type="password" name="value" placeholder="Paste new key" autocomplete="off" autofocus><button class="ghost small" type="submit">Save</button><button class="ghost small" type="button" data-key-cancel="${name}">Cancel</button></form>`
      : `<div class="key-edit"><span class="mono small">${st.set ? `•••• ${esc(st.last4)}${st.source === 'env' ? ' (.env)' : ''}` : 'Not set'}</span><button class="ghost small" data-key-edit="${name}">${st.set ? 'Change' : 'Set'}</button>${st.set ? `<button class="ghost small" data-key-test="${name}">Test</button>` : ''}${st.source === 'saved' ? `<button class="ghost small danger" data-key-clear="${name}">Clear</button>` : ''}</div>`;
    const msg = !editing && result ? `<p class="small ${result.ok ? '' : 'warn'}">${result.ok ? '✓ Key works' : esc(result.error)}</p>` : '';
    return row(title, desc + msg, control, help);
  };

  const bodies = {
    appearance: () => group('', `
      ${row('Theme', '', seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]))}
      ${row('Density', 'Space around cards and inbox entries.', seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]), 'Comfortable gives each inbox entry three lines with room around them. Compact fits two lines per entry and tightens the library’s cards.')}
      ${row('Reader text', 'Text size for reading.', seg('readerSize', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]), 'For posts, articles and books in the reader, and for answers in chat.')}
      ${row('Show sensitive media', 'Posts X flags as sensitive.', toggle('showSensitive', prefs.showSensitive), 'When off, the images and video in those posts are hidden; their text still shows.')}`),
    library: () => group('Library', `
      ${row('Layout', 'How the library is drawn.', seg('layout', [['wall', 'Wall'], ['grid', 'Grid'], ['list', 'List']]), 'Wall: columns of cards shaped by what’s in them. Grid: even cards. List: one row each, with a thumbnail. 1, 2 and 3 switch between them in the library.')}
      ${row('Open bookmarks in', 'The reader, or a dialog over the library.', seg('openIn', [['reader', 'Reader'], ['dialog', 'Dialog']]), 'The reader keeps a list beside the post and your tags, scratchpad and actions below it, like the inbox, and you go through the list you opened from. The dialog opens over the library instead.')}
      ${row('Default order', '', `<select id="settings-sort" aria-label="Default order">${SORTS.map(([v, l]) => `<option value="${v}" ${prefs.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}`) +
      group('Inbox', `
      ${row('Clear the backlog', 'Keep everything older than 30 days.', '<button class="ghost" data-backlog>Mark as kept</button>', 'Marks every untriaged bookmark older than 30 days as kept, so the inbox holds only recent ones. You can undo it right after.')}
      ${row('Untriaged', `${num.format(inboxBase().length)} bookmarks waiting.`, '<a class="ghost" href="/inbox" data-link>Open inbox</a>')}`),
    sources: () => group('Sources', `
      ${row('FieldTheory', `Updated ${s?.source?.modifiedAt ? `${relDate(s.source.modifiedAt)} ago` : '—'} · ${num.format(store.records.length)} bookmarks`, '<button class="ghost" data-refresh>Rebuild now</button>', `Corpus reads FieldTheory’s export at <code>${esc(s?.source?.path || '—')}</code> and never writes to it. It checks for changes daily; Rebuild now reads it again. The index was built ${store.generatedAt ? `${relDate(store.generatedAt)} ago` : '—'}.`)}
      ${row('Thread unrolling', e?.available ? `${num.format(enriched)} of ${num.format(store.records.length)} captured · ${num.format(threads)} threads${e.queued ? ` · ${num.format(e.queued)} queued` : ''}${e.yieldingTo ? ' · paused while the backfill runs' : ''}${e.waitingUntil ? ` · rate-limited until ${new Date(e.waitingUntil).toLocaleTimeString()}` : ''}${e.lastError ? `<br><span class="warn">${esc(e.lastError)}</span>` : ''}` : 'X session cookies not found.', e?.available ? toggle('enrich', e.enabled, 'data-server-toggle') : '', 'Fetches each bookmark’s whole thread, X article, link card and quoted post from X, within X’s rate limit, with the session FieldTheory uses. Opening an uncaptured bookmark moves it to the front. Off pauses it.')}
      ${row('Local archive', `${s?.archive ? `${num.format(s.archive.saved)} images saved (${bytesFmt(s.archive.bytes)})${s.archive.queued ? ` · ${num.format(s.archive.queued)} downloading` : ''}${s.archive.gone ? ` · ${num.format(s.archive.gone)} already gone from X` : ''}` : 'Local copies of post images.'}${s?.archive?.lastError && s.archive.retrying ? `<br><span class="warn">${esc(s.archive.lastError)}</span>` : ''}`, s?.archive ? toggle('archive', s.archive.enabled, 'data-server-toggle') : '', 'Keeps a copy of every post’s images, avatars and link-card images (video only as its poster frame), and of saved articles’ images, and shows it when the original is gone. FieldTheory keeps the post text; captured threads, articles and quoted posts are in <code>data/enrich/</code>.')}
      ${row('Your files', `${num.format(store.records.filter(isFile).length)} added${store.records.some(isFile) ? `: ${['image', 'pdf', 'epub', 'mobi', 'text'].map(k => [k, store.records.filter(r => r.doc?.kind === k).length]).filter(([, n]) => n).map(([k, n]) => `${num.format(n)} ${KIND_NAME[k]}`).join(', ')}` : ''}.`, '<button class="ghost" data-add-files>Add</button>', 'Images, PDFs, EPUB and MOBI books, text and Markdown. Drop or paste them anywhere, or use Add (Shift+A). Jev tags each one and suggests new topics.')}
      ${row('Saved web pages', `${num.format(store.records.filter(r => r.provider === 'web').length)} saved by link.`, '', 'From the Add dialog, Ask, or an agent (<code>create_bookmark</code>). Each page is read as an article: its title, author, date and text.')}`) +
      group('Classification', `
      ${keyRow('TYPESAFE_API_KEY', 'TypeSafe Jev key', 'Tags your bookmarks.', s?.keys, 'Jev reads each bookmark’s whole content (thread, article, file, image descriptions), picks its topics and kinds, and judges new topics to suggest. The key is kept on the server.')}
      ${row('Status', `${num.format(s?.build?.classified || 0)} of ${num.format(store.records.length)} classified${s?.backfill?.running ? ` · ${num.format(s.backfill.pending)} threads left to capture` : ''}${!s?.classifiers?.typesafe ? ' · set a key above to enable' : ''}`, `<div class="key-edit">${backfillChip(s)}<button class="ghost small" data-backfill ${s?.backfill?.running || !s?.classifiers?.typesafe ? 'disabled' : ''}>${s?.backfill?.running ? 'Running…' : 'Reverify'}</button></div>`, 'Reverify runs the backfill: it captures whatever is missing from X, then classifies anything new or changed since Jev last read it.')}
      ${row('Keyword rules', 'Keywords from the taxonomy.', '<a class="ghost" href="/taxonomy" data-link>Open taxonomy</a>', 'A bookmark that mentions a concept’s keywords gets that tag too, as a weaker signal than Jev’s reading. Edit the keywords in the taxonomy.')}
      ${row('FieldTheory categories', 'FieldTheory’s own categories.', '<span class="mono small">on</span>', 'Domains and categories from FieldTheory’s classifier, mapped onto your taxonomy as another weak signal.')}`),
    chat: () => group('OpenRouter', `
      ${keyRow('OPENROUTER_API_KEY', 'OpenRouter key', 'Powers Ask and chat.', s?.keys, 'It also describes images for Jev, which reads only text, and proposes new topics for files. The key is kept on the server.')}
      ${row('Default model', 'For new messages.', `<select id="settings-model" aria-label="Default model">${chatModels().map(m => `<option value="${esc(m.id)}" ${(prefs.chatModel || chatModels()[0]?.id) === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>`, 'Used when you don’t pick a model in the message box.')}
      ${row('Tools', 'What the assistant can do.', '<a class="ghost" href="/ask" data-link>Open Ask</a>', 'It can search and read bookmarks, books and PDFs, tag, triage and edit them, read and write scratchpads, see your highlights, save links, edit the taxonomy and skills, and run Jev. It asks before deleting or changing many at once.')}`) +
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
      group('Access', row('Password', s?.passwordProtected ? 'Signed in for 30 days per device.' : 'Not protected.', s?.passwordProtected ? '<button class="ghost" data-logout>Sign out</button>' : '', s?.passwordProtected ? 'The whole site is behind one password; only its hash is kept, on the server. Signing in lasts 30 days on each device.' : 'Set CORPUS_PASSWORD_HASH on the server to put Corpus behind a password.')) +
      group('Data', `
      ${row('Export', 'Everything, as one JSON file.', '<button class="ghost" data-export>Download JSON</button>', 'Bookmarks with your tags, scratchpads, highlights and notes, and triage state, plus the inbox scratchpad.')}
      ${row('Reset this device', 'Preferences on this device.', '<button class="ghost danger" data-reset-prefs>Reset</button>', 'Clears this device’s layout, appearance and shortcut preferences. Your tags, scratchpads and highlights are kept.')}`) +
      group('Agents & MCP', `
      ${row('Connect an agent', 'A setup prompt for any MCP agent.', `<button class="primary" data-copy-mcp="prompt">Copy setup prompt</button>`, 'Paste it into Claude Code, Hermes, Cursor, Codex or any agent that speaks MCP. It includes your URL and token, and points the agent to <a href="/connect.md" target="_blank">/connect.md</a> for the rest.')}
      ${row('MCP endpoint', 'Where agents connect.', `<button class="ghost" data-copy-mcp="url">Copy URL</button>`, 'Streamable HTTP. Everything Corpus can do, as tools; your skills, as prompts.')}
      ${row('Token', 'The agent’s password.', `<button class="ghost" data-copy-mcp="token">Copy token</button>`, 'Agents send it as <code>Authorization: Bearer …</code>. It’s set on the server as CORPUS_MCP_TOKEN.')}`)
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
