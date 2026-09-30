# corpus

A self-hosted home for your saved bookmarks. Corpus reads X bookmarks from [FieldTheory](https://github.com/afar1/fieldtheory-cli), fetches full threads, tags them with [TypeSafe Jev](https://typesafe.ai), and lets you read, highlight, triage, and ask questions about them. Drop in your own images, PDFs and EPUB or MOBI books too: they get a reader with contents, highlights and notes, and Jev tags them and suggests new topics. It keeps its own copy of every post's images, so nothing is lost when a post is deleted on X.

![Corpus demo](docs/demo.gif)

[Watch the demo with sound (1:27)](docs/demo.mp4)

Corpus keeps its own state in `data/` and never writes to your FieldTheory files.

## Getting started

Requires Node 22.5+.

```sh
cp .env.example .env    # keys, password hash, bookmark location
npm start               # http://127.0.0.1:4173
npm run backfill        # optional: fetch every thread and tag it
```

| `.env` setting | Purpose |
| --- | --- |
| `BOOKMARK_SOURCE`, `BOOKMARK_DB` | FieldTheory export (default `~/.ft-bookmarks`) |
| `X_COOKIE_ENV` | File with `CT0` and `AUTH_TOKEN`, for read-only thread fetching |
| `TYPESAFE_API_KEY` | Jev tagging |
| `OPENROUTER_API_KEY` | Chat models |
| `CORPUS_PASSWORD_HASH`, `CORPUS_SESSION_SECRET` | Site password |
| `CORPUS_MCP_TOKEN` | MCP access token |

## Connecting an agent

Paste this into any MCP-capable agent:

```text
Connect yourself to my Corpus bookmark library over MCP. Fetch and follow the instructions at https://your-host/connect.md.

URL: https://your-host/mcp
Token: <CORPUS_MCP_TOKEN>
```

Settings → Agents & MCP copies it with your URL and token filled in.

## How it works

No dependencies: Node's standard library on the server, plain JavaScript modules in the browser (and pdf.js, vendored).

```text
server/
  main.mjs            starts everything
  core.mjs            builds, the search index, Jev for new bookmarks, capture and archive workers
  config/             .env, data paths, API keys
  http/               the site: request order and auth (site.mjs), routes/, static files, a small router
  library/            the index (build, search, taxonomy) and what you keep (state, scratchpad, trash, skills, saved pages)
  capture/            X threads and articles, linked pages, local copies of images
  classify/           Jev (topics, kinds, suggested tags) and image descriptions
  files/              files you add (store.mjs) and their formats: PDF, EPUB, MOBI, zip, HTML
  agent/              chat, MCP, and ops/: every action as a tool, grouped in tools/
scripts/              backfill, rebuild, the MCP stdio bridge
public/
  js/main.js          starts the app; core/, data/, ui/, views/, features/, app/ hold the rest
  css/                one stylesheet per part of the app
  vendor/pdfjs/       pdf.js, for PDFs
docs/                 the guide, and connect.md for agents
```

`npm start` runs the server; `npm run check` syntax-checks every file.

See [docs/guide.md](docs/guide.md) for details.
