// Builds the Corpus index from the FieldTheory export, its SQLite signals,
// cached X enrichment (threads, articles, cards), files added by hand and the user's taxonomy edits.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config/paths.mjs';
import { facets, mergeTaxonomy, compileMatchers } from './taxonomy.mjs';
import { readState } from './state.mjs';
import { readManual, asSource } from './manual.mjs';
import { needsQuote } from '../capture/enricher.mjs';
import { readFiles, fileSource } from '../files/store.mjs';

const clean = (s = '') => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTco = (s) => s.replace(/\s*https?:\/\/t\.co\/\w+/g, '').trim();
const iso = (s) => { const d = s ? new Date(s) : null; return d && !isNaN(d) ? d.toISOString() : null; };
const isXLink = (u) => /^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(u);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function readFieldTheorySignals() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(paths.sourceDb, { readOnly: true });
    const rows = db.prepare('select id, categories, domains from bookmarks').all();
    db.close();
    return new Map(rows.map(r => [String(r.id), { categories: (r.categories || '').split(',').filter(Boolean), domains: (r.domains || '').split(',').filter(Boolean) }]));
  } catch { return new Map(); }
}

async function readJsonDir(dir) {
  const out = new Map();
  let names = [];
  try { names = await fs.readdir(dir); } catch { return out; }
  await Promise.all(names.filter(n => n.endsWith('.json')).map(async n => {
    try { out.set(n.slice(0, -5), JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'))); } catch {}
  }));
  return out;
}

function mediaFromSource(objects = []) {
  return objects.filter(m => m.url).map(m => ({
    type: m.type === 'photo' ? 'image' : m.type === 'animated_gif' ? 'gif' : m.type,
    url: m.url, width: m.width || null, height: m.height || null,
    video: (m.videoVariants || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url || null
  }));
}

function titleFor(text, article, card) {
  if (article?.title) return article.title.trim();
  const first = text.split(/\n+/).map(s => s.trim()).find(s => s && !/^https?:\/\//.test(s)) || '';
  const sentence = first.split(/(?<=[.!?])\s/)[0];
  if (sentence.length >= 12 && sentence.length <= 120) return sentence;
  if (first.length > 120) return `${first.slice(0, 117).replace(/\s+\S*$/, '')}…`;
  if (card?.title) return card.title;
  return first || '';
}

const threadParts = (thread, focalId) => thread.map(t => ({ id: t.id, text: t.text, media: t.media, links: t.links, postedAt: t.postedAt, card: withCardUrl(t.card, t.links), quoted: t.quoted && t.id !== focalId ? { author: t.quoted.author, text: t.quoted.text, media: t.quoted.media || [] } : null }));
const withCardUrl = (card, links) => {
  const external = (links || []).filter(l => !isXLink(l));
  return card ? { ...card, url: card.url || external[0] || null, domain: card.domain || hostOf(external[0] || '') } : null;
};

// A quoted post, read as fully as a bookmark: its own thread, article and card once
// the quote has been unrolled (enr.quote), otherwise just the embedded post.
function shapeQuoted(src, full, fromX) {
  const id = String(src.id || '');
  const author = src.author || { handle: src.authorHandle, name: src.authorName, avatar: src.authorProfileImageUrl };
  const ok = full?.status === 'ok';
  const thread = ok ? full.thread : [];
  const focalIndex = Math.max(0, thread.findIndex(t => t.id === id));
  const focal = thread[focalIndex];
  const links = focal?.links || src.links || [];
  return {
    id,
    url: `https://x.com/${author.handle || 'i'}/status/${id}`,
    author,
    text: focal ? focal.text : fromX ? src.text : stripTco(clean(src.text || '')),
    media: focal?.media?.length ? focal.media : fromX ? src.media || [] : mediaFromSource(src.mediaObjects),
    postedAt: iso(focal?.postedAt || src.postedAt),
    thread: thread.length > 1 ? threadParts(thread, focal?.id) : null,
    focalIndex: thread.length > 1 ? focalIndex : 0,
    article: ok ? full.article : null,
    card: withCardUrl(ok ? full.card : src.card, links),
    links: links.filter(l => !/\/i\/article\//.test(l))
  };
}

function decideFormat({ threadLength, article, links, media, bodyText, quoted, articleLink }) {
  const external = links.filter(l => !isXLink(l));
  if (threadLength >= 2) return 'format:thread';
  if (article || articleLink) return 'format:article';
  if (external.some(l => /github\.com\/[^/]+\/[^/]+/i.test(l))) return 'format:repo';
  if (external.length) return 'format:link';
  if (media.some(m => m.type === 'video' || m.type === 'gif')) return 'format:video';
  // An image only makes it an image post when the words are incidental.
  if (media.some(m => m.type === 'image') && bodyText.replace(/https?:\/\/\S+/g, '').trim().length < 140) return 'format:image';
  if (quoted && bodyText.length < 200) return 'format:quote';
  return 'format:post';
}

export async function build({ log = console.log } = {}) {
  const started = Date.now();
  const [raw, ft, enrich, classified, described, state] = await Promise.all([
    fs.readFile(paths.source, 'utf8'),
    readFieldTheorySignals(),
    readJsonDir(paths.enrich),
    readJsonDir(paths.classify),
    readJsonDir(paths.describe),
    readState()
  ]);
  const concepts = mergeTaxonomy(state.taxonomy);
  const conceptIds = new Set(concepts.map(c => c.id));
  const byConcept = new Map(concepts.map(c => [c.id, c]));
  const parentsOf = new Map(concepts.map(c => { const out = []; let p = byConcept.get(c.parent); while (p) { out.push(p.id); p = byConcept.get(p.parent); } return [c.id, out]; }));
  const childrenOf = new Map(concepts.map(c => [c.id, concepts.filter(x => (parentsOf.get(x.id) || []).includes(c.id)).map(x => x.id)]));
  const matchers = compileMatchers(concepts.filter(c => c.facet === 'topic' || c.facet === 'kind'));
  const ftMap = new Map();
  for (const c of concepts) for (const key of c.ft || []) { if (!ftMap.has(key)) ftMap.set(key, []); ftMap.get(key).push(c.id); }

  const records = [];
  const quotePending = [];
  const items = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { items.push(JSON.parse(line)); } catch {} }
  // Hand-added web bookmarks arrive already "enriched" with their page text.
  for (const m of await readManual()) { const { line, enrichment } = asSource(m); items.push(line); enrich.set(m.id, enrichment); }
  // So do files: images, PDFs, books and text, with their metadata and an excerpt.
  for (const d of await readFiles()) { const { line, enrichment } = fileSource(d); items.push(line); enrich.set(d.id, enrichment); }
  for (const item of items) {
    const id = String(item.tweetId || item.id);
    const enr = enrich.get(id);
    const ok = enr?.status === 'ok';
    const thread = ok ? enr.thread : [];
    const focalIndex = Math.max(0, thread.findIndex(t => t.id === id));
    const focal = thread[focalIndex];
    const text = focal ? focal.text : stripTco(clean(item.text || ''));
    const article = ok ? enr.article : null;
    const card = ok ? enr.card : null;
    const links = [...new Set((focal?.links?.length ? focal.links : item.links || []).filter(l => !/\/i\/article\//.test(l) && !new RegExp(`/status/${id}`).test(l)))];
    const media = focal?.media?.length ? focal.media : mediaFromSource(item.mediaObjects);
    const quotedSrc = ok ? enr.quoted : item.quotedTweet;
    const quoted = quotedSrc ? shapeQuoted(quotedSrc, ok ? enr.quote : null, ok) : null;
    const threadLength = thread.length;
    const articleLink = (item.links || []).some(l => /\/i\/article\//.test(l));
    const format = item.format || decideFormat({ threadLength, article, links, media, bodyText: text, quoted, articleLink });

    // Topic + kind signals: FieldTheory's LLM domains/categories, then keyword rules over all captured text.
    const tags = new Map();
    // Collect evidence per concept, then combine independent signals: 1 - Π(1 - s).
    const add = (cid, by, score) => { if (!conceptIds.has(cid)) return; const e = tags.get(cid) || { id: cid, sources: {} }; e.sources[by] = Math.max(e.sources[by] || 0, score); tags.set(cid, e); };
    const sig = ft.get(id);
    for (const key of [...(sig?.domains || []), ...(sig?.categories || [])]) for (const cid of ftMap.get(key) || []) add(cid, 'fieldtheory', 0.6);
    const corpusText = [
      ...(threadLength ? thread.map(t => t.text) : [text]),
      item.doc && [item.title, item.doc.description, ...item.doc.subjects, item.doc.excerpt].join('\n'),
      article?.title, ...(article?.blocks || []).slice(0, 40).map(b => b.text), card?.title, card?.description,
      ...(quoted?.thread ? quoted.thread.map(t => t.text) : [quoted?.text]),
      quoted?.article?.title, ...(quoted?.article?.blocks || []).slice(0, 40).map(b => b.text), quoted?.card?.title, quoted?.card?.description
    ].filter(Boolean).join('\n').toLowerCase();
    const hits = [];
    for (const m of matchers) { const n = corpusText.split(m.re).length - 1; if (n) hits.push([m.id, n]); }
    hits.sort((a, b) => b[1] - a[1]);
    let topicCount = 0, kindCount = 0;
    for (const [cid, n] of hits) {
      if (cid.startsWith('topic:') && topicCount++ < 6) add(cid, 'keyword', Math.min(0.7, 0.3 + n * 0.1));
      if (cid.startsWith('kind:') && kindCount++ < 2) add(cid, 'keyword', Math.min(0.65, 0.3 + n * 0.1));
    }
    const jev = classified.get(id);
    for (const t of jev?.tags || []) add(t.id, 'typesafe', t.score ?? 0.9);
    add(format, 'rule', 1);
    const external = links.filter(l => !isXLink(l));
    if (media.some(m => m.type === 'image')) add('contains:image', 'rule', 1);
    if (media.some(m => m.type === 'video' || m.type === 'gif')) add('contains:video', 'rule', 1);
    if (external.length) add('contains:link', 'rule', 1);
    if (quoted) add('contains:quote', 'rule', 1);
    if (external.some(l => /github\.com|gitlab\.com|huggingface\.co/.test(l)) || /```/.test(corpusText)) add('contains:code', 'rule', 1);
    add(`source:${item.provider || 'twitter'}`, 'import', 1);
    const jevScore = new Map((jev?.tags || []).map(t => [t.id, t.score]));
    const related = (cid) => [cid, ...(parentsOf.get(cid) || []), ...(childrenOf.get(cid) || [])].some(x => (jevScore.get(x) || 0) >= 0.05);
    const finalTags = [];
    for (const e of tags.values()) {
      const entries = Object.entries(e.sources);
      let score = 1 - entries.reduce((p, [, v]) => p * (1 - v), 1);
      const semantic = /^(topic|kind):/.test(e.id);
      // When Jev has read the full content, signals it doesn't corroborate are discounted.
      if (semantic && jev && !e.sources.typesafe && !related(e.id)) score *= 0.55;
      if (semantic && score < 0.25) continue;
      const by = entries.sort((a, b) => b[1] - a[1])[0][0];
      finalTags.push({ id: e.id, by, score: Math.round(score * 1000) / 1000, sources: entries.map(([k]) => k) });
    }
    finalTags.sort((a, b) => b.score - a.score);

    // Vision descriptions of images and video posters, so search and Jev can read them.
    const desc = described.get(id)?.items;
    if (desc) for (const m of [...media, ...thread.flatMap(t => t.media || []), ...(quoted?.media || []), ...(quoted?.thread || []).flatMap(t => t.media || [])]) if (desc[m.url]) m.description = desc[m.url];

    records.push({
      id,
      url: item.url || `https://x.com/${item.authorHandle || 'i'}/status/${id}`,
      provider: item.provider || 'twitter',
      author: { handle: item.authorHandle || '', name: item.authorName || item.authorHandle || '', avatar: item.authorProfileImageUrl || null, verified: !!item.author?.isVerified },
      postedAt: iso(item.postedAt),
      capturedAt: iso(item.bookmarkedAt) || iso(item.syncedAt),
      sortIndex: item.sortIndex || null,
      // Your own title (edited in the reader) wins over the file's, the page's or the post's.
      title: state.overrides[id]?.title || item.title || titleFor(text, article, card),
      text,
      thread: threadLength > 1 ? threadParts(thread, focal?.id) : null,
      focalIndex: threadLength > 1 ? focalIndex : 0,
      article,
      card: withCardUrl(card, links),
      quoted,
      links,
      media,
      engagement: item.engagement || {},
      language: item.language || null,
      sensitive: !!item.possiblySensitive,
      format,
      tags: finalTags,
      enrichment: enr ? enr.status : 'pending',
      enrichedAt: enr?.fetchedAt || null,
      classifiedBy: jev ? jev.model : null,
      // Files: the document's metadata; and tags Jev thought worth adding to the taxonomy.
      ...(item.doc && { doc: item.doc, suggested: jev?.suggest?.length ? jev.suggest : null })
    });
    if (needsQuote(enr)) quotePending.push({ id, hint: 0 });
  }
  // FieldTheory sortIndex is the bookmark order; newest bookmark first.
  records.sort((a, b) => (BigInt(b.sortIndex || 0) > BigInt(a.sortIndex || 0) ? 1 : -1));
  records.forEach((r, i) => { r.order = records.length - i; delete r.sortIndex; });

  await fs.mkdir(paths.build, { recursive: true });
  const generatedAt = new Date().toISOString();
  const body = JSON.stringify({ generatedAt, total: records.length, records });
  // Unique temp names: the server and the backfill script may build at the same time.
  const put = async (name, data) => { const tmp = path.join(paths.build, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}`); await fs.writeFile(tmp, data); await fs.rename(tmp, path.join(paths.build, name)); };
  await put('bookmarks.json', body);
  await put('taxonomy.json', JSON.stringify({ scheme: 'corpus', generatedAt, facets, concepts }));
  const stats = { total: records.length, enriched: records.filter(r => r.enrichment !== 'pending').length, threads: records.filter(r => r.thread).length, ms: Date.now() - started };
  log(`built ${stats.total} records (${stats.enriched} enriched, ${stats.threads} threads) in ${stats.ms}ms`);
  await put('meta.json', JSON.stringify({ generatedAt, ...stats, classified: records.filter(r => r.classifiedBy).length }));
  return { generatedAt, ...stats, records, concepts, pending: records.filter(r => r.enrichment === 'pending').map(r => ({ id: r.id, hint: threadHint(r) })), quotePending };
}

// Rough prior for "this is probably a thread" so the backfill unrolls those first.
function threadHint(r) {
  let s = 0;
  // Nothing readable without enrichment (X articles, bare links): these go first.
  if (r.format === 'format:article' || !r.text.replace(/https?:\/\/\S+/g, '').trim()) s += 10;
  if (/🧵|\bthread\b|^\s*1\/|\(1\/\d+\)|1\/\d+\s*$|👇|⬇️|↓/im.test(r.text)) s += 3;
  if ((r.engagement?.replyCount || 0) > 20) s += 1;
  if (r.text.length > 240) s += 1;
  if (r.format === 'format:image' || r.format === 'format:post') s += 1;
  return s;
}
