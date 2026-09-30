// Ids someone is waiting on (opened in the reader). Whichever worker owns X —
// the server or the backfill script — takes these before its regular queue.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.mjs';

const file = path.join(paths.cache, 'priority.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
const write = (ids) => { fs.mkdirSync(paths.cache, { recursive: true }); fs.writeFileSync(file, JSON.stringify(ids)); };

export function requestPriority(id) {
  const ids = read().filter(x => x !== id);
  write([id, ...ids].slice(0, 200));
}

export function takePriority() {
  const ids = read();
  const next = ids.find(id => !fs.existsSync(path.join(paths.enrich, `${id}.json`)));
  if (ids.length) write(ids.filter(id => id !== next && !fs.existsSync(path.join(paths.enrich, `${id}.json`))));
  return next || null;
}
