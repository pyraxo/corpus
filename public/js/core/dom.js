// DOM and text helpers used everywhere.
import { toast } from '../ui/toast.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const num = new Intl.NumberFormat('en');
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast('Copied');
}
export const sleep = (ms) => new Promise(res => setTimeout(res, ms));
