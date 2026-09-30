// Web pages, fetched once and kept in data/cache/pages/: the page as an article (capture/article.mjs)
// and its plain text. Used to save a link as a bookmark, to show the article a tweet links to,
// and to give chat and agents the linked page.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config/paths.mjs';
import { extractArticle } from './article.mjs';

const dir = path.join(paths.cache, 'pages');
const VERSION = 2; // bump when extraction changes, so pages are read again
const UA = 'Mozilla/5.0 (compatible; Corpus/1.0; personal reader)';
export const isXUrl = (url) => /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(url || '');

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !/html|text\/plain|markdown/.test(type)) return { res, type, body: null };
  return { res, type, body: (await res.text()).slice(0, 4_000_000) };
}

export async function fetchPage(url, { maxChars = 60000 } = {}) {
  if (!url || isXUrl(url)) return null;
  const file = path.join(dir, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
  // Pages that couldn't be read are tried again after an hour (the site may have been down).
  try { const hit = JSON.parse(await fs.readFile(file, 'utf8')); if (hit.v === VERSION && (hit.ok || Date.now() - Date.parse(hit.fetchedAt) < 3600_000)) return hit; } catch {}
  let page;
  try {
    let { res, type, body } = await get(url);
    if (body == null) page = { url, ok: false, status: res.status };
    else if (!/html/.test(type)) page = { url: res.url, ok: body.length > 200, title: '', text: body.slice(0, maxChars), article: null };
    else {
      let article = extractArticle(body, res.url);
      // App shells (open.substack.com, some news sites) point at the real page as canonical.
      if (article.words < 100 && article.canonical && article.canonical !== res.url && !isXUrl(article.canonical)) {
        const again = await get(article.canonical).catch(() => null);
        if (again?.body && /html/.test(again.type)) { const a2 = extractArticle(again.body, again.res.url); if (a2.words > article.words) { article = a2; res = again.res; } }
      }
      const { text, ...rest } = article;
      page = { url: res.url, ok: text.length > 200, title: article.title || '', text: text.slice(0, maxChars), article: { ...rest, blocks: rest.blocks.slice(0, 600) } };
    }
  } catch (e) { page = { url, ok: false, error: e.name }; }
  page = { v: VERSION, ...page, fetchedAt: new Date().toISOString() };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(page));
  return page;
}
