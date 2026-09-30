// API keys (TypeSafe, OpenRouter) set from Settings, and a quick check that one works.
import { KEY_NAMES, keysStatus, setKey } from '../../config/keys.mjs';
import { testTypesafeKey } from '../../classify/jev.mjs';
import { testOpenRouterKey } from '../../agent/chat.mjs';
import { send, readJson } from '../respond.mjs';

export function keyRoutes(r) {
  r.get('/api/keys', async ({ res }) => send(res, 200, { keys: await keysStatus() }));
  r.put('/api/keys', async ({ req, res }) => {
    const { name, value } = await readJson(req);
    if (!KEY_NAMES.includes(name)) return send(res, 400, { ok: false, error: 'Unknown key' });
    await setKey(name, value);
    send(res, 200, { ok: true, keys: await keysStatus() });
  });
  r.post('/api/keys/test', async ({ req, res }) => {
    const { name, value } = await readJson(req);
    if (!KEY_NAMES.includes(name)) return send(res, 400, { ok: false, error: 'Unknown key' });
    const apiKey = value || process.env[name];
    if (!apiKey) return send(res, 400, { ok: false, error: 'No key to test' });
    try {
      if (name === 'OPENROUTER_API_KEY') await testOpenRouterKey(apiKey);
      else await testTypesafeKey(apiKey);
      send(res, 200, { ok: true });
    } catch (e) { send(res, 200, { ok: false, error: e.message }); }
  });
}
