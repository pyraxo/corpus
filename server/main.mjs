// Corpus server: start the library's workers, then serve the site, the API and MCP.
import './config/env.mjs';
import http from 'node:http';
import { assertSeparateState } from './config/paths.mjs';
import { initKeys } from './config/keys.mjs';
import { readState } from './library/state.mjs';
import { purgeTrash } from './library/trash.mjs';
import { createCore } from './core.mjs';
import { createSite } from './http/site.mjs';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
// Daily source check (UTC HH:MM), just after the Hermes FieldTheory sync at 23:00 UTC.
const [checkH, checkM] = (process.env.SOURCE_CHECK_UTC || '23:30').split(':').map(Number);
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

assertSeparateState();
await initKeys();
const core = createCore({ log });
const { enricher, archiver } = core;
await enricher.init();
await purgeTrash({ log });
setInterval(() => purgeTrash({ log }).catch(e => log(`[trash] ${e.message}`)), 6 * 3600_000).unref();
const state = await readState();
if (state.settings.enrich === false) enricher.paused = true;
await archiver.init();
if (state.settings.archive === false) archiver.paused = true;
// Also picks up captures from the backfill script, which builds outside this process.
setInterval(() => core.getIndex().then(ix => archiver.enqueue(ix.records)).catch(() => {}), 20 * 60_000).unref();
await core.checkSource();
function scheduleSourceCheck() {
  const now = new Date(), next = new Date(now);
  next.setUTCHours(checkH, checkM || 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { core.checkSource(); scheduleSourceCheck(); }, next - now).unref();
}
scheduleSourceCheck();
http.createServer(createSite(core)).listen(port, host, () => log(`Corpus listening at http://${host}:${port}`));
