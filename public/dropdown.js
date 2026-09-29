// Site-styled dropdowns. Every <select> is upgraded in place: the native element
// stays (hidden) as the source of truth, so forms, `.value` reads and `change`
// listeners keep working. Options can carry "Label · meta" text; the meta part is
// shown right-aligned. Long lists get a filter box.

const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';
const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5 9.5 3.5"/></svg>';
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parts(text) {
  const depth = (text.match(/^[   ]+/) || [''])[0].length;
  const clean = text.trim();
  const i = clean.indexOf(' · ');
  return { depth, label: i < 0 ? clean : clean.slice(0, i), meta: i < 0 ? '' : clean.slice(i + 3) };
}

let open = null; // { select, trigger, menu, items, active }

function syncTrigger(select) {
  const trigger = select._dd;
  if (!trigger) return;
  const opt = select.options[select.selectedIndex];
  const { label } = parts(opt?.textContent || '');
  trigger.querySelector('.dd-value').textContent = label;
  trigger.disabled = select.disabled;
}

function upgrade(select) {
  if (select._dd || select.multiple) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = `dd-trigger${select.classList.contains('field') ? ' dd-field' : ''}${select.classList.contains('chat-model') ? ' dd-quiet' : ''}`;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (select.getAttribute('aria-label')) trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
  trigger.innerHTML = `<span class="dd-value"></span>${CHEVRON}`;
  select.classList.add('dd-native');
  select.tabIndex = -1;
  select.after(trigger);
  select._dd = trigger;
  trigger._select = select;
  syncTrigger(select);
}

function place(menu, trigger) {
  const r = trigger.getBoundingClientRect();
  // Fit the content, at least as wide as the trigger, within the viewport.
  menu.style.minWidth = `${Math.min(Math.max(r.width, 180), window.innerWidth - 16)}px`;
  menu.style.maxWidth = `${Math.min(420, window.innerWidth - 16)}px`;
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
  const want = Math.min(menu.scrollHeight, 360);
  if (below < want && above > below) { menu.style.top = ''; menu.style.bottom = `${window.innerHeight - r.top + 6}px`; menu.style.maxHeight = `${Math.min(360, above)}px`; }
  else { menu.style.bottom = ''; menu.style.top = `${r.bottom + 6}px`; menu.style.maxHeight = `${Math.min(360, below)}px`; }
}

function renderItems(state, filter = '') {
  const q = filter.trim().toLowerCase();
  const opts = [...state.select.options].map((o, index) => ({ o, index, ...parts(o.textContent) })).filter(x => !q || x.label.toLowerCase().includes(q));
  state.visible = opts;
  state.list.innerHTML = opts.map((x, i) => `<button type="button" role="option" class="dd-item${x.index === state.select.selectedIndex ? ' selected' : ''}${x.o.disabled ? ' disabled' : ''}" data-dd-index="${x.index}" data-dd-i="${i}" style="--depth:${x.depth ? 1 : 0}" aria-selected="${x.index === state.select.selectedIndex}"><span class="dd-check">${CHECK}</span><span class="dd-label">${esc(x.label)}</span>${x.meta ? `<span class="dd-meta">${esc(x.meta)}</span>` : ''}</button>`).join('') || '<p class="dd-empty">No matches</p>';
  const sel = opts.findIndex(x => x.index === state.select.selectedIndex);
  setActive(state, q ? 0 : Math.max(0, sel));
}

function setActive(state, i) {
  const items = state.list.querySelectorAll('.dd-item');
  if (!items.length) return;
  state.active = (i + items.length) % items.length;
  items.forEach((el, k) => el.classList.toggle('active', k === state.active));
  items[state.active].scrollIntoView({ block: 'nearest' });
}

function openMenu(trigger) {
  if (open) closeMenu();
  const select = trigger._select;
  if (!select || select.disabled) return;
  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  menu.setAttribute('role', 'listbox');
  const searchable = select.options.length > 12;
  menu.innerHTML = `${searchable ? '<div class="dd-search"><input type="text" placeholder="Filter…" autocomplete="off" spellcheck="false"></div>' : ''}<div class="dd-list"></div>`;
  document.body.appendChild(menu);
  open = { select, trigger, menu, list: menu.querySelector('.dd-list'), active: 0, typed: '', typedAt: 0 };
  renderItems(open);
  trigger.setAttribute('aria-expanded', 'true');
  trigger.classList.add('open');
  place(menu, trigger);
  requestAnimationFrame(() => menu.classList.add('in'));
  const input = menu.querySelector('.dd-search input');
  if (input) { input.focus(); input.addEventListener('input', () => { renderItems(open, input.value); }); }
  else menu.querySelector('.dd-item.active')?.focus({ preventScroll: true });
}

function closeMenu({ focus = true } = {}) {
  if (!open) return;
  const { trigger, menu } = open;
  open = null;
  menu.remove();
  trigger.setAttribute('aria-expanded', 'false');
  trigger.classList.remove('open');
  if (focus) trigger.focus({ preventScroll: true });
}

function choose(index) {
  const { select } = open;
  const option = select.options[index];
  if (!option || option.disabled) return;
  const changed = select.selectedIndex !== index;
  select.selectedIndex = index;
  syncTrigger(select);
  closeMenu();
  if (changed) {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

document.addEventListener('click', (ev) => {
  const trigger = ev.target.closest('.dd-trigger');
  if (trigger) { ev.preventDefault(); ev.stopPropagation(); open?.trigger === trigger ? closeMenu() : openMenu(trigger); return; }
  const item = ev.target.closest('.dd-item');
  if (item && open) { ev.stopPropagation(); choose(Number(item.dataset.ddIndex)); return; }
  if (open && !ev.target.closest('.dd-menu')) closeMenu({ focus: false });
}, true);

// Capture phase so page-level shortcuts never see keys meant for the menu.
document.addEventListener('keydown', (ev) => {
  const trigger = ev.target.closest?.('.dd-trigger');
  if (!open) {
    if (trigger && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(ev.key)) { ev.preventDefault(); ev.stopPropagation(); openMenu(trigger); }
    return;
  }
  const inSearch = ev.target.matches?.('.dd-search input');
  const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
  if (ev.key === 'Escape') { stop(); closeMenu(); }
  else if (ev.key === 'ArrowDown') { stop(); setActive(open, open.active + 1); }
  else if (ev.key === 'ArrowUp') { stop(); setActive(open, open.active - 1); }
  else if (ev.key === 'Home' && !inSearch) { stop(); setActive(open, 0); }
  else if (ev.key === 'End' && !inSearch) { stop(); setActive(open, 1e6); }
  else if (ev.key === 'Enter' || (ev.key === ' ' && !inSearch)) { stop(); const el = open.list.querySelectorAll('.dd-item')[open.active]; if (el) choose(Number(el.dataset.ddIndex)); }
  else if (ev.key === 'Tab') closeMenu({ focus: false });
  else if (!inSearch && ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) {
    // Type-ahead: jump to the first option starting with what was typed.
    stop();
    open.typed = Date.now() - open.typedAt < 700 ? open.typed + ev.key.toLowerCase() : ev.key.toLowerCase();
    open.typedAt = Date.now();
    const i = open.visible.findIndex(x => x.label.toLowerCase().startsWith(open.typed));
    if (i >= 0) setActive(open, i);
  } else if (inSearch) ev.stopPropagation();
}, true);

document.addEventListener('mousemove', (ev) => {
  const item = ev.target.closest?.('.dd-item');
  if (item && open) setActive(open, Number(item.dataset.ddI));
});
window.addEventListener('resize', () => closeMenu({ focus: false }));
document.addEventListener('scroll', (ev) => { if (open && !open.menu.contains(ev.target)) closeMenu({ focus: false }); }, true);

// Upgrade selects as views render, and keep triggers in sync with programmatic changes.
const upgradeAll = (root) => root.querySelectorAll?.('select:not(.dd-native)').forEach(upgrade);
new MutationObserver((records) => {
  for (const rec of records) for (const n of rec.addedNodes) if (n.nodeType === 1) { if (n.matches('select')) upgrade(n); else upgradeAll(n); }
}).observe(document.body, { childList: true, subtree: true });
document.addEventListener('change', (ev) => { if (ev.target.matches?.('select.dd-native')) syncTrigger(ev.target); });
upgradeAll(document);

export { upgradeAll };
