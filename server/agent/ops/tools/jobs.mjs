// Background work: Jev classification, thread capture and rebuilding the index.
import crypto from 'node:crypto';
import { classifyMany } from '../../../classify/jev.mjs';
import { requestPriority } from '../../../capture/priority.mjs';

export default function jobsTools(kit) {
  const { jobs, ctx, select, selector, needConfirm, rebuild, enricher, log } = kit;
  return [
    {
      name: 'run_classification', write: true, description: 'Run TypeSafe Jev over bookmarks (full thread/article content) to re-score topic and kind tags. Choose bookmarks with select, or scope "unclassified". Runs in the background; returns a job id for get_job. Over 200 bookmarks requires confirm: true. Cost ≈ $0.04 per million tokens (~$0.0002 per bookmark).',
      input: { type: 'object', properties: { select: selector, scope: { type: 'string', enum: ['selection', 'unclassified'] }, confirm: { type: 'boolean' } } },
      run: async (a) => {
        if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not configured on the server');
        const c = await ctx();
        let list = a.scope === 'unclassified' ? select(c, { status: 'all', unclassified: true, ...(a.select || {}) }) : select(c, { status: 'all', ...(a.select || {}) });
        list = list.filter(r => r.enrichment !== 'pending' || r.provider === 'web');
        if (!list.length) return { ok: true, count: 0, summary: 'Nothing to classify (uncaptured bookmarks are classified once their thread is captured)' };
        if (list.length > 200 && !a.confirm) return needConfirm(list.length, 'classify', list.slice(0, 3).map(r => r.id));
        const job = { id: crypto.randomUUID().slice(0, 8), kind: 'classification', status: 'running', total: list.length, done: 0, failed: 0, tokens: 0, startedAt: new Date().toISOString() };
        jobs.set(job.id, job);
        (async () => {
          try {
            for (let i = 0; i < list.length; i += 25) {
              const res = await classifyMany(list.slice(i, i + 25), c.ix.concepts, { concurrency: 6, log });
              job.done += res.ok; job.failed += res.failed; job.tokens += res.tokens;
            }
            await rebuild('ops:classify');
            job.status = 'done';
          } catch (e) { job.status = 'failed'; job.error = e.message; }
          job.finishedAt = new Date().toISOString();
          job.cost_usd = Math.round(job.tokens * 0.042 / 1e6 * 10000) / 10000;
        })();
        return { ok: true, job: job.id, count: list.length, summary: `Started Jev classification of ${list.length} bookmark${list.length === 1 ? '' : 's'} (job ${job.id})` };
      }
    },
    {
      name: 'get_job', description: 'Progress of a background job (classification). Omit id to list recent jobs.',
      input: { type: 'object', properties: { id: { type: 'string' } } },
      run: async (a) => a.id ? (jobs.get(a.id) || { error: 'No such job' }) : { jobs: [...jobs.values()].slice(-10).reverse() }
    },
    {
      name: 'capture_threads', write: true, description: 'Fetch the full thread / X article / link card for bookmarks now (front of the capture queue). Useful for bookmarks whose content is missing.',
      input: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
      run: async (a) => {
        const c = await ctx();
        const ids = a.ids.map(String).filter(id => c.ix.byId.get(id)?.enrichment === 'pending').slice(0, 100);
        for (const id of ids.reverse()) requestPriority(id);
        enricher?.kick();
        return { ok: true, queued: ids.length, summary: ids.length ? `Queued ${ids.length} bookmark${ids.length === 1 ? '' : 's'} for capture` : 'Those bookmarks are already captured' };
      }
    },
    {
      name: 'rebuild_index', write: true, description: 'Rebuild the index from the FieldTheory source (picks up newly synced bookmarks and taxonomy edits).',
      input: { type: 'object', properties: {} },
      run: async () => { const r = await rebuild('ops:rebuild'); return { ok: true, total: r.total, summary: `Rebuilt · ${r.total} bookmarks` }; }
    }
  ];
}
