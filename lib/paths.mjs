import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.CORPUS_DATA || path.join(root, 'data');
export const paths = {
  // FieldTheory's default data directory; override in .env for other layouts.
  source: process.env.BOOKMARK_SOURCE || path.join(os.homedir(), '.ft-bookmarks', 'bookmarks.jsonl'),
  sourceDb: process.env.BOOKMARK_DB || path.join(os.homedir(), '.ft-bookmarks', 'bookmarks.db'),
  public: path.join(root, 'public'),
  build: path.join(dataDir, 'build'),
  enrich: path.join(dataDir, 'enrich'),
  classify: path.join(dataDir, 'classify'),
  cache: path.join(dataDir, 'cache'),
  state: path.join(dataDir, 'state.json'),
  status: path.join(dataDir, 'status.json'),
  chats: path.join(dataDir, 'chats')
};
