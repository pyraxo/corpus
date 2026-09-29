// TypeSafe Jev classification over a bookmark's full captured content
// (whole thread, article, link card, quote). Choice answers return a probability
// per option, which becomes the confidence for each topic and kind tag.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.mjs';

export const JEV_VERSION = 2;
const endpoint = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone';

export function recordText(r, max = 9000) {
  const parts = [
    r.article?.title && `Article: ${r.article.title}`,
    ...(r.thread ? r.thread.map((t, i) => `[${i + 1}/${r.thread.length}] ${t.text}`) : [r.text]),
    ...(r.article?.blocks || []).filter(b => b.text).map(b => b.text),
    r.card?.title && `Link: ${r.card.title}${r.card.description ? ` — ${r.card.description}` : ''} (${r.card.domain || ''})`,
    r.quoted?.text && `Quoting @${r.quoted.author?.handle}: ${r.quoted.text}`
  ].filter(Boolean);
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

export async function classifyRecord(r, concepts) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const body = {
    model: process.env.TYPESAFE_MODEL || 'jev-latest',
    state: { author: `${r.author?.name} (@${r.author?.handle})`, content: recordText(r), links: r.links?.slice(0, 5) },
    questions: {
      topic: { type: 'choice', instructions: 'Which topic is this saved post most specifically about? Prefer the most specific subtopic that fits.', criteria: options(concepts, 'topic') },
      kind: { type: 'choice', instructions: 'What sort of thing is this saved post?', criteria: options(concepts, 'kind') }
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
      basis: r.enrichedAt || r.enrichment,
      model: json.model,
      usage: json.usage,
      confidence: { topic: json.answers?.topic?.confidence ?? null, kind: json.answers?.kind?.confidence ?? null },
      tags: [...pick(json.answers?.topic, 0.08, 4), ...pick(json.answers?.kind, 0.12, 2)],
      classifiedAt: new Date().toISOString()
    };
  }
}

export async function readClassification(id) {
  try { return JSON.parse(await fs.readFile(path.join(paths.classify, `${id}.json`), 'utf8')); } catch { return null; }
}

// Ready = full content captured (or confirmed unavailable) and not yet classified on that basis.
export async function needsClassification(r) {
  if (r.enrichment === 'pending') return false;
  const prev = await readClassification(r.id);
  return !prev || prev.version !== JEV_VERSION || prev.basis !== (r.enrichedAt || r.enrichment);
}

export async function classifyMany(records, concepts, { concurrency = 6, log = () => {}, shouldStop = () => false } = {}) {
  await fs.mkdir(paths.classify, { recursive: true });
  let i = 0, ok = 0, failed = 0, tokens = 0;
  const worker = async () => {
    while (i < records.length && !shouldStop()) {
      const r = records[i++];
      try {
        const result = await classifyRecord(r, concepts);
        await fs.writeFile(path.join(paths.classify, `${r.id}.json`), JSON.stringify(result));
        ok++; tokens += (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
      } catch (e) { failed++; log(`jev ${r.id}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ok, failed, tokens };
}
