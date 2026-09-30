import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.CORPUS_DATA || path.join(root, 'data');
export const paths = {
  root,
  // FieldTheory's default data directory; override in .env for other layouts.
  source: process.env.BOOKMARK_SOURCE || path.join(os.homedir(), '.ft-bookmarks', 'bookmarks.jsonl'),
  sourceDb: process.env.BOOKMARK_DB || path.join(os.homedir(), '.ft-bookmarks', 'bookmarks.db'),
  public: path.join(root, 'public'),
  build: path.join(dataDir, 'build'),
  enrich: path.join(dataDir, 'enrich'),
  classify: path.join(dataDir, 'classify'),
  describe: path.join(dataDir, 'describe'),
  cache: path.join(dataDir, 'cache'),
  // Corpus's own copy of every post's media (FieldTheory keeps the text).
  archive: path.join(dataDir, 'archive'),
  archiveMedia: path.join(dataDir, 'archive', 'media'),
  // Files added by hand: images, PDFs, books, text (see files.mjs).
  files: path.join(dataDir, 'files'),
  state: path.join(dataDir, 'state.json'),
  status: path.join(dataDir, 'status.json'),
  chats: path.join(dataDir, 'chats')
};

// Corpus only ever reads FieldTheory's files; refuse a layout where our writes could land in its folder.
export function assertSeparateState() {
  const ft = path.resolve(path.dirname(paths.source));
  const ours = path.resolve(dataDir);
  if (ours === ft || ours.startsWith(ft + path.sep)) throw new Error(`CORPUS_DATA (${ours}) must not be inside FieldTheory's folder (${ft})`);
}
