# Corpus guide

Detailed notes on running and operating Corpus. See the [README](../README.md) for the overview.

## Install on your phone

Corpus is a PWA. On iPhone: open https://corpus.example.com in Safari → Share → **Add to Home Screen**. On Android or desktop Chrome: use **Install app** (also in Settings → This device, or ⌘K → "Install Corpus as an app"). Sign in once inside the app; the session lasts 30 days.

The service worker (`public/sw.js`) caches the app shell, the bookmark index (network-first), fonts and tweet images (up to 400), so the library and reader work offline. It never caches `/api`, chat, `/mcp`, or the sign-in page. To ship frontend changes, bump the `?v=` query strings in `index.html` and `VERSION` / `SHELL` in `sw.js`.

## Keyboard

Press `⌘K` (or `Ctrl K`) for the command palette. It searches bookmarks, jumps to pages, filters by any concept, runs actions, and can send the query straight to Ask. `?` lists every shortcut. The main ones:

- **Anywhere:** `/` search · `g l/i/a/t/s` go to Library, Inbox, Ask, Taxonomy, Settings · `⇧D` dark mode · `esc` back
- **Library:** arrow keys or `h j k l` move between cards in wall, grid and list · `⏎`/`o` open · `1 2 3` layout · `x` clear filters
- **Reader:** `j/k` or `←/→` next/previous · `c`/`r` chat/read · `t` tag · `n` note · `o` open on X · `m`/`e` keep/archive
- **Inbox:** `⏎` keep · `e` archive · `j/↓` next · `k/↑` previous · `o` open

## Run

```sh
npm start            # http://127.0.0.1:4173
```

The server rebuilds the index whenever the FieldTheory JSONL changes (checked every 5 minutes), so the daily Hermes sync flows in without any extra cron job. **Rebuild now** in Settings forces a rebuild.

## Backfill: threads, then Jev

Most bookmarks only save the first tweet. The backfill reads X's `TweetDetail` endpoint (read-only GET) with the same session cookies FieldTheory uses (`CT0` and `AUTH_TOKEN` from `~/.hermes/workspace/.env`, or `X_CT0`/`X_AUTH_TOKEN`). For each bookmark it captures the author's full self-thread (following pagination, including bookmarks that point mid-thread), long-form X articles, link cards, the full text of note tweets, and quoted posts. It then classifies each bookmark with Jev using that full content.

```sh
npm run backfill                  # unroll everything; Jev classifies as items become ready
npm run backfill -- --classify    # (re)classify only
npm run backfill -- --limit 200
```

Bookmarks with nothing readable until captured (X articles, bare links) go first, and opening an uncaptured bookmark moves it to the front of whichever worker is running. It is resumable and stays within X's 300 requests per 15 minutes; likely threads go first. While it runs it holds `data/cache/backfill.lock`, and the server's own worker pauses. Outside a backfill, the server does the same for new bookmarks as the daily sync brings them in: it unrolls them, then classifies them with Jev.

## Classification

Tags come from three sources, and your edits always win:

1. FieldTheory's LLM domains and categories, mapped onto the taxonomy
2. Keyword rules from each concept's aliases
3. TypeSafe Jev: one Choice question over all topics and one over kinds, asked about the full thread/article text. Jev's per-option probabilities become tag confidences. The cost is about $0.04 per million input tokens, roughly $0.55 for the whole library. Results are cached in `data/classify/`.

Signals are combined per tag (1 − Π(1 − s)). Keyword or FieldTheory tags that Jev doesn't corroborate are discounted. Cards show the three most confident topic/kind/label tags; hover a tag to see its confidence and sources.

## Chat

Chat runs through OpenRouter (`OPENROUTER_API_KEY`) and offers GLM 5.3 Flash (default), DeepSeek V4 Flash, and Nemotron 3 Super (free, with automatic fallback to other free models when it's overloaded). Conversations are saved in `data/chats/`. `CHAT_LIMIT_PER_HOUR` (default 200) caps requests.

Format is derived from the content. A thread is anything with two or more self-replies. An article is an X long-form post. Link and repo mean an external URL. Image means the words are incidental to the picture. Attachments such as images, video, links, quotes and code are tracked separately under *Contains*, so a post with a screenshot and a link is a link post that contains an image.

## State

`data/` is ignored by git:

| path | contents |
| --- | --- |
| `data/state.json` | your tag overrides, notes, triage state, taxonomy edits |
| `data/build/` | generated index served at `/data/*` |
| `data/enrich/`, `data/classify/` | per-bookmark caches |
| `data/manual.json` | bookmarks saved by URL (web pages) |
| `data/skills/`, `data/chats/` | skills and saved conversations |

Secrets go in the ignored `.env` (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `CORPUS_PASSWORD_HASH`, `CORPUS_SESSION_SECRET`, `CORPUS_MCP_TOKEN`), which the server and scripts load on start.

## Agents & MCP

Everything the site can do is one set of tools (`lib/ops.mjs`), shared by the Ask chat and an MCP server:

| area | tools |
| --- | --- |
| read | `get_overview`, `search_bookmarks` (keywords + topic/kind/label/format/status/author/date filters, sorts), `read_bookmark` (full thread/article, tags with confidence, optional linked page) |
| bookmarks | `update_bookmark` (tags, triage, note, restore), `bulk_update_bookmarks` (ids or filter, dry run), `create_bookmark` (save any URL with its text), `delete_bookmark` |
| taxonomy | `list_concepts`, `create_concept`, `update_concept`, `delete_concept` |
| skills | `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill` |
| jobs | `run_classification` (Jev, background) + `get_job`, `capture_threads`, `rebuild_index` |

Deletes, and bulk changes over 25 bookmarks (200 for classification), return `needs_confirmation` until they are repeated with `confirm: true`. In Ask, every change shows up as a receipt under the answer, and the library reloads.

**Skills** are saved, reusable procedures (`data/skills/`), seeded with `weekly-digest`, `tidy-taxonomy` and `triage-assistant`. The assistant lists them in its prompt. MCP clients see them as prompts. Ask the assistant to "save this as a skill" to add one.

**MCP endpoint:** `POST https://corpus.example.com/mcp` (Streamable HTTP, JSON responses) with `Authorization: Bearer $CORPUS_MCP_TOKEN` (from `.env`). Settings → Agents & MCP has copy buttons for the URL, the token, and the snippets below.

```sh
# Claude Code
claude mcp add --scope user --transport http corpus http://127.0.0.1:4173/mcp --header "Authorization: Bearer $CORPUS_MCP_TOKEN"
```

```yaml
# Hermes (~/.hermes/config.yaml; CORPUS_MCP_TOKEN in ~/.hermes/.env), then /reload-mcp
mcp_servers:
  corpus:
    url: "https://corpus.example.com/mcp"
    headers:
      Authorization: "Bearer ${CORPUS_MCP_TOKEN}"
```

For clients that only launch commands, use the stdio bridge, which forwards to the running server: `node scripts/mcp-stdio.mjs` (`CORPUS_URL`, `CORPUS_MCP_TOKEN`).

## Access

The whole site (pages, `/data`, `/api`, chat) sits behind a single password. Only a scrypt hash is stored. Signing in sets a signed, HttpOnly session cookie that lasts 30 days, and failed attempts are rate-limited per IP. To change the password:

```sh
node --input-type=module -e "import {hashPassword} from './lib/auth.mjs'; console.log(hashPassword('new password'))"
# put the output in .env as CORPUS_PASSWORD_HASH=…, then restart; also rotate CORPUS_SESSION_SECRET to sign everyone out
```

## Docker / tunnel

`compose.yaml` runs Corpus and the named Cloudflare tunnel for `corpus.example.com`. Copy `.cloudflared/config.example.yml` to `config.yml` and put the tunnel credential at `.cloudflared/credentials.json` (both ignored).

```sh
docker compose up -d --build
```
