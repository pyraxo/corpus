// Per-device preferences (theme, layout, reader size…), kept in localStorage.
export const defaults = { theme: 'system', layout: 'wall', density: 'comfortable', sort: 'bookmarked', readerSize: 'm', showSensitive: false, inboxWindow: 'all', inboxSort: 'bookmarked', inboxFormat: 'all', inboxTopic: '', openIn: 'reader' };
export const prefStorage = (() => { try { const k = '__corpus'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; } catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; } })();
export const prefs = { ...defaults, ...safeJSON(prefStorage.getItem('corpus.prefs')) };
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
export function savePrefs(patch) { Object.assign(prefs, patch); prefStorage.setItem('corpus.prefs', JSON.stringify(prefs)); applyPrefs(); }
export function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme; else root.dataset.theme = prefs.theme;
  root.dataset.density = prefs.density;
  root.dataset.reader = prefs.readerSize;
}
