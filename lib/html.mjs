// Book and document HTML, made safe for the reader: a whitelist of reading tags, no
// scripts, styles or event handlers; images and internal links are rewritten by the caller.
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'hr', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'div', 'section', 'dl', 'dt', 'dd']);
const INLINE = new Set(['em', 'i', 'strong', 'b', 'u', 'code', 'sup', 'sub', 'small', 'br', 'a', 'img', 'cite', 'q', 'abbr', 's', 'mark']);
const DROP = /<(script|style|head|title|svg|math|object|iframe|noscript|template)\b[\s\S]*?<\/\1\s*>/gi;
const RENAME = { section: 'div', article: 'div', aside: 'div', header: 'div', footer: 'div', main: 'div', nav: 'div', b: 'strong', i: 'em', center: 'div', big: 'strong' };

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', shy: '' };
export const decodeEntities = (s = '') => String(s).replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
export const escapeHtml = (s = '') => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null; };

// opts.src(src) -> url | null; opts.href(href) -> { url } | { ch, anchor } | null
export function sanitize(html, { src = () => null, href = () => null } = {}) {
  let body = String(html);
  const b = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (b) body = b[1];
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(DROP, '');
  const out = [];
  const open = [];
  let last = 0;
  const re = /<\/?([a-zA-Z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  for (let m; (m = re.exec(body));) {
    out.push(textOnly(body.slice(last, m.index)));
    last = re.lastIndex;
    const closing = m[0][1] === '/';
    let name = m[1].toLowerCase().replace(/^\w+:/, '');
    name = RENAME[name] || name;
    if (!BLOCK.has(name) && !INLINE.has(name)) continue;
    if (closing) {
      const i = open.lastIndexOf(name);
      if (i >= 0) { for (let k = open.length - 1; k >= i; k--) out.push(`</${open[k]}>`); open.length = i; }
      continue;
    }
    const tag = m[0];
    const id = attr(tag, 'id');
    const idAttr = id ? ` id="x-${escapeHtml(id.replace(/[^\w-]/g, '_'))}"` : '';
    if (name === 'br' || name === 'hr') { out.push(`<${name}>`); continue; }
    if (name === 'img') {
      const url = src(attr(tag, 'src') || attr(tag, 'xlink:href') || attr(tag, 'href') || '');
      if (url) out.push(`<img src="${escapeHtml(url)}" alt="${escapeHtml(attr(tag, 'alt') || '')}" loading="lazy"${idAttr}>`);
      continue;
    }
    let extra = idAttr;
    if (name === 'a') {
      const h = attr(tag, 'href');
      const t = h ? href(h) : null;
      if (t?.url && /^(https?:|mailto:)/i.test(t.url)) extra += ` href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer"`;
      else if (t && t.ch != null) extra += ` data-ch="${t.ch}"${t.anchor ? ` data-anchor="x-${escapeHtml(t.anchor.replace(/[^\w-]/g, '_'))}"` : ''} href="#"`;
    }
    if ((name === 'td' || name === 'th') && attr(tag, 'colspan')) extra += ` colspan="${Number(attr(tag, 'colspan')) || 1}"`;
    if (m[0].endsWith('/>')) { out.push(`<${name}${extra}></${name}>`); continue; }
    open.push(name);
    out.push(`<${name}${extra}>`);
  }
  out.push(textOnly(body.slice(last)));
  for (let k = open.length - 1; k >= 0; k--) out.push(`</${open[k]}>`);
  // Empty wrappers left by dropped markup.
  return out.join('').replace(/<(div|p|span)>\s*<\/\1>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
// Text between tags stays escaped, whatever entities it used.
const textOnly = (s) => escapeHtml(decodeEntities(s.replace(/<[^>]*$/, '')));

// Readable plain text from HTML: blocks become paragraphs.
export function htmlText(html) {
  return decodeEntities(String(html).replace(DROP, ' ').replace(/<(br|hr)\b[^>]*>/gi, '\n').replace(/<\/(p|div|h\d|li|blockquote|pre|tr|figcaption|dt|dd)>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Small Markdown (and plain text) to HTML: headings, paragraphs, lists, quotes, code, rules, emphasis, links.
export function markdownHtml(text) {
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_]/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let para = [], list = null, code = null;
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (code !== null) { if (/^```/.test(line)) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; } else code.push(line); continue; }
    if (/^```/.test(line)) { flush(); close(); code = []; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/), li = line.match(/^\s*[-*+•]\s+(.*)/), oli = line.match(/^\s*\d+[.)]\s+(.*)/), q = line.match(/^>\s?(.*)/);
    if (h) { flush(); close(); out.push(`<h${Math.min(6, h[1].length + 1)}>${inline(h[2])}</h${Math.min(6, h[1].length + 1)}>`); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); close(); out.push('<hr>'); }
    else if (li || oli) { flush(); const tag = li ? 'ul' : 'ol'; if (list !== tag) { close(); out.push(`<${tag}>`); list = tag; } out.push(`<li>${inline((li || oli)[1])}</li>`); }
    else if (q) { flush(); close(); out.push(`<blockquote><p>${inline(q[1])}</p></blockquote>`); }
    else if (!line.trim()) { flush(); close(); }
    else { close(); para.push(line); }
  }
  if (code !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flush(); close();
  return out.join('\n');
}
