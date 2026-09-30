# Corpus guide

Detailed notes on running and operating Corpus. See the [README](../README.md) for the overview.

## Install on your phone

Corpus is a PWA. On iPhone: open https://corpus.example.com in Safari → Share → **Add to Home Screen**. On Android or desktop Chrome: use **Install app** (also in Settings → This device, or ⌘K → "Install Corpus as an app"). Sign in once inside the app; the session lasts 30 days.

The service worker (`public/sw.js`) caches the app shell, the bookmark index (network-first), fonts and tweet images (up to 400), so the library and reader work offline. It never caches `/api`, chat, `/mcp`, or the sign-in page. To ship frontend changes, bump the `?v=` query strings in `index.html` and `VERSION` / `SHELL` in `sw.js`.

## Keyboard

Press `⌘K` (or `Ctrl K`) for the command palette. It searches bookmarks, jumps to pages, filters by any concept, runs actions, and can send the query straight to Ask. `?` lists every shortcut. The main ones:

- **Anywhere:** `/` search · `g l/i/h/a/t/s` go to Library, Inbox, Highlights, Ask, Taxonomy, Settings · `⇧D` dark mode · `esc` back
- **Library:** arrow keys or `h j k l` move between cards in wall, grid and list · `⏎`/`o` open · `1 2 3` layout · `x` clear filters
- **Reader:** `j/k` or `←/→` next/previous · `c`/`r` chat/read · `t` tag · `n` scratchpad · `h` highlight the selection · `o` open on X · `m`/`e` keep/archive · `s` stack · `d` done reading
- **Inbox:** `⏎` keep · `e` archive · `j/↓` next · `k/↑` previous · `o` open · `p` inbox scratchpad · `h` highlight

## Run

```sh
npm start            # http://127.0.0.1:4173
```

The server rebuilds the index whenever the FieldTheory JSONL changes (checked daily at 23:30 UTC, half an hour after the Hermes sync; set `SOURCE_CHECK_UTC` to change it), so the daily sync flows in without any extra cron job. **Rebuild now** in Settings forces a rebuild.

## Backfill: threads, then Jev

Most bookmarks only save the first tweet. The backfill reads X's `TweetDetail` endpoint (read-only GET) with the same session cookies FieldTheory uses (`CT0` and `AUTH_TOKEN` from `~/.hermes/workspace/.env`, or `X_CT0`/`X_AUTH_TOKEN`). For each bookmark it captures the author's full self-thread (following pagination, including bookmarks that point mid-thread), long-form X articles, link cards, the full text of note tweets, and quoted posts. A quoted post is unrolled the same way (its own thread, article and link card), so a quote post is read, tagged and shown as the post followed by the full quoted post. Quote posts captured before this get their quoted post filled in on the next backfill (one extra request each) and are then reclassified. It then classifies each bookmark with Jev using that full content.

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
3. TypeSafe Jev: one Choice question over all topics and one over kinds, asked about the full content: every thread part with its own images, link cards and quoted posts, plus the article, link card and quote. Jev reads only text, so images and video poster frames are first described by a vision model on OpenRouter (`DESCRIBE_MODEL`, default `google/gemini-2.5-flash-lite`, about $0.0002 per bookmark, cached in `data/describe/`). Alt text is used when the author wrote it. Without `OPENROUTER_API_KEY` media is skipped, and those bookmarks are reclassified once the key is set. Jev's per-option probabilities become tag confidences. The cost is about $0.04 per million input tokens, roughly $0.55 for the whole library. Results are cached in `data/classify/`.

Signals are combined per tag (1 − Π(1 − s)). Keyword or FieldTheory tags that Jev doesn't corroborate are discounted. Cards show the three most confident topic/kind/label tags; hover a tag to see its confidence and sources.

## Chat

Chat runs through OpenRouter (`OPENROUTER_API_KEY`) and offers GLM 5.3 Flash (default), DeepSeek V4 Flash, and Nemotron 3 Super (free, with automatic fallback to other free models when it's overloaded). Conversations are saved in `data/chats/`. `CHAT_LIMIT_PER_HOUR` (default 200) caps requests.

Format is derived from the content. A thread is anything with two or more self-replies. An article is an X long-form post. Link and repo mean an external URL. Image means the words are incidental to the picture. Attachments such as images, video, links, quotes and code are tracked separately under *Contains*, so a post with a screenshot and a link is a link post that contains an image.

## State

`data/` is ignored by git:

| path | contents |
| --- | --- |
| `data/state.json` | your tag overrides, bookmark scratchpads, highlights, triage state, taxonomy edits |
| `data/scratchpad.json` | the inbox scratchpad and its last 50 revisions |
| `data/archive/media/` | Corpus's own copy of every post's images |
| `data/build/` | generated index served at `/data/*` |
| `data/enrich/`, `data/classify/`, `data/describe/` | per-bookmark caches |
| `data/manual.json` | bookmarks saved by URL (web pages) |
| `data/skills/`, `data/chats/` | skills and saved conversations |

Secrets go in the ignored `.env` (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `CORPUS_PASSWORD_HASH`, `CORPUS_SESSION_SECRET`, `CORPUS_MCP_TOKEN`), which the server and scripts load on start.

## The stack and read state

- **The stack** is a short reading list, at the top of the Library: at most five bookmarks, first in first out. Add one from the reader (**Add to stack**, `s`); when the stack is full, adding a sixth lets the oldest go. Remove one with its `×`, or press `s` again in the reader.
- **Done reading** (`d`, in the reader) labels a bookmark read, records when, and takes it off the stack. Press it again to mark it unread; the reader still shows when you last read it. Read is a label, not a triage status: cards show a small *Read* mark, the **Recently read** sort orders by when you finished, and bookmarks in Trash don't carry it.

## Scratchpads and highlights

- **Bookmark scratchpad.** Every bookmark has one (it used to be called the note): why you saved it, what to try, questions. It is in the reader and in the inbox's dock, and it is searchable.
- **Inbox scratchpad.** One running Markdown document for the whole inbox (`p` in the Inbox, or **Scratchpad** in the queue header). You, Ask and any agent connected over MCP read and write the same pad (`read_scratchpad` / `write_scratchpad`). It shares the right sidebar with Ask AI: open either or both (`p` / `a`, or **+ Scratchpad** / **+ Ask AI** in a panel's header), drag a panel by its header to swap top and bottom, drag the bar between them to share the height (double-click to even it out), and drag the sidebar's left edge to widen it. The layout is remembered on each device. It saves as you type. If an agent appends while you are editing, their addition is kept after your text. The last 50 versions are kept in `data/scratchpad.json`. **Preview** renders the Markdown, and `[[id]]` citations open the bookmark.
- **Highlights.** Select text in the reader or the inbox and tap **Highlight** (or press `h`). Click a highlight to copy or remove it. Each bookmark lists its highlights under the post. **Highlights** (`/highlights`, `g h`) shows all of them, newest first, and opening one scrolls the reader to the passage. They are searchable, included in the export, visible to agents (`list_highlights`, `read_bookmark`), and undoable.

## Keeping everything (the archive)

A post stays readable after it is deleted on X:

- **Text.** FieldTheory's export keeps the bookmarked post itself: its full text (long posts included), author, links and image URLs, and the quoted post's text. Its sync only adds or updates bookmarks and never removes one. It doesn't keep the rest of a thread, X article bodies, or a quoted post's own thread, so Corpus captures those once into `data/enrich/`.
- **Images.** The server downloads every image (original size), video poster frame, avatar, link-card image and article image into `data/archive/media/`, newest bookmarks first. Video itself isn't kept. New bookmarks are included as soon as they are built. When X stops serving a file, the app shows the local copy (`/media?u=…`, sign-in required). Files X had already removed before they could be saved are counted as "gone from X". `ARCHIVE_MAX_MB` (default 50) caps one file. Turn downloading off in Settings → Sources → Local archive.
- The reader's footer shows what is saved for each bookmark. `data/` is the only copy, so back it up.

## Archive, Trash and undo

- **Archive** keeps a bookmark out of the inbox. See it at `/archive` (Library → Status → Archived, or `g e`).
- **Delete** moves a bookmark to **Trash** (`/trash`, `g d`). It stays restorable for 30 days, then it is purged. For X bookmarks that means a permanent hidden tombstone in Corpus's state; for saved web pages, removal from `data/manual.json`.
- **Undo / redo** (`⌘Z` / `⇧⌘Z`) covers triage, tags, scratchpads, highlights, deletes and bulk actions made in the app. Changes made by the assistant show receipts in Ask instead.
- Corpus never writes to FieldTheory's files. It reads the export, and the server refuses to start if `data/` is inside FieldTheory's folder.

## Shortcuts

Every shortcut can be changed in Settings → Shortcuts (single keys, modifier combos like `⌘⇧Z`, or two-key sequences like `g l`). Press `?` for the current list.

## Agents & MCP

Everything the site can do is one set of tools (`lib/ops.mjs`), shared by the Ask chat and an MCP server:

| area | tools |
| --- | --- |
| read | `get_overview`, `search_bookmarks` (keywords + topic/kind/label/format/status/author/date filters, sorts), `read_bookmark` (full thread/article, tags with confidence, optional linked page) |
| bookmarks | `update_bookmark` (tags, triage, scratchpad, restore), `bulk_update_bookmarks` (ids or filter, dry run), `create_bookmark` (save any URL with its text), `delete_bookmark` |
| scratchpads | `read_scratchpad`, `write_scratchpad` (the inbox-wide pad, or one bookmark's with `id`; append by default), `list_highlights` |
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

## Docker

`compose.yaml` runs Corpus on `127.0.0.1:4173`. The public hostname, tunnel and login gate are managed outside this repo.

```sh
docker compose up -d --build
```
