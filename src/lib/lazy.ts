import { lazy, type ComponentType } from 'react';

const RELOAD_KEY = 'relay:chunk-reload';

// A screen loaded on first use, so each role downloads only its own screens.
// After a new deploy, an open copy of the app may ask for a file that no
// longer exists; it then reloads once to get the new version instead of
// crashing. (A second failure within a minute is a real error.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyScreen<T extends ComponentType<any>>(load: () => Promise<T>) {
  return lazy(async () => {
    try {
      const component = await load();
      try {
        sessionStorage.removeItem(RELOAD_KEY);
      } catch {
        // Private mode: nothing to clear.
      }
      return { default: component };
    } catch (error) {
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
        if (navigator.onLine && Date.now() - last > 60000) {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
          window.location.reload();
          // Keep showing the loading screen while the page reloads.
          return new Promise<never>(() => undefined);
        }
      } catch {
        // No sessionStorage: fall through and show the error.
      }
      throw error;
    }
  });
}
