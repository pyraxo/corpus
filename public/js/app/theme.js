// Light and dark.
import { prefs, savePrefs } from '../core/prefs.js';
import { ui } from '../core/state.js';
import { renderSettings } from '../views/settings.js';

export function toggleTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  savePrefs({ theme: dark ? 'light' : 'dark' });
  if (ui.view === 'settings') renderSettings();
}
