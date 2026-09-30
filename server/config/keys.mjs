// Lets API keys be viewed and changed from Settings instead of only the .env file.
// A key saved here overrides whatever env.mjs loaded from .env, for this process.
import { readState, writeState } from '../library/state.mjs';

export const KEY_NAMES = ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY'];
const baseEnv = {}; // the value env.mjs loaded at boot, kept so clearing an override can restore it

export async function initKeys() {
  for (const name of KEY_NAMES) baseEnv[name] = process.env[name] || '';
  const { settings } = await readState();
  for (const name of KEY_NAMES) if (settings.keys?.[name]) process.env[name] = settings.keys[name];
}

export async function keysStatus() {
  const { settings } = await readState();
  const keys = settings.keys || {};
  return Object.fromEntries(KEY_NAMES.map(name => {
    const value = keys[name] || baseEnv[name] || '';
    return [name, { set: !!value, source: keys[name] ? 'saved' : value ? 'env' : 'none', last4: value ? value.slice(-4) : null }];
  }));
}

export async function setKey(name, value) {
  if (!KEY_NAMES.includes(name)) throw new Error('Unknown key');
  value = String(value || '').trim();
  await writeState((st) => {
    st.settings.keys = { ...(st.settings.keys || {}) };
    if (value) st.settings.keys[name] = value; else delete st.settings.keys[name];
  });
  process.env[name] = value || baseEnv[name] || '';
}
