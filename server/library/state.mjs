// Server-side user state: per-bookmark overrides, taxonomy edits, settings.
// Kept outside the build so rebuilds and reclassification never clobber it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config/paths.mjs';

const empty = () => ({ version: 1, overrides: {}, taxonomy: { concepts: {} }, settings: {} });
let cache = null;
let writing = Promise.resolve();

export async function readState() {
  if (cache) return cache;
  try { cache = { ...empty(), ...JSON.parse(await fs.readFile(paths.state, 'utf8')) }; }
  catch { cache = empty(); }
  // Per-bookmark notes are now called the scratchpad.
  for (const o of Object.values(cache.overrides)) if ('note' in o) { if (o.note && !o.scratchpad) o.scratchpad = o.note; delete o.note; }
  return cache;
}

export async function writeState(mutate) {
  const state = await readState();
  mutate(state);
  state.updatedAt = new Date().toISOString();
  writing = writing.then(async () => {
    await fs.mkdir(path.dirname(paths.state), { recursive: true });
    const tmp = `${paths.state}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 1));
    await fs.rename(tmp, paths.state);
  });
  await writing;
  return state;
}
