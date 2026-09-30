// Bookmarks added by link (any web page). Stored in data/manual.json with the page read as an
// article (capture/article.mjs), and merged into the build as if they came from the source with
// their capture already done.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../config/paths.mjs';
import { fetchPage, isXUrl } from '../capture/pages.mjs';

const file = path.join(dataDir, 'manual.json');
export async function readManual() { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return []; } }
async function writeManual(items) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(file, JSON.stringify(items, null, 1)); }

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'web'; } };
export const manualId = (url) => `web-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}`;

export async function addManual({ url, title, text }, { maxSortIndex = 0n } = {}) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('A full http(s) URL is required');
  if (isXUrl(url)) throw new Error('Posts on X come in through FieldTheory: bookmark it on X and it arrives with the next sync');
  const items = await readManual();
  const id = manualId(url);
  const existing = items.find(i => i.id === id);
  if (existing) return { ...existing, duplicate: true };
  const page = text ? null : await fetchPage(url);
  if (!text && !page?.ok) throw new Error(page?.status ? `The page answered ${page.status}` : 'Couldn’t read that page');
  const a = page?.article;
  const body = text || page.text;
  const item = {
    id, url: page?.url || url, provider: 'web',
    title: title || a?.title || page?.title || (body.match(/^#{1,2}\s+(.+)$/m) || [])[1]?.trim() || body.split('\n').find(l => l.trim().length > 8)?.trim().slice(0, 120) || host(url),
    text: body,
    site: host(page?.url || url),
    createdAt: new Date().toISOString(),
    sortIndex: String(maxSortIndex + 1n),
    // The page as an article: kept whenever it has a body of blocks, shown in the reader like an X article.
    ...(a?.blocks?.length && { article: { siteName: a.siteName, byline: a.byline, published: a.published, cover: a.cover, description: a.description, lang: a.lang, words: a.words, isArticle: a.isArticle, blocks: a.blocks } })
  };
  items.push(item);
  await writeManual(items);
  return item;
}

export async function removeManual(id) {
  const items = await readManual();
  const next = items.filter(i => i.id !== id);
  if (next.length === items.length) return false;
  await writeManual(next);
  return true;
}

// Shape a manual item like a FieldTheory line plus its enrichment record.
export function asSource(item) {
  const a = item.article;
  const paras = a ? a.blocks.filter(b => b.type === 'p').map(b => b.text) : item.text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const summary = (a?.description || paras.find(p => p.length > 60) || paras[0] || '').slice(0, 600);
  const long = a ? a.words >= 150 : item.text.length > 1500;
  const site = a?.siteName || item.site;
  return {
    line: {
      id: item.id, tweetId: item.id, provider: 'web', url: item.url, text: summary,
      authorHandle: item.site, authorName: a?.byline || site, authorProfileImageUrl: `https://www.google.com/s2/favicons?domain=${item.site}&sz=64`,
      postedAt: a?.published || item.createdAt, bookmarkedAt: item.createdAt, syncedAt: item.createdAt, links: [item.url], sortIndex: item.sortIndex, engagement: {}
    },
    enrichment: {
      id: item.id, status: 'ok', fetchedAt: item.createdAt,
      thread: [{ id: item.id, text: summary, links: [item.url], media: [] }],
      article: long ? {
        title: item.title, preview: summary, cover: a?.cover || null, site, byline: a?.byline || null, published: a?.published || null,
        blocks: a ? a.blocks : paras.slice(0, 400).map(t => ({ type: 'p', text: t }))
      } : null,
      card: { title: item.title, description: long ? null : summary.slice(0, 280), domain: item.site, image: a?.cover || null, url: item.url },
      quoted: null
    }
  };
}
