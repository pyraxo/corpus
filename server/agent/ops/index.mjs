// Every capability Corpus has, as tools with JSON schemas. The web chat, the MCP
// endpoint (/mcp) and the stdio bridge all call these, so an agent can do
// anything the site can: search/read, tag/triage, scratchpads and highlights, add bookmarks and files, delete,
// edit the taxonomy, manage skills, run Jev classification and thread capture.
import { createToolkit } from './toolkit.mjs';
import libraryTools from './tools/library.mjs';
import bookmarksTools from './tools/bookmarks.mjs';
import notesTools from './tools/notes.mjs';
import taxonomyTools from './tools/taxonomy.mjs';
import skillsTools from './tools/skills.mjs';
import jobsTools from './tools/jobs.mjs';

export function createOps(deps) {
  const kit = createToolkit(deps);
  const { jobs, tagging, ingest } = kit;
  // The order here is the order agents see them in.
  const tools = [...libraryTools(kit), ...bookmarksTools(kit), ...notesTools(kit), ...taxonomyTools(kit), ...skillsTools(kit), ...jobsTools(kit)];

  const byName = new Map(tools.map(t => [t.name, t]));
  // meta.by names the writer (you, assistant, agent) for the inbox scratchpad.
  async function call(name, args = {}, meta = {}) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    args = { ...(args || {}) };
    // Older clients and skills still say "note".
    if ('note' in args && !('scratchpad' in args)) { args.scratchpad = args.note; delete args.note; }
    const result = await tool.run(args, meta);
    return { result, write: !!tool.write, summary: result?.summary || null };
  }
  const openaiTools = () => tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } }));
  const mcpTools = () => tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.input, annotations: { readOnlyHint: !t.write, destructiveHint: /delete/.test(t.name) } }));
  return { tools, call, openaiTools, mcpTools, jobs, ingest, isTagging: (id) => tagging.has(id) };
}
