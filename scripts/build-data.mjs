// Rebuild the index (data/build/) from the FieldTheory export and everything Corpus keeps, without the server.
import '../server/config/env.mjs';
import { build } from '../server/library/build.mjs';

await build();
