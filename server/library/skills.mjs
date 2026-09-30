// Skills: named, reusable instructions the assistant (web chat or any MCP client)
// can list, read and follow — e.g. "weekly-digest". Stored one JSON file per skill.
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../config/paths.mjs';

const dir = path.join(dataDir, 'skills');
export const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const SEED = [
  { name: 'weekly-digest', description: 'Summarize what was saved in the last 7 days, grouped by topic, with the best items first.', instructions: 'Search bookmarks saved or posted in the last 7 days (use since = today minus 7 days, sort by most saved). Group them by topic. For each group write one line on the theme and list the 2–4 most worthwhile items with a one-sentence reason and a citation. Finish with the three items to read first. Do not change anything.' },
  { name: 'tidy-taxonomy', description: 'Find untagged or weakly tagged bookmarks and propose (then, if approved, apply) better concepts.', instructions: 'Use get_overview and search_bookmarks to find bookmarks without a confident topic. Cluster them by what they are about. Propose new or existing concepts with keywords for each cluster and show example bookmarks. Only after the user approves: create the concepts (create_concept) and tag the bookmarks (bulk_update_bookmarks), then run_classification on them so Jev re-scores them.' },
  { name: 'triage-assistant', description: 'Walk the untriaged inbox in batches and suggest keep / archive with reasons.', instructions: 'Search untriaged bookmarks (status "inbox"), oldest saved first, 15 at a time. For each, suggest keep or archive with a short reason (keep: durable technique, reference, or something to act on; archive: stale news, hype, duplicates). Present the batch as a list, ask for approval, then apply with bulk_update_bookmarks (triage) and move on to the next batch.' }
];

async function ensureSeeded() {
  try { await fs.access(dir); return; } catch {}
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  for (const s of SEED) await fs.writeFile(path.join(dir, `${s.name}.json`), JSON.stringify({ ...s, createdAt: now, updatedAt: now }, null, 1));
}

export async function listSkills() {
  await ensureSeeded();
  const out = [];
  for (const n of (await fs.readdir(dir)).filter(n => n.endsWith('.json'))) {
    try { const s = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')); out.push(s); } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export async function getSkill(name) {
  await ensureSeeded();
  try { return JSON.parse(await fs.readFile(path.join(dir, `${slugify(name)}.json`), 'utf8')); } catch { return null; }
}
export async function saveSkill({ name, description, instructions }, { create = false } = {}) {
  await ensureSeeded();
  const slug = slugify(name);
  if (!slug) throw new Error('Skill name is required');
  const prev = await getSkill(slug);
  if (create && prev) throw new Error(`Skill "${slug}" already exists`);
  if (!create && !prev) throw new Error(`No skill named "${slug}"`);
  const now = new Date().toISOString();
  const skill = { name: slug, description: description ?? prev?.description ?? '', instructions: instructions ?? prev?.instructions ?? '', createdAt: prev?.createdAt || now, updatedAt: now };
  if (!skill.instructions.trim()) throw new Error('Skill instructions are required');
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(skill, null, 1));
  return skill;
}
export async function deleteSkill(name) {
  const slug = slugify(name);
  if (!(await getSkill(slug))) throw new Error(`No skill named "${slug}"`);
  await fs.rm(path.join(dir, `${slug}.json`));
}
