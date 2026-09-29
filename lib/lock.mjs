// Cross-process lock so the backfill script and the server's worker never both hit X or Jev.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.mjs';

const file = path.join(paths.cache, 'backfill.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function lockHolder() {
  try {
    const { pid, startedAt } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pid !== process.pid && alive(pid) ? { pid, startedAt } : null;
  } catch { return null; }
}

export function acquireLock() {
  const holder = lockHolder();
  if (holder) throw new Error(`Backfill already running (pid ${holder.pid})`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const release = () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });
  return release;
}
