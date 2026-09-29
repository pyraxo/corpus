// In-memory BM25 over the built index, used by chat retrieval and tools.
import { recordText } from './jev.mjs';

const STOP = new Set('a an and are as at be but by for from has have i if in into is it its of on or so that the their them then there these they this to was we were what when which who will with you your my me our just not no can do does how why about all more some than too very also get got like one out up via'.split(' '));
export const tokenize = (s = '') => (s.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) || [])
  .map(t => t.replace(/[.-]+$/, '')).filter(t => t.length > 1 && !STOP.has(t)).map(t => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));

export class SearchIndex {
  constructor(records, concepts) {
    this.records = records;
    this.byId = new Map(records.map(r => [r.id, r]));
    this.concepts = concepts;
    this.conceptById = new Map(concepts.map(c => [c.id, c]));
    this.postings = new Map();
    this.lengths = new Float64Array(records.length);
    records.forEach((r, i) => {
      const labels = r.tags.map(t => this.conceptById.get(t.id)?.label).filter(Boolean).join(' ');
      const weighted = `${r.title} ${r.title} ${labels} ${labels} ${r.author.name} ${r.author.handle} ${recordText(r, 6000)}`;
      const tf = new Map();
      for (const t of tokenize(weighted)) tf.set(t, (tf.get(t) || 0) + 1);
      this.lengths[i] = [...tf.values()].reduce((a, b) => a + b, 0);
      for (const [t, n] of tf) { if (!this.postings.has(t)) this.postings.set(t, []); this.postings.get(t).push(i, n); }
    });
    this.avg = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, records.length);
  }

  resolveConcept(q) {
    if (!q) return null;
    const lq = String(q).toLowerCase();
    return this.conceptById.get(q)?.id || this.concepts.find(c => c.label.toLowerCase() === lq || c.id.endsWith(`/${lq}`) || c.id.endsWith(`:${lq}`))?.id || null;
  }

  search(query = '', { topic, format, author, since, until, limit = 10 } = {}) {
    const N = this.records.length;
    const scores = new Map();
    for (const t of new Set(tokenize(query))) {
      const list = this.postings.get(t);
      if (!list) continue;
      const df = list.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let k = 0; k < list.length; k += 2) {
        const i = list[k], tf = list[k + 1];
        const s = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * this.lengths[i] / this.avg));
        scores.set(i, (scores.get(i) || 0) + s);
      }
    }
    const topicId = this.resolveConcept(topic);
    const formatId = format ? (String(format).startsWith('format:') ? format : `format:${format}`) : null;
    const within = (r) => {
      if (topicId && !r.tags.some(t => t.id === topicId || t.id.startsWith(`${topicId}/`))) return false;
      if (formatId && r.format !== formatId) return false;
      if (author && r.author.handle.toLowerCase() !== String(author).replace('@', '').toLowerCase()) return false;
      if (since && (r.postedAt || '') < since) return false;
      if (until && (r.postedAt || '') > `${until}T23:59:59`) return false;
      return true;
    };
    let hits;
    if (scores.size) hits = [...scores].filter(([i]) => within(this.records[i])).sort((a, b) => b[1] - a[1]).map(([i, s]) => ({ r: this.records[i], s }));
    else hits = this.records.filter(within).map(r => ({ r, s: 0 })); // filters only: newest saved first
    return hits.slice(0, limit);
  }
}
