// TypeSafe Jev classification over a bookmark's full captured content
// (whole thread with each part's media, link cards and quotes, article, quote).
// Jev reads text only, so images and video posters are described first (describe.mjs).
// Choice answers return a probability per option, which becomes the confidence for each topic and kind tag.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.mjs';
import { describable, describeRecord, mediaOf } from './describe.mjs';

export const JEV_VERSION = 3;
const endpoint = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone';

const MEDIA_LABEL = { image: 'Image', gif: 'GIF', video: 'Video' };
const mediaLines = (media = []) => media.map(m => {
  const about = m.alt || m.description;
  return `[${MEDIA_LABEL[m.type] || 'Media'}${about ? `: ${about}` : ''}]`;
});
const cardLine = (c) => c?.title && `Link: ${c.title}${c.description ? ` — ${c.description}` : ''} (${c.domain || ''})`;
const quoteLines = (q) => q?.text || q?.media?.length ? [`Quoting @${q.author?.handle}: ${q.text || ''}`.trim(), ...mediaLines(q.media)] : [];

// The post (or thread) itself: parts with their media, cards and inline quotes, then any article.
function postParts(r) {
  const body = r.thread
    ? r.thread.map((t, i) => [`[${i + 1}/${r.thread.length}] ${t.text}`, ...mediaLines(t.media), cardLine(t.card), ...quoteLines(t.quoted)].filter(Boolean).join('\n'))
    : [[r.text, ...mediaLines(r.media)].filter(Boolean).join('\n')];
  return [
    r.article?.title && `Article: ${r.article.title}`,
    ...body,
    ...(r.article?.blocks || []).filter(b => b.text).map(b => b.text),
    // Thread parts carry their own cards; the focal card is only separate for single posts.
    !r.thread && cardLine(r.card)
  ];
}

export function recordText(r, max = 9000) {
  // A quoted post that was unrolled is read in full, like the bookmark itself.
  const q = r.quoted;
  const quote = q?.thread || q?.article ? [`Quoting @${q.author?.handle}${q.thread ? ` (thread of ${q.thread.length} posts)` : ''}:`, ...postParts(q)] : quoteLines(q);
  const parts = [...postParts(r), ...quote].filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function options(concepts, facet) {
  const byId = new Map(concepts.map(c => [c.id, c]));
  return Object.fromEntries(concepts.filter(c => c.facet === facet).map(c => {
    const parent = byId.get(c.parent);
    const name = parent ? `${parent.label} / ${c.label}` : c.label;
    const hints = (c.aliases || []).slice(0, 6).join(', ');
    return [c.id, hints ? `${name} (e.g. ${hints})` : name];
  }));
}

export async function classifyRecord(r, concepts, { media = 'none' } = {}) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const body = {
    model: process.env.TYPESAFE_MODEL || 'jev-latest',
    state: { author: `${r.author?.name} (@${r.author?.handle})`, format: r.thread ? `thread of ${r.thread.length} posts` : (r.format || '').replace('format:', ''), content: recordText(r, 12000), links: r.links?.slice(0, 5) },
    questions: {
      topic: { type: 'choice', instructions: 'Which topic is this saved post most specifically about? Judge the whole thread and what its images or video show ([Image: …] / [Video: …] lines describe attached media), not just the caption. Prefer the most specific subtopic that fits.', criteria: options(concepts, 'topic') },
      kind: { type: 'choice', instructions: 'What sort of thing is this saved post, taking its attached media into account?', criteria: options(concepts, 'kind') }
    }
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) { if (attempt < 4) { await new Promise(s => setTimeout(s, 2000 * 2 ** attempt)); continue; } }
    if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const pick = (answer, min, n) => Object.entries(answer?.probabilities || { [answer?.choice]: answer?.confidence ?? 0.9 })
      .filter(([id, p]) => id && id !== 'undefined' && p >= min).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([id, p]) => ({ id, by: 'typesafe', score: Math.round(p * 1000) / 1000 }));
    return {
      version: JEV_VERSION,
      media,
      basis: r.enrichedAt || r.enrichment,
      model: json.model,
      usage: json.usage,
      confidence: { topic: json.answers?.topic?.confidence ?? null, kind: json.answers?.kind?.confidence ?? null },
      tags: [...pick(json.answers?.topic, 0.08, 4), ...pick(json.answers?.kind, 0.12, 2)],
      classifiedAt: new Date().toISOString()
    };
  }
}

// Cheap auth check: a tiny real request, ignoring anything but whether the key was accepted.
export async function testTypesafeKey(apiKey) {
  const res = await fetch(endpoint, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TYPESAFE_MODEL || 'jev-latest', state: { content: 'test' }, questions: { q: { type: 'choice', instructions: 'test', criteria: [{ id: 'a', label: 'a' }] } } })
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Key rejected (${res.status})`);
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function readClassification(id) {
  try { return JSON.parse(await fs.readFile(path.join(paths.classify, `${id}.json`), 'utf8')); } catch { return null; }
}

// Ready = full content captured (or confirmed unavailable) and not yet classified on that basis.
// Also redo bookmarks classified without their media described once a vision key is available.
export async function needsClassification(r) {
  if (r.enrichment === 'pending') return false;
  const prev = await readClassification(r.id);
  return !prev || prev.version !== JEV_VERSION || prev.basis !== (r.enrichedAt || r.enrichment) || (prev.media === 'skipped' && describable());
}

// Describe the record's images first so Jev can read them; failures fall back to text only.
async function withMedia(r, log) {
  if (!mediaOf(r).length) return { r, media: 'none' };
  if (!describable()) return { r, media: 'skipped' };
  try {
    const items = await describeRecord(r);
    const add = (list = []) => list.map(m => items[m.url] ? { ...m, description: items[m.url] } : m);
    const addThread = (thread) => thread?.map(t => ({ ...t, media: add(t.media), quoted: t.quoted && { ...t.quoted, media: add(t.quoted.media) } })) || null;
    return { media: 'described', r: { ...r, media: add(r.media), thread: addThread(r.thread), quoted: r.quoted && { ...r.quoted, media: add(r.quoted.media), thread: addThread(r.quoted.thread) } } };
  } catch (e) { log(`describe ${r.id}: ${e.message}`); return { r, media: 'failed' }; }
}

// At most n calls of fn in flight at once.
const limiter = (n) => {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= n) await new Promise(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
};

// Describing images (1–3s) is much slower than Jev (~0.3s), so each has its own limit
// and slow descriptions don't leave Jev idle.
export async function classifyMany(records, concepts, { concurrency = 6, describeConcurrency = 12, log = () => {}, shouldStop = () => false } = {}) {
  await fs.mkdir(paths.classify, { recursive: true });
  let i = 0, ok = 0, failed = 0, tokens = 0;
  const jev = limiter(concurrency), vision = limiter(describeConcurrency);
  const worker = async () => {
    while (i < records.length && !shouldStop()) {
      const r = records[i++];
      try {
        const { r: full, media } = mediaOf(r).length && describable() ? await vision(() => withMedia(r, log)) : await withMedia(r, log);
        const result = await jev(() => classifyRecord(full, concepts, { media }));
        await fs.writeFile(path.join(paths.classify, `${r.id}.json`), JSON.stringify(result));
        ok++; tokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
      } catch (e) { failed++; log(`jev ${r.id}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: concurrency + describeConcurrency }, worker));
  return { ok, failed, tokens };
}
