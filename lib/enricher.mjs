// Background worker that unrolls threads and captures full content for every
// bookmark, respecting X's rate limit. Results are cached one file per tweet.
import fs from 'node:fs/promises';
import fs_sync from 'node:fs';
import path from 'node:path';
import { paths } from './paths.mjs';
import { XClient, loadXCookies } from './x-client.mjs';
import { lockHolder } from './lock.mjs';
import { takePriority } from './priority.mjs';

// Captured before quoted tweets were unrolled: the quote still needs its own thread / article.
export const needsQuote = (enr) => enr?.status === 'ok' && !!enr.quoted?.id && !('quote' in enr);

export class Enricher {
  constructor({ onBatch = async () => {}, log = console.log, batchSize = 25, respectLock = true } = {}) {
    this.respectLock = respectLock;
    this.onBatch = onBatch;
    this.log = (m) => log(`[enrich] ${m}`);
    this.batchSize = batchSize;
    this.queue = [];
    this.running = false;
    this.paused = false;
    this.done = 0;
    this.failed = 0;
    this.lastError = null;
    this.client = null;
  }

  async init() {
    const cookies = await loadXCookies();
    if (!cookies) { this.lastError = 'No X session cookies found'; return false; }
    this.client = new XClient({ cookies, cacheDir: paths.cache, log: this.log });
    return true;
  }

  // pending: [{id, hint}] — higher hint first, newest bookmarks already first in input order.
  enqueue(pending, { front = false } = {}) {
    const known = new Set(this.queue);
    const ids = [...pending].sort((a, b) => (b.hint || 0) - (a.hint || 0)).map(p => p.id).filter(id => !known.has(id));
    this.queue = front ? [...ids, ...this.queue.filter(id => !ids.includes(id))] : [...this.queue, ...ids];
    this.kick();
  }

  status() {
    return {
      available: !!this.client,
      running: this.running,
      paused: this.paused,
      queued: this.queue.length,
      done: this.done,
      failed: this.failed,
      waitingUntil: this.client?.waitingUntil || null,
      yieldingTo: this.yieldingTo || null,
      rate: this.client?.rate || null,
      lastError: this.lastError
    };
  }

  hasPriority() { try { return JSON.parse(fs_sync.readFileSync(path.join(paths.cache, 'priority.json'), 'utf8')).length > 0; } catch { return false; } }

  kick() {
    if (this.running || this.paused || !this.client || (!this.queue.length && !this.hasPriority())) return;
    this.running = true;
    this.loop().finally(() => { this.running = false; });
  }

  async loop() {
    await fs.mkdir(paths.enrich, { recursive: true });
    let sinceBatch = 0;
    while ((this.queue.length || this.hasPriority()) && !this.paused) {
      // A backfill script owns X while it runs; the server just waits.
      const holder = this.respectLock && lockHolder();
      if (holder) { this.yieldingTo = holder.pid; await new Promise(r => setTimeout(r, 30_000)); continue; }
      this.yieldingTo = null;
      const urgent = takePriority();
      const id = urgent || this.queue.shift();
      if (!id) break;
      if (urgent) this.queue = this.queue.filter(x => x !== urgent);
      const file = path.join(paths.enrich, `${id}.json`);
      let existing = null;
      try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
      if (existing && !needsQuote(existing)) continue;
      try {
        let result;
        if (existing) {
          const quote = await this.client.unrollQuote(existing.quoted.id);
          if (!quote) throw new Error(`quoted ${existing.quoted.id} unavailable`);
          // New fetchedAt: the content changed, so Jev reclassifies it.
          result = { ...existing, quote, fetchedAt: new Date().toISOString() };
        } else result = await this.client.unroll(id);
        await fs.writeFile(file, JSON.stringify(result));
        this.done++;
        if (!existing && result.thread?.length > 1) this.log(`${id}: unrolled ${result.thread.length}-part thread`);
        if (result.quote?.thread?.length > 1) this.log(`${id}: quoted post is a ${result.quote.thread.length}-part thread`);
        else if (existing) this.log(`${id}: captured quoted post${result.quote.article ? ' (article)' : ''}`);
      } catch (error) {
        this.failed++;
        this.lastError = String(error.message || error);
        this.log(`${id}: ${this.lastError}`);
        if (error.fatal) { this.paused = true; break; }
        await new Promise(r => setTimeout(r, 5000));
      }
      if (++sinceBatch >= this.batchSize || !this.queue.length) {
        sinceBatch = 0;
        try { await this.onBatch(); } catch (e) { this.log(`rebuild failed: ${e.message}`); }
      }
      // Stay polite: ~1 request/sec, well within the 300/15min window.
      await new Promise(r => setTimeout(r, 900));
    }
  }
}
