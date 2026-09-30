# Connect to Corpus (instructions for AI agents)

You are an AI agent being asked to connect yourself to **Corpus**, the user's bookmark library, over MCP. Follow these steps, then report back briefly.

## 1. Get the connection details

You need two values. They are normally included in the message that sent you here:

- **URL**: the Corpus MCP endpoint, e.g. `https://corpus.example.com/mcp`
- **Token**: the bearer token, a string starting with `corpus_`

If either is missing, ask the user. They can copy both from **Corpus → Settings → Agents & MCP**. Never print the token in full back to the user or write it into files that are committed to git.

## 2. Check the endpoint works

Send one JSON-RPC request:

```sh
curl -s "$URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A working server returns a list of about 23 tools, including `search_bookmarks`. A `401` means the token is wrong.

## 3. Register Corpus in your own MCP configuration

The server uses **Streamable HTTP**, authenticated with the header `Authorization: Bearer <token>`. Register it under the name `corpus` using whichever method matches you:

- **Claude Code**

  ```sh
  claude mcp add --scope user --transport http corpus "$URL" --header "Authorization: Bearer $TOKEN"
  ```

- **Hermes**: add this to `~/.hermes/config.yaml`, put `CORPUS_MCP_TOKEN=<token>` in `~/.hermes/.env`, then run `/reload-mcp`:

  ```yaml
  mcp_servers:
    corpus:
      url: "<URL>"
      headers:
        Authorization: "Bearer ${CORPUS_MCP_TOKEN}"
  ```

- **Cursor, Windsurf, Claude Desktop, or any client with an `mcpServers` JSON config**

  ```json
  { "mcpServers": { "corpus": { "url": "<URL>", "headers": { "Authorization": "Bearer <token>" } } } }
  ```

- **Codex CLI**: add this to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.corpus]
  url = "<URL>"
  http_headers = { Authorization = "Bearer <token>" }
  ```

- **Clients that only launch local commands (stdio)**: from a checkout of the Corpus repo, run `CORPUS_URL=<site url> CORPUS_MCP_TOKEN=<token> node scripts/mcp-stdio.mjs` as the command.

If your client rejects these keys, check its docs for how to add a remote (Streamable HTTP) MCP server with a custom header. If the new server doesn't load in your current session, tell the user a restart or reload is needed.

## 4. Verify

Call the `get_overview` tool through MCP. If you can't call it yet, repeat the `curl` check with `tools/call`:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_overview","arguments":{}}}
```

It returns the number of bookmarks, triage counts, and top topics.

## 5. Report back

Tell the user in two or three lines:

- where you registered Corpus,
- how many bookmarks it reports,
- and whether a reload is needed.

## Using Corpus afterwards

- **Start** with `get_overview`. Find bookmarks with `search_bookmarks` and open one with `read_bookmark`. Cite bookmarks by id or url.
- **Changes** go through `update_bookmark` and `bulk_update_bookmarks` (tags, triage, scratchpads), `create_bookmark` (save a URL), and `delete_bookmark` (moves it to Trash for 30 days).
- **Scratchpads**: the inbox has one scratchpad shared by the user and every agent. Call `read_scratchpad` before starting work and `write_scratchpad` to leave plans, findings or lists (it appends by default). Pass a bookmark `id` to read or write that bookmark's own scratchpad.
- **Highlights**: `list_highlights` returns the passages the user highlighted while reading. `read_bookmark` includes a bookmark's highlights and scratchpad.
- **Taxonomy and skills** have their own tools: `list_concepts`, `create_concept`, `update_concept` and `delete_concept`; and `list_skills`, `get_skill`, `create_skill`, `update_skill` and `delete_skill`.
- **Background jobs**: `run_classification` starts Jev tagging and `get_job` reports progress; `capture_threads` fetches missing threads.
- If a tool returns `needs_confirmation`, ask the user before calling it again with `confirm: true`.
- Skills are also exposed as MCP prompts.
