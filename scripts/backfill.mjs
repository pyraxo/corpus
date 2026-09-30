// Backfill: unroll every thread / article / link card (and the quoted post's, for
// quote posts), then classify each bookmark
// with Jev using its full captured content. Resumable — rerun any time.
// The server's own worker pauses while this holds the lock.
//
//   npm run backfill                 # enrich everything, classify as items become ready
//   npm run backfill -- --classify   # only (re)classify already-captured bookmarks
//   npm run backfill -- --enrich     # only unroll threads
//   npm run backfill -- --limit 200  # cap items per stage
import '../server/config/env.mjs';
import fs from 'node:fs/promises';
import { build } from '../server/library/build.mjs';
import { paths } from '../server/config/paths.mjs';
import { Enricher } from '../server/capture/enricher.mjs';
import { acquireLock } from '../server/capture/lock.mjs';
import { classifyMany, needsClassification } from '../server/classify/jev.mjs';

const args = process.argv.slice(2);
const only = args.includes('--classify') ? 'classify' : args.includes('--enrich') ? 'enrich' : null;
const limit = Number(args[args.indexOf('--limit') + 1]) || Infinity;
const doEnrich = only !== 'classify';
const doClassify = only !== 'enrich' && !!process.env.TYPESAFE_API_KEY;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const statusFile = `${paths.cache}/backfill.json`;

acquireLock();
let latest = await build({ log });
const progress = { startedAt: new Date().toISOString(), stage: 'running', enriched: 0, classified: 0, failed: 0, tokens: 0 };
const writeProgress = () => fs.writeFile(statusFile, JSON.stringify({ ...progress, updatedAt: new Date().toISOString(), pending: latest.pending.length, total: latest.total })).catch(() => {});
if (!doClassify && only !== 'enrich') log('TYPESAFE_API_KEY not set — skipping Jev classification');

let enrichDone = !doEnrich;
const enricher = new Enricher({ log, respectLock: false, onBatch: async () => { latest = await build({ log }); progress.enriched = enricher.done; writeProgress(); } });
if (doEnrich) {
  if (!(await enricher.init())) { log(enricher.lastError); enrichDone = true; }
  else {
    // Quote posts captured before quotes were unrolled get their quoted thread / article too.
    const queued = [...latest.pending, ...latest.quotePending].slice(0, limit);
    enricher.enqueue(queued);
    const quotes = Math.max(0, queued.length - latest.pending.length);
    log(`unrolling ${queued.length - quotes} bookmarks and ${quotes} quoted posts (X allows ~300 per 15 min)`);
    (async () => { while (enricher.running || enricher.queue.length) await new Promise(r => setTimeout(r, 2000)); enrichDone = true; })();
  }
}

// Classify in rounds so Jev runs while enrichment waits on X's rate limit.
let budget = limit;
for (;;) {
  const finalRound = enrichDone;
  if (doClassify && budget > 0) {
    const ready = [];
    // Quote posts whose quoted thread is still being read wait, so they're classified once.
    const waiting = new Set(finalRound ? [] : latest.quotePending.map(p => p.id));
    for (const r of latest.records) if (ready.length < budget && !waiting.has(r.id) && await needsClassification(r)) ready.push(r);
    // Wait for a worthwhile batch while X is still being read.
    if (ready.length >= (finalRound ? 1 : 20)) {
      log(`classifying ${ready.length} with Jev`);
      const res = await classifyMany(ready, latest.concepts, { concurrency: 8, describeConcurrency: 24, log });
      budget -= ready.length;
      progress.classified += res.ok; progress.failed += res.failed; progress.tokens += res.tokens;
      latest = await build({ log });
      writeProgress();
      continue;
    }
  }
  if (finalRound) break;
  await new Promise(r => setTimeout(r, 15_000));
}
latest = await build({ log });
progress.stage = 'done';
await writeProgress();
log(`backfill done · ${enricher.done} unrolled · ${progress.classified} classified (${progress.failed} failed, ${progress.tokens} Jev tokens)`);
process.exit(0);
