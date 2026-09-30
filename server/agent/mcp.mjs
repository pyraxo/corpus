// Model Context Protocol server (Streamable HTTP, JSON responses) over the same
// operations the web chat uses. Tools = every Corpus capability; prompts = skills.
import { listSkills, getSkill } from '../library/skills.mjs';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `Corpus is the user's personal library of saved bookmarks (X posts, threads, long-form articles, and web pages), with a hierarchical taxonomy, triage state, scratchpads, highlights, and Jev (TypeSafe) classification.
Start with get_overview. Find things with search_bookmarks (keywords and/or filters) and read_bookmark. Cite bookmarks by id and url.
There is one inbox-wide scratchpad shared by the user and every agent: read_scratchpad before you start, and write_scratchpad (append) to leave plans, findings or lists there. Each bookmark also has its own scratchpad (pass its id). list_highlights returns the passages the user highlighted while reading.
You can change the library: update_bookmark / bulk_update_bookmarks (tags, triage, scratchpads), create_bookmark (save any URL), delete_bookmark, taxonomy CRUD (list/create/update/delete_concept), skills CRUD, run_classification (Jev), capture_threads, rebuild_index.
Tools that return needs_confirmation must be confirmed with the user before calling again with confirm: true. Skills are reusable procedures: list_skills, then get_skill and follow it.`;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcp(msg, ops, log = () => {}) {
  if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(m => handleMcp(m, ops, log)))).filter(Boolean); return out.length ? out : null; }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id ?? null, -32600, 'Invalid request');
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null; // notification (e.g. notifications/initialized)
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'corpus', title: 'Corpus', version: '0.3.0' },
          instructions: INSTRUCTIONS
        });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: ops.mcpTools() });
      case 'tools/call': {
        const name = params.name;
        log(`[mcp] ${name} ${JSON.stringify(params.arguments || {}).slice(0, 200)}`);
        try {
          const { result } = await ops.call(name, params.arguments || {}, { by: 'agent' });
          return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result, isError: false });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      case 'prompts/list':
        return ok({ prompts: (await listSkills()).map(s => ({ name: s.name, title: s.name, description: s.description, arguments: [{ name: 'focus', description: 'Optional extra direction', required: false }] })) });
      case 'prompts/get': {
        const s = await getSkill(params.name);
        if (!s) return rpcError(id, -32602, `Unknown prompt ${params.name}`);
        const focus = params.arguments?.focus ? `\n\nAlso: ${params.arguments.focus}` : '';
        return ok({ description: s.description, messages: [{ role: 'user', content: { type: 'text', text: `Follow the Corpus skill "${s.name}" using the Corpus tools.\n\n${s.instructions}${focus}` } }] });
      }
      case 'resources/list': return ok({ resources: [] });
      case 'resources/templates/list': return ok({ resourceTemplates: [] });
      default: return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) { return rpcError(id, -32603, e.message); }
}
