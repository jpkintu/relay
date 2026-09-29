import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadOnce } from './lazy';

function browser() {
  const store = new Map<string, string>();
  const reload = vi.fn();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { location: { reload } });
  return { reload };
}

describe('loadOnce (charts and maps after a new deploy)', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('loads once and shares the result', async () => {
    browser();
    const load = vi.fn().mockResolvedValue('plotly');
    const get = loadOnce(load);
    expect(await get()).toBe('plotly');
    expect(await get()).toBe('plotly');
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a file gone after a deploy reloads the page once, then reports the error', async () => {
    const { reload } = browser();
    const missing = new TypeError('Failed to fetch dynamically imported module');
    const load = vi.fn().mockRejectedValue(missing);
    const get = loadOnce(load);
    // First failure: reload (the promise waits for the new page).
    const first = get();
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    void first;
    // Within a minute it fails for real, and is tried again (not cached).
    await expect(get()).rejects.toBe(missing);
    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
