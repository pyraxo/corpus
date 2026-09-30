// A small, forgiving HTML parser: enough of the HTML rules (void elements, raw text, implied
// closing of <p> and <li>) to read real web pages into a tree for article extraction.
import { decodeEntities } from '../files/formats/html.mjs';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp']);
// Starting one of these closes an open <p>.
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'figcaption', 'details']);
const SELF_CLOSING = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'] };

const node = (tag, attrs = {}, parent = null) => ({ tag, attrs, children: [], parent });

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

export function parseHtml(html) {
  const root = node('#root');
  let cur = root, i = 0;
  const text = (t) => { if (t) cur.children.push(decodeEntities(t)); };
  const close = (tag) => { for (let n = cur; n && n !== root; n = n.parent) if (n.tag === tag) { cur = n.parent; return true; } return false; };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(html.slice(i)); break; }
    text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue; }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e < 0 ? html.length : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(lt, lt + 4000));
    if (!m) { text('<'); i = lt + 1; continue; }
    i = lt + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) { if (tag === 'p' && !close('p')) cur.children.push(node('p', {}, cur)); else close(tag); continue; }
    if (tag === 'p' || CLOSES_P.has(tag)) { for (let n = cur; n && n !== root; n = n.parent) { if (n.tag === 'p') { cur = n.parent; break; } if (CLOSES_P.has(n.tag) && n.tag !== 'p') break; } }
    if (SELF_CLOSING[tag] && SELF_CLOSING[tag].includes(cur.tag)) cur = cur.parent;
    const el = node(tag, parseAttrs(m[3]), cur);
    cur.children.push(el);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      el.children.push(html.slice(i, end < 0 ? html.length : end));
      i = end < 0 ? html.length : html.indexOf('>', end) + 1;
      continue;
    }
    if (!VOID.has(tag) && !m[3].trim().endsWith('/')) cur = el;
  }
  return root;
}

// Every element below n, depth first.
export function* walk(n) { for (const c of n.children) if (typeof c !== 'string') { yield c; yield* walk(c); } }
export const findAll = (n, test) => [...walk(n)].filter(test);
export const find = (n, test) => { for (const e of walk(n)) if (test(e)) return e; return null; };
// Text inside n, raw-text elements (scripts, styles) left out.
export function textOf(n) {
  if (typeof n === 'string') return n;
  if (RAW.has(n.tag) && n.tag !== 'title') return '';
  return n.children.map(textOf).join('');
}
// Whitespace collapsed, and invisible characters (zero-width joiners, BOMs) dropped.
export const squash = (s) => String(s || '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
