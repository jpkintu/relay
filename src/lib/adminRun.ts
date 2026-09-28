import { useCallback } from 'react';
import Parse from '../parse';
import { usePin } from './pin';

export const isAdminLocked = (error: unknown) =>
  error instanceof Error && /Admin is locked/.test(error.message);

// Runs an Admin-area Cloud function (settings, branding, payment keys…).
// If Admin has locked itself (15 minutes unused), asks for the PIN, opens it
// again and retries once. Other errors are passed on.
export function useAdminRun() {
  const withPin = usePin();
  return useCallback(
    async <T>(name: string, params: Record<string, unknown> = {}): Promise<T> => {
      try {
        return await Parse.Cloud.run(name, params);
      } catch (error) {
        if (!isAdminLocked(error)) throw error;
        const opened = await withPin(
          'Open Admin',
          (pin) => Parse.Cloud.run('unlockAdmin', { pin }),
          'Settings, payment keys and records need your PIN again.',
        );
        if (!opened) throw error;
        return Parse.Cloud.run(name, params);
      }
    },
    [withPin],
  );
}
