import { lazy, type ComponentType } from 'react';

const RELOAD_KEY = 'relay:chunk-reload';

// After a new deploy, an open copy of the app may ask for a file that no
// longer exists (every build names its files afresh). The page then reloads
// once to get the new version instead of crashing. A second failure within a
// minute is a real error and is thrown.
export function reloadForNewVersion(error: unknown): Promise<never> {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (navigator.onLine && Date.now() - last > 60000) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      window.location.reload();
      // Keep showing the loading state while the page reloads.
      return new Promise<never>(() => undefined);
    }
  } catch {
    // No sessionStorage: fall through and show the error.
  }
  return Promise.reject(error);
}

function loaded() {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // Private mode: nothing to clear.
  }
}

// A module loaded on first use (charts, maps), with the same recovery. A
// failed load is not kept, so a later call tries again.
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () =>
    (pending ??= load().then(
      (module) => {
        loaded();
        return module;
      },
      (error) => {
        pending = null;
        return reloadForNewVersion(error);
      },
    ));
}

// A screen loaded on first use, so each role downloads only its own screens.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyScreen<T extends ComponentType<any>>(load: () => Promise<T>) {
  return lazy(async () => {
    try {
      const component = await load();
      loaded();
      return { default: component };
    } catch (error) {
      return reloadForNewVersion(error);
    }
  });
}
