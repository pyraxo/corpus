// The reader's sidebar: Ask AI and the scratchpad, swapped, split and widened by dragging.
import { paneEdge } from '../ui/panes.js';
import { $, $$ } from '../core/dom.js';
import { prefs, savePrefs } from '../core/prefs.js';
import { ui } from '../core/state.js';
import { inboxChatHtml } from './chat.js';
import { inboxPadHtml } from './scratchpad.js';

// Drag a panel by its header to swap top and bottom, drag the bar between them to share
// the height, and drag the sidebar's left edge to widen it. Layout is kept per device.
const sideOrder = () => (prefs.sidePanels?.length === 2 ? prefs.sidePanels : ['chat', 'pad']);
const clampSplit = (v) => Math.min(0.85, Math.max(0.15, Number(v) || 0.5));
export function sideDock(current) {
  const panels = sideOrder().filter(p => p === 'chat' ? ui.inboxChat && current : ui.inboxPad);
  if (!panels.length) return '';
  const html = { chat: () => inboxChatHtml(current), pad: () => inboxPadHtml({ canAsk: !!current }) };
  const style = `--split:${clampSplit(prefs.sideSplit)}`;
  return `<aside class="triage-chat side-dock ${panels.length > 1 ? 'both' : ''}" style="${style}" aria-label="Sidebar">
    ${paneEdge('side', 'the sidebar')}
    ${panels.map(p => html[p]()).join('<div class="side-split" data-side-split role="separator" aria-orientation="horizontal" title="Drag to resize · double-click to share evenly"></div>')}
  </aside>`;
}
export const GRIP = '<span class="grip" aria-hidden="true"><svg viewBox="0 0 8 12"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg></span>';
// Follow one pointer until it's released; returns the element that captured it.
function dragWith(ev, el, move, done) {
  ev.preventDefault();
  el.setPointerCapture?.(ev.pointerId);
  const up = (e) => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); done(e); };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
function startPanelDrag(ev, panel) {
  const dock = panel.closest('.side-dock');
  const panels = $$('.side-panel', dock);
  if (panels.length < 2) return;
  const head = ev.target.closest('.tc-head');
  const hint = document.createElement('div');
  hint.className = 'drop-hint';
  let moved = false, toTop = panels[0] === panel;
  dragWith(ev, head, (e) => {
    if (!moved && Math.abs(e.clientY - ev.clientY) < 6) return;
    if (!moved) { moved = true; panel.classList.add('dragging'); dock.append(hint); }
    const r = dock.getBoundingClientRect();
    toTop = e.clientY < r.top + r.height / 2;
    hint.classList.toggle('bottom', !toTop);
  }, () => {
    panel.classList.remove('dragging'); hint.remove();
    if (!moved) return;
    const other = panels.find(p => p !== panel);
    const order = toTop ? [panel, other] : [other, panel];
    if (order[0] === panels[0]) return;
    // Move the existing nodes, so chat drafts, the pad's text and scroll positions survive.
    dock.append(order[0], $('.side-split', dock), order[1]);
    savePrefs({ sidePanels: order.map(p => p.dataset.panel) });
  });
}
function startSplitDrag(ev, bar) {
  const dock = bar.closest('.side-dock');
  bar.classList.add('active');
  dragWith(ev, bar, (e) => {
    const r = dock.getBoundingClientRect();
    dock.style.setProperty('--split', clampSplit((e.clientY - r.top) / r.height));
  }, () => { bar.classList.remove('active'); savePrefs({ sideSplit: clampSplit(dock.style.getPropertyValue('--split')) }); });
}

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupSidebar() {
  document.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    const split = ev.target.closest('[data-side-split]');
    if (split) return startSplitDrag(ev, split);
    const head = ev.target.closest('.side-dock .tc-head');
    if (head && !ev.target.closest('button, select, input, a')) startPanelDrag(ev, head.closest('.side-panel'));
  });
  document.addEventListener('dblclick', (ev) => {
    const split = ev.target.closest('[data-side-split]');
    if (split) { split.closest('.side-dock').style.setProperty('--split', 0.5); savePrefs({ sideSplit: 0.5 }); }
  });
}
