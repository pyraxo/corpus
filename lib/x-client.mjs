// Read-only X client used to unroll threads and capture full tweet content.
// Uses the same session cookies as the FieldTheory sync. Only GET TweetDetail.
import fs from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
// The public bearer token embedded in X's own web client (not a secret; same one FieldTheory uses).
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const QUERY_TTL_MS = 24 * 3600_000;

export async function loadXCookies() {
  if (process.env.X_CT0 && process.env.X_AUTH_TOKEN) return { ct0: process.env.X_CT0, authToken: process.env.X_AUTH_TOKEN };
  // Optional file with CT0= / AUTH_TOKEN= lines (e.g. the env file your FieldTheory sync uses).
  const envPath = process.env.X_COOKIE_ENV;
  if (!envPath) return null;
  try {
    const vars = {};
    for (const line of (await fs.readFile(envPath, 'utf8')).split('\n')) {
      const m = line.match(/^\s*(CT0|AUTH_TOKEN)\s*=\s*(.*)$/);
      if (m) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return vars.CT0 && vars.AUTH_TOKEN ? { ct0: vars.CT0, authToken: vars.AUTH_TOKEN } : null;
  } catch { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class XClient {
  constructor({ cookies, cacheDir, log = () => {} }) {
    this.cookies = cookies;
    this.queryFile = path.join(cacheDir, 'x-query.json');
    this.log = log;
    this.query = null;
    this.rate = { remaining: null, limit: null, reset: null };
  }

  headers() {
    const { ct0, authToken } = this.cookies;
    return {
      authorization: `Bearer ${BEARER}`,
      'x-csrf-token': ct0,
      cookie: `auth_token=${authToken}; ct0=${ct0}`,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'user-agent': UA
    };
  }

  // X rotates GraphQL query IDs; discover the current one from the web client bundle.
  async discoverQuery(force = false) {
    if (!force && this.query) return this.query;
    if (!force) {
      try {
        const cached = JSON.parse(await fs.readFile(this.queryFile, 'utf8'));
        if (Date.now() - cached.discoveredAt < QUERY_TTL_MS) return (this.query = cached);
      } catch {}
    }
    const home = await (await fetch('https://x.com/home', { headers: { 'user-agent': UA, cookie: this.headers().cookie } })).text();
    const mainUrl = home.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"]*\/main\.[a-z0-9]+\.js/)?.[0];
    if (!mainUrl) throw new Error('Could not locate X web client bundle');
    const js = await (await fetch(mainUrl, { headers: { 'user-agent': UA } })).text();
    const m = js.match(/queryId:"([^"]+)",operationName:"TweetDetail",operationType:"query",metadata:\{featureSwitches:\[([^\]]*)\]/);
    if (!m) throw new Error('Could not find TweetDetail query in X bundle');
    this.query = { id: m[1], features: m[2].replace(/"/g, '').split(',').filter(Boolean), discoveredAt: Date.now() };
    await fs.mkdir(path.dirname(this.queryFile), { recursive: true });
    await fs.writeFile(this.queryFile, JSON.stringify(this.query));
    this.log(`discovered TweetDetail query ${this.query.id}`);
    return this.query;
  }

  async waitForBudget() {
    if (this.rate.remaining != null && this.rate.remaining <= 3 && this.rate.reset) {
      const wait = this.rate.reset * 1000 - Date.now() + 2000;
      if (wait > 0) { this.log(`rate limit reached, waiting ${Math.round(wait / 1000)}s`); this.waitingUntil = Date.now() + wait; await sleep(wait); this.waitingUntil = null; }
    }
  }

  async tweetDetail(tweetId, attempt = 0) {
    await this.waitForBudget();
    const q = await this.discoverQuery();
    const variables = { focalTweetId: tweetId, with_rux_injections: false, rankingMode: 'Relevance', includePromotedContent: false, withCommunity: true, withQuickPromoteEligibilityTweetFields: false, withBirdwatchNotes: false, withVoice: true };
    const features = Object.fromEntries(q.features.map(f => [f, true]));
    const fieldToggles = { withArticleRichContentState: true, withArticlePlainText: true, withGrokAnalyze: false, withDisallowedReplyControls: false };
    const url = `https://x.com/i/api/graphql/${q.id}/TweetDetail?` + new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(features), fieldToggles: JSON.stringify(fieldToggles) });
    const res = await fetch(url, { headers: this.headers() });
    this.rate = { remaining: Number(res.headers.get('x-rate-limit-remaining')), limit: Number(res.headers.get('x-rate-limit-limit')), reset: Number(res.headers.get('x-rate-limit-reset')) };
    if (res.status === 429 && attempt < 3) { this.rate.remaining = 0; return this.tweetDetail(tweetId, attempt + 1); }
    if ((res.status === 400 || res.status === 404) && attempt === 0) { await this.discoverQuery(true); return this.tweetDetail(tweetId, 1); }
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`X auth rejected (${res.status})`), { fatal: true });
    if (!res.ok) throw new Error(`TweetDetail ${res.status}`);
    return res.json();
  }

  // Returns normalized enrichment for a bookmarked tweet: self-thread, article, card, quote.
  // A quoted tweet is unrolled too (its own thread, article, card) as if it were bookmarked.
  async unroll(tweetId, { withQuote = true } = {}) {
    let json = await this.tweetDetail(tweetId);
    let { tweets, order, moreAfter } = collect(json);
    const focal = tweets.get(tweetId);
    if (!focal) {
      const reason = json?.data?.threaded_conversation_with_injections_v2 ? 'not-found' : (json?.errors?.[0]?.message || 'unavailable');
      return { id: tweetId, status: 'missing', reason, fetchedAt: new Date().toISOString() };
    }
    const author = focal.authorId;
    // Walk upward in case the bookmark points into the middle of a thread.
    const ancestors = [];
    let cursor = focal;
    while (cursor.inReplyTo && tweets.get(cursor.inReplyTo)?.authorId === author) { cursor = tweets.get(cursor.inReplyTo); ancestors.unshift(cursor); }
    const chain = [...ancestors, focal];
    const extend = () => {
      for (;;) {
        const last = chain[chain.length - 1];
        const next = order.map(id => tweets.get(id)).find(t => t.inReplyTo === last.id && t.authorId === author && !chain.includes(t));
        if (!next) break;
        chain.push(next);
      }
    };
    extend();
    // Long threads are paginated behind a "show more" cursor; refocus on the tail to continue.
    for (let page = 0; page < 12 && moreAfter.has(chain[chain.length - 1].id); page++) {
      const tail = chain[chain.length - 1].id;
      json = await this.tweetDetail(tail);
      const more = collect(json);
      for (const [id, t] of more.tweets) if (!tweets.has(id)) tweets.set(id, t);
      order = [...order, ...more.order.filter(id => !order.includes(id))];
      moreAfter = more.moreAfter;
      const before = chain.length;
      extend();
      if (chain.length === before) break;
    }
    const root = chain[0];
    const quote = withQuote && focal.quoted ? await this.unrollQuote(focal.quoted.id) : undefined;
    return {
      id: tweetId,
      status: 'ok',
      fetchedAt: new Date().toISOString(),
      rootId: root.id,
      thread: chain.map(stripInternal),
      article: focal.article || root.article || null,
      card: focal.card || null,
      quoted: focal.quoted ? stripInternal(focal.quoted) : null,
      ...(quote && { quote })
    };
  }

  // Full enrichment of a quoted tweet, one level deep. Transient failures leave it
  // unset so the backfill picks it up again later.
  async unrollQuote(id) {
    try { return await this.unroll(id, { withQuote: false }); }
    catch (error) { if (error.fatal) throw error; this.log(`quote ${id}: ${error.message || error}`); return undefined; }
  }
}

function stripInternal(t) {
  const { authorId, inReplyTo, article, card, quoted, ...rest } = t;
  return { ...rest, card: card || null, quoted: quoted ? stripInternal(quoted) : null };
}

function collect(json) {
  const tweets = new Map();
  const order = [];
  const moreAfter = new Set();
  const instructions = json?.data?.threaded_conversation_with_injections_v2?.instructions || [];
  for (const ins of instructions) {
    for (const entry of ins.entries || (ins.entry ? [ins.entry] : [])) {
      const content = entry.content || {};
      const items = content.items || (content.itemContent ? [{ item: { itemContent: content.itemContent }, entryId: entry.entryId }] : []);
      let lastInModule = null;
      for (const item of items) {
        const ic = item.item?.itemContent;
        if (ic?.itemType === 'TimelineTimelineCursor' || /cursor-showmore/.test(item.entryId || '')) { if (lastInModule) moreAfter.add(lastInModule); continue; }
        const t = normalizeTweet(ic?.tweet_results?.result);
        if (!t) continue;
        if (!tweets.has(t.id)) { tweets.set(t.id, t); order.push(t.id); }
        lastInModule = t.id;
      }
    }
  }
  return { tweets, order, moreAfter };
}

function unwrap(result) {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults') return result.tweet;
  return result.__typename === 'Tweet' ? result : null;
}

export function normalizeTweet(raw) {
  const t = unwrap(raw);
  if (!t?.legacy || !t.rest_id) return null;
  const legacy = t.legacy;
  const user = t.core?.user_results?.result;
  const note = t.note_tweet?.note_tweet_results?.result;
  let text = note?.text || legacy.full_text || '';
  const urlEntities = [...(legacy.entities?.urls || []), ...(note?.entity_set?.urls || [])];
  const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
  const links = [];
  for (const u of urlEntities) {
    if (!u.url) continue;
    const expanded = u.expanded_url || u.url;
    text = text.split(u.url).join(expanded);
    if (!links.includes(expanded)) links.push(expanded);
  }
  for (const m of mediaEntities) if (m.url) text = text.split(m.url).join('');
  // Drop the leading @mentions X prepends to replies within a thread.
  const displayStart = note ? 0 : (legacy.display_text_range?.[0] || 0);
  if (displayStart > 0) text = text.replace(/^(@\w+\s+)+/, '');
  const media = mediaEntities.map(m => {
    const variants = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return {
      type: m.type === 'photo' ? 'image' : m.type === 'animated_gif' ? 'gif' : m.type,
      url: m.media_url_https,
      width: m.original_info?.width || null,
      height: m.original_info?.height || null,
      video: variants[0]?.url || null,
      alt: m.ext_alt_text || null
    };
  });
  const quotedRaw = t.quoted_status_result?.result;
  return {
    id: t.rest_id,
    authorId: legacy.user_id_str,
    author: { handle: user?.core?.screen_name || user?.legacy?.screen_name || '', name: user?.core?.name || user?.legacy?.name || '', avatar: user?.avatar?.image_url || user?.legacy?.profile_image_url_https || null },
    inReplyTo: legacy.in_reply_to_status_id_str || null,
    postedAt: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
    text: decode(text).trim(),
    links: links.filter(l => !/^https?:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+\/(photo|video)/.test(l)),
    media,
    article: normalizeArticle(t.article?.article_results?.result),
    card: normalizeCard(t.card),
    quoted: quotedRaw ? normalizeTweet(quotedRaw) : null
  };
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function normalizeCard(card) {
  const values = card?.legacy?.binding_values;
  if (!values) return null;
  const get = (k) => values.find(v => v.key === k)?.value;
  const str = (k) => get(k)?.string_value || null;
  const img = ['summary_photo_image_large', 'photo_image_full_size_large', 'thumbnail_image_large', 'player_image_large'].map(k => get(k)?.image_value?.url).find(Boolean) || null;
  const title = str('title');
  if (!title && !img) return null;
  const cardUrl = card.legacy.url?.startsWith('http') && !/t\.co/.test(card.legacy.url) ? card.legacy.url : null;
  return { title, description: str('description'), domain: str('domain') || str('vanity_url'), image: img, url: cardUrl };
}

function normalizeArticle(a) {
  if (!a) return null;
  const mediaById = new Map((a.media_entities || []).map(m => [String(m.media_id), m.media_info?.original_img_url || null]));
  const entityMap = Object.fromEntries((a.content_state?.entityMap || []).map(e => [String(e.key), e.value]));
  const blocks = [];
  for (const b of a.content_state?.blocks || []) {
    if (b.type === 'atomic') {
      for (const r of b.entityRanges || []) {
        const ent = entityMap[String(r.key)];
        if (ent?.type === 'MEDIA') for (const mi of ent.data?.mediaItems || []) { const url = mediaById.get(String(mi.mediaId)); if (url) blocks.push({ type: 'image', url }); }
        else if (ent?.type === 'DIVIDER') blocks.push({ type: 'divider' });
        else if (ent?.data?.markdown) blocks.push({ type: 'code', text: ent.data.markdown });
      }
      continue;
    }
    if (!b.text?.trim()) continue;
    const type = { 'header-one': 'h2', 'header-two': 'h3', 'header-three': 'h4', 'unordered-list-item': 'li', 'ordered-list-item': 'oli', blockquote: 'quote', 'code-block': 'code' }[b.type] || 'p';
    blocks.push({ type, text: b.text });
  }
  return {
    title: a.title || '',
    preview: a.preview_text || '',
    cover: a.cover_media?.media_info?.original_img_url || null,
    blocks: blocks.length ? blocks : (a.plain_text || '').split(/\n{2,}/).filter(Boolean).map(text => ({ type: 'p', text }))
  };
}
