// Bookmarks added by hand (any URL, not just X). Stored in data/manual.json and
// merged into the build as if they came from the source with enrichment already done.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './paths.mjs';
import { fetchPage } from './pages.mjs';

const file = path.join(dataDir, 'manual.json');
export async function readManual() { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return []; } }
async function writeManual(items) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(file, JSON.stringify(items, null, 1)); }

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'web'; } };

export async function addManual({ url, title, text }, { maxSortIndex = 0n } = {}) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('A full http(s) URL is required');
  const items = await readManual();
  const id = `web-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
  if (items.some(i => i.id === id)) throw new Error(`Already saved as ${id}`);
  const page = await fetchPage(url, { maxChars: 60000 });
  const body = text || (page?.ok ? page.text : '');
  const item = {
    id, url, provider: 'web',
    title: title || page?.title || (body.match(/^#{1,2}\s+(.+)$/m) || [])[1]?.trim() || body.split('\n').find(l => l.trim().length > 8)?.trim().slice(0, 120) || host(url),
    text: body,
    site: host(url),
    createdAt: new Date().toISOString(),
    sortIndex: String(maxSortIndex + 1n)
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
  const paras = item.text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const summary = (paras.find(p => p.length > 60) || paras[0] || '').slice(0, 600);
  const long = item.text.length > 1500;
  return {
    line: {
      id: item.id, tweetId: item.id, provider: 'web', url: item.url, text: summary,
      authorHandle: item.site, authorName: item.site, authorProfileImageUrl: `https://www.google.com/s2/favicons?domain=${item.site}&sz=64`,
      postedAt: item.createdAt, syncedAt: item.createdAt, links: [item.url], sortIndex: item.sortIndex, engagement: {}
    },
    enrichment: {
      id: item.id, status: 'ok', fetchedAt: item.createdAt,
      thread: [{ id: item.id, text: summary, links: [item.url], media: [] }],
      article: long ? { title: item.title, preview: summary, cover: null, blocks: paras.slice(0, 400).map(t => ({ type: 'p', text: t })) } : null,
      card: { title: item.title, description: long ? null : summary.slice(0, 280), domain: item.site, image: null, url: item.url },
      quoted: null
    }
  };
}
