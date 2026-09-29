// Fetch and cache readable text from a bookmark's linked page for chat context.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './paths.mjs';

const dir = path.join(paths.cache, 'pages');
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

export function readable(html) {
  const title = decode((html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  let body = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  body = (body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i) || [body])[0];
  const text = decode(body.replace(/<\/(p|div|h\d|li|pre|blockquote|tr|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title, text };
}

export async function fetchPage(url, { maxChars = 24000 } = {}) {
  if (!url || /^https?:\/\/(www\.)?(x|twitter)\.com\//.test(url)) return null;
  const file = path.join(dir, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  let page;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(9000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; Corpus/1.0; personal reader)', accept: 'text/html,text/plain' } });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/html|text\/plain|markdown/.test(type)) page = { url, ok: false, status: res.status };
    else {
      const raw = (await res.text()).slice(0, 3_000_000);
      const { title, text } = /html/.test(type) ? readable(raw) : { title: '', text: raw };
      page = { url: res.url, ok: text.length > 200, title, text: text.slice(0, maxChars), fetchedAt: new Date().toISOString() };
    }
  } catch (e) { page = { url, ok: false, error: e.name }; }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(page));
  return page;
}
