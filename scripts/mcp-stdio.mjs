#!/usr/bin/env node
// stdio ⇄ HTTP bridge for MCP clients that launch a command (Claude Desktop, Hermes stdio, …).
// Forwards JSON-RPC lines to the running Corpus server so there is a single writer to state.
//   CORPUS_URL (default http://127.0.0.1:4173)   CORPUS_MCP_TOKEN (default: from .env)
import '../lib/env.mjs';
import readline from 'node:readline';

const url = `${(process.env.CORPUS_URL || 'http://127.0.0.1:4173').replace(/\/$/, '')}/mcp`;
const token = process.env.CORPUS_MCP_TOKEN;
const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const rl = readline.createInterface({ input: process.stdin });
const pending = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const p = (async () => {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify(msg) });
      if (res.status === 202) return;
      const body = await res.json();
      write(body);
    } catch (e) {
      if (msg.id !== undefined && msg.id !== null) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Corpus unreachable at ${url}: ${e.message}` } });
    }
  })();
  pending.add(p); p.finally(() => pending.delete(p));
});
rl.on('close', async () => { await Promise.all(pending); process.exit(0); });
