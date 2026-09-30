// Resizable sidebars: the reader's list (left), the library's filters (left) and the reader's
// Ask AI / scratchpad sidebar (right). Drag an edge to resize within its limits; double-click it
// to go back to the default. Widths are kept per device (prefs) and applied as CSS variables.
import { $ } from '../core/dom.js';
import { prefs, savePrefs } from '../core/prefs.js';

// min and max in px; def is the width with nothing saved. The main column always keeps MAIN_MIN.
export const PANES = {
  queue: { pref: 'queueWidth', css: '--queue-w', side: 'left', min: 280, max: 560, def: () => 380 },
  rail: { pref: 'railWidth', css: '--rail-w', side: 'left', min: 200, max: 360, def: () => 232 },
  side: { pref: 'sideWidth', css: '--side-w', side: 'right', min: 320, max: 640, def: () => Math.min(480, Math.max(340, innerWidth * 0.32)) }
};
// Room the main column keeps, plus its borders and scrollbar.
const MAIN_MIN = 440 + 12;

// The width to use now: what you set, kept within the limits and the window.
export function paneWidth(name) {
  const p = PANES[name];
  const others = name === 'side' ? (PANES.queue && document.querySelector('.queue') ? paneWidth('queue') : 0) : 0;
  const room = innerWidth - MAIN_MIN - others;
  return Math.round(Math.max(p.min, Math.min(p.max, room, Number(prefs[p.pref]) || p.def())));
}
export function applyPanes() {
  const root = document.documentElement;
  for (const [name, p] of Object.entries(PANES)) root.style.setProperty(p.css, `${paneWidth(name)}px`);
}
export const paneEdge = (name, label) => `<div class="pane-edge" data-pane="${name}" role="separator" aria-orientation="vertical" aria-label="Resize ${label}" title="Drag to resize · double-click for the default width"></div>`;

function drag(ev, edge) {
  const name = edge.dataset.pane, p = PANES[name];
  const box = name === 'queue' ? $('.queue') : name === 'rail' ? $('.rail') : edge.closest('.side-dock');
  if (!box) return;
  ev.preventDefault();
  edge.setPointerCapture?.(ev.pointerId);
  edge.classList.add('active');
  document.body.classList.add('resizing');
  const r = box.getBoundingClientRect();
  let w = r.width;
  const move = (e) => {
    const want = p.side === 'left' ? e.clientX - r.left : r.right - e.clientX;
    const others = name === 'side' && $('.queue') ? paneWidth('queue') : 0;
    w = Math.round(Math.max(p.min, Math.min(p.max, innerWidth - MAIN_MIN - others, want)));
    document.documentElement.style.setProperty(p.css, `${w}px`);
  };
  const up = () => {
    edge.removeEventListener('pointermove', move); edge.removeEventListener('pointerup', up); edge.removeEventListener('pointercancel', up);
    edge.classList.remove('active'); document.body.classList.remove('resizing');
    savePrefs({ [p.pref]: w });
    // The library's wall redraws its columns for the new width.
    window.dispatchEvent(new Event('resize'));
  };
  edge.addEventListener('pointermove', move);
  edge.addEventListener('pointerup', up);
  edge.addEventListener('pointercancel', up);
}

// Listeners this module needs; main.js installs them once.
export function setupPanes() {
  applyPanes();
  document.addEventListener('pointerdown', (ev) => { const edge = ev.button === 0 && ev.target.closest('.pane-edge'); if (edge) drag(ev, edge); });
  document.addEventListener('dblclick', (ev) => {
    const edge = ev.target.closest('.pane-edge'); if (!edge) return;
    savePrefs({ [PANES[edge.dataset.pane].pref]: null });
    applyPanes(); window.dispatchEvent(new Event('resize'));
  });
  // A smaller window keeps each sidebar within what's left for the main column.
  let t = 0;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(applyPanes, 100); });
}
