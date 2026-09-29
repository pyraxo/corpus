// Jev only reads text, so images (and video poster frames) are described with a
// vision model via OpenRouter before classification. Cached one file per bookmark.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.mjs';

const MODEL = process.env.DESCRIBE_MODEL || 'google/gemini-2.5-flash-lite';
const MAX_MEDIA = 4;
const PROMPT = (media) => {
  const one = media.length === 1;
  const list = media.map((m, i) => `${i + 1}. ${m.type === 'image' ? 'image' : 'poster frame of a video'}`).join(', ');
  return `${one ? 'This is the image' : `These are the ${media.length} images`} attached to a saved X post (${list}). The post text is below for context. ${one ? 'Write one short paragraph' : `Write exactly ${media.length} lines numbered 1. to ${media.length}., one per image`}: what it shows in 1-2 sentences (name the product, app, tool, game, chart, diagram, meme, person or place if identifiable; for a video frame, describe only what is visible), then the key visible text (headings, code, UI labels, slide or screenshot text), up to about 300 characters. No preamble.`;
};

export const describable = () => !!process.env.OPENROUTER_API_KEY;

// Media worth describing, in reading order: focal/thread tweets, then the quoted post.
export function mediaOf(r) {
  const parts = r.thread ? r.thread.flatMap(t => t.media || []) : r.media || [];
  const quoted = r.quoted?.thread ? r.quoted.thread.flatMap(t => t.media || []) : r.quoted?.media || [];
  return [...parts, ...quoted].filter(m => m.url && !m.alt).slice(0, MAX_MEDIA);
}

const small = (u) => /pbs\.twimg\.com\/media\//.test(u) && !/[?&]name=/.test(u) ? `${u}${u.includes('?') ? '&' : '?'}name=small` : u;

export async function readDescriptions(id) {
  try { return JSON.parse(await fs.readFile(path.join(paths.describe, `${id}.json`), 'utf8')); } catch { return null; }
}

// Returns { url: description } for the record's media, describing (and caching) any not yet done.
export async function describeRecord(r) {
  const media = mediaOf(r);
  if (!media.length) return {};
  const cached = await readDescriptions(r.id);
  if (cached && media.every(m => m.url in cached.items)) return cached.items;
  if (!describable()) return cached?.items || {};
  const context = (r.thread ? r.thread.map(t => t.text).join('\n') : r.text || '').slice(0, 1500);
  const content = [{ type: 'text', text: `${PROMPT(media)}\n\nPost text:\n${context || '(none)'}` },
    ...media.map(m => ({ type: 'image_url', image_url: { url: small(m.url) } }))];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json', 'HTTP-Referer': process.env.CORPUS_PUBLIC_URL || 'http://localhost', 'X-Title': 'Corpus' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 200 * media.length, temperature: 0.2 })
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise(s => setTimeout(s, 2000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`describe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const out = json.choices?.[0]?.message?.content || '';
    // Split "1. … 2. …" back into one description per image.
    const lines = out.split(/\n(?=\s*\d+[.)]\s)/).map(s => s.replace(/^\s*\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const whole = out.replace(/\s+/g, ' ').trim();
    const items = Object.fromEntries(media.map((m, i) => [m.url, media.length === 1 ? whole : lines.length === media.length ? lines[i] : i === 0 ? whole : '']));
    await fs.mkdir(paths.describe, { recursive: true });
    await fs.writeFile(path.join(paths.describe, `${r.id}.json`), JSON.stringify({ model: json.model, usage: json.usage, items, describedAt: new Date().toISOString() }));
    return items;
  }
}
