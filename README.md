# corpus

Corpus is a self-hosted home for the things you save. It reads your X bookmarks from [FieldTheory](https://github.com/afar1/fieldtheory-cli), fetches the full thread behind each one, tags them with [TypeSafe Jev](https://typesafe.ai), and gives you somewhere quiet to read, sort, and ask questions about them. You can save ordinary web pages too.

![Corpus demo](docs/demo.gif)

There's a [longer demo video](docs/demo.mp4) if you want to see more.

## Features

- **Library.** Browse as a wall, a grid, or a list. You can search, and filter by topic, kind, or format, using a taxonomy you can edit. Each card shows its three most likely tags.
- **Full threads.** Most bookmarks only save the first tweet. Corpus fetches the rest of the thread, X long-form articles, link previews and quoted posts, and shows them in a clean reader.
- **Tagging.** Jev reads the whole thread and suggests topics. Those suggestions are combined with FieldTheory's own categories and simple keyword rules. Any tag you set yourself wins.
- **Inbox.** Go through new bookmarks one at a time and keep or archive each. You can sort the queue by date, length or popularity, and narrow it by type or topic.
- **Ask.** Chat about a single bookmark, or about everything you've saved. The assistant can also make changes for you: tag and triage bookmarks, save pages, edit the taxonomy, or run Jev. It checks with you before anything large or destructive.
- **Skills.** Instructions you save for jobs you repeat, such as a weekly digest. The assistant follows them on request.
- **MCP.** Everything above is available over MCP, so tools like Claude Code or Hermes can use Corpus directly.
- **Everyday use.** There's a ⌘K command palette and keyboard shortcuts (press `?` to see them), plus light and dark themes. You can install it on your phone, and it works offline.

## Getting started

You need Node 22.5 or newer. There's nothing else to install.

```sh
cp .env.example .env    # add your keys and password hash, and say where your bookmarks live
npm start               # opens on http://127.0.0.1:4173
npm run backfill        # optional: fetch every thread and tag it with Jev
```

Corpus looks for FieldTheory's export in `~/.ft-bookmarks` and rebuilds whenever that changes. Everything it generates lives in `data/`, which is ignored by git. That includes the index, caches, your tags and notes, chats, and skills.

These are the settings in `.env`:

| Setting | What it's for |
| --- | --- |
| `BOOKMARK_SOURCE`, `BOOKMARK_DB` | Where FieldTheory keeps your bookmarks |
| `X_COOKIE_ENV` | A file with your `CT0` and `AUTH_TOKEN` cookies, used for read-only thread fetching |
| `TYPESAFE_API_KEY` | Tagging with Jev (roughly $0.0002 per bookmark) |
| `OPENROUTER_API_KEY` | Chat. You can pick GLM 5.3 Flash, DeepSeek V4 Flash, or a free model |
| `CORPUS_PASSWORD_HASH`, `CORPUS_SESSION_SECRET` | The password that protects the site |
| `CORPUS_MCP_TOKEN` | The token agents use to connect over MCP |

## Connecting an agent

To connect Claude Code:

```sh
claude mcp add --transport http corpus https://your-host/mcp --header "Authorization: Bearer $CORPUS_MCP_TOKEN"
```

Settings → Agents & MCP in Corpus has setup snippets you can copy for Claude Code and Hermes. For tools that launch MCP servers as a local command, use `scripts/mcp-stdio.mjs`.

## How it works

Corpus is a single Node server, `server.mjs`. It serves a plain JavaScript front end from `public/` and builds its index with the modules in `lib/`:

- `build.mjs` assembles the index and scores tags.
- `x-client.mjs` and `enricher.mjs` fetch threads.
- `jev.mjs` handles classification.
- `ops.mjs` defines every action, shared by the chat and MCP.

There's a Docker Compose file that includes a Cloudflare Tunnel. See [docs/guide.md](docs/guide.md) for more on the backfill, tagging, access, MCP, the mobile app and deployment.
