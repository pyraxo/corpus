// Skills: saved procedures the assistant follows on request.
import { listSkills, getSkill, saveSkill, deleteSkill, slugify } from '../../../library/skills.mjs';

export default function skillsTools(kit) {
  const {  } = kit;
  return [
    {
      name: 'list_skills', description: 'Saved skills: reusable instructions (e.g. weekly-digest, triage-assistant) you can follow on request.',
      input: { type: 'object', properties: {} },
      run: async () => ({ skills: (await listSkills()).map(s => ({ name: s.name, description: s.description })) })
    },
    {
      name: 'get_skill', description: 'Read a skill\'s full instructions before following it.',
      input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      run: async (a) => { const s = await getSkill(a.name); if (!s) throw new Error(`No skill named ${a.name}`); return s; }
    },
    {
      name: 'create_skill', write: true, description: 'Save a new skill: a short kebab-case name, a one-line description, and step-by-step instructions (which tools to use, what to produce, when to ask before changing things).',
      input: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } }, required: ['name', 'description', 'instructions'] },
      run: async (a) => { const s = await saveSkill(a, { create: true }); return { ok: true, name: s.name, summary: `Created skill ${s.name}` }; }
    },
    {
      name: 'update_skill', write: true, description: 'Change a skill\'s description and/or instructions.',
      input: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } }, required: ['name'] },
      run: async (a) => { const s = await saveSkill(a); return { ok: true, name: s.name, summary: `Updated skill ${s.name}` }; }
    },
    {
      name: 'delete_skill', write: true, description: 'Delete a skill. Requires confirm: true after the user agrees.',
      input: { type: 'object', properties: { name: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['name'] },
      run: async (a) => { if (!a.confirm) return { needs_confirmation: true, message: `Delete skill ${a.name}? Ask the user, then call again with confirm: true.` }; await deleteSkill(a.name); return { ok: true, summary: `Deleted skill ${slugify(a.name)}` }; }
    }
  ];
}
