// The inbox-wide scratchpad: one running Markdown document shared by the user and
// every agent (Ask, MCP clients). Kept in data/scratchpad.json with recent revisions,
// so an overwrite never loses what was there before.
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './paths.mjs';

const file = path.join(dataDir, 'scratchpad.json');
const HISTORY = 50;
const MAX_CHARS = 200_000;
let writing = Promise.resolve();

export async function readPad() {
  try { const p = JSON.parse(await fs.readFile(file, 'utf8')); return { text: p.text || '', updatedAt: p.updatedAt || null, updatedBy: p.updatedBy || null, history: p.history || [] }; }
  catch { return { text: '', updatedAt: null, updatedBy: null, history: [] }; }
}

// Blocks separated by a blank line, whatever the existing text ends with.
export const appendBlock = (text, add) => { const a = String(text || '').replace(/\s+$/, ''), b = String(add || '').trim(); return a && b ? `${a}\n\n${b}` : a || b; };

// mode: 'replace' | 'append'. base: the updatedAt the writer last saw; when someone else
// saved since then and only appended, their addition is kept after this edit.
export async function writePad({ text = '', mode = 'replace', by = 'you', base } = {}) {
  let out, error;
  writing = writing.then(async () => {
    const cur = await readPad();
    let next = mode === 'append' ? appendBlock(cur.text, text) : String(text);
    let merged = false;
    if (mode === 'replace' && base !== undefined && base !== cur.updatedAt) {
      const prev = cur.history.find(h => h.at === base)?.text;
      if (prev !== undefined && cur.text.startsWith(prev) && cur.text.length > prev.length) { next = appendBlock(next, cur.text.slice(prev.length)); merged = true; }
    }
    if (next.length > MAX_CHARS) throw new Error(`The scratchpad is limited to ${MAX_CHARS.toLocaleString('en')} characters`);
    if (next === cur.text) { out = { ...cur, merged }; return; }
    const at = new Date().toISOString();
    // Each revision remembers the text it replaced, keyed by the time it was saved.
    const history = [{ text: cur.text, by: cur.updatedBy, at: cur.updatedAt, replacedAt: at }, ...cur.history].slice(0, HISTORY);
    out = { text: next, updatedAt: at, updatedBy: by, history, merged };
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ text: out.text, updatedAt: at, updatedBy: by, history }, null, 1));
    await fs.rename(tmp, file);
  }).catch(e => { error = e; });
  await writing;
  if (error) throw error;
  return out;
}
