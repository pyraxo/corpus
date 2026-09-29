// Backfill: unroll every thread / article / link card, then classify each bookmark
// with Jev using its full captured content. Resumable — rerun any time.
// The server's own worker pauses while this holds the lock.
//
//   npm run backfill                 # enrich everything, classify as items become ready
//   npm run backfill -- --classify   # only (re)classify already-captured bookmarks
//   npm run backfill -- --enrich     # only unroll threads
//   npm run backfill -- --limit 200  # cap items per stage
import '../lib/env.mjs';
import fs from 'node:fs/promises';
import { build } from '../lib/build.mjs';
import { paths } from '../lib/paths.mjs';
import { Enricher } from '../lib/enricher.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { classifyMany, needsClassification } from '../lib/jev.mjs';

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
    enricher.enqueue(latest.pending.slice(0, limit));
    log(`unrolling ${enricher.queue.length} bookmarks (X allows ~300 per 15 min)`);
    (async () => { while (enricher.running || enricher.queue.length) await new Promise(r => setTimeout(r, 2000)); enrichDone = true; })();
  }
}

// Classify in rounds so Jev runs while enrichment waits on X's rate limit.
let budget = limit;
for (;;) {
  const finalRound = enrichDone;
  if (doClassify && budget > 0) {
    const ready = [];
    for (const r of latest.records) if (ready.length < budget && await needsClassification(r)) ready.push(r);
    // Wait for a worthwhile batch while X is still being read.
    if (ready.length >= (finalRound ? 1 : 20)) {
      log(`classifying ${ready.length} with Jev`);
      const res = await classifyMany(ready, latest.concepts, { log });
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
