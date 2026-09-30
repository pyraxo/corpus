// Installing Corpus as an app, and the service worker for offline reading.
import { ui } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { renderSettings } from '../views/settings.js';

let installPrompt = null;
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export async function installApp() {
  if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice.catch(() => {}); installPrompt = null; if (ui.view === 'settings') renderSettings(); return; }
  toast(isIOS ? 'In Safari: Share → Add to Home Screen' : 'Use your browser menu → Install app / Add to Home screen');
}
export function installRow(row) {
  if (isStandalone()) return row('App', 'Running as an installed app.', '<span class="mono small">installed</span>');
  const how = installPrompt ? 'Install Corpus as an app on this device.' : isIOS ? 'In Safari, tap Share, then <strong>Add to Home Screen</strong>.' : 'Use your browser’s menu → <strong>Install app</strong> (or Add to Home screen).';
  return row('Install app', how, installPrompt ? '<button class="primary" data-install>Install</button>' : '');
}

// Listeners this module needs; main.js installs them once, in the order the app has always had.
export function setupPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (ui.view === 'settings') renderSettings(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; toast('Installed'); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(reg => reg.active?.postMessage('cache-shell')).catch(() => {});
  }
}
