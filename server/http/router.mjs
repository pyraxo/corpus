// A tiny router: routes are "METHOD /path/:param"; the first match wins.
export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    // The matching handler with its params, or null.
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    }
  };
}
