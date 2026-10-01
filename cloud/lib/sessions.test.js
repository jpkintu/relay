import { describe, expect, test } from 'vitest';
import { expired, sessionDays, DAY } from './sessions.js';

describe('how long a sign-in lasts', () => {
  test('staff 30 days, the owner and finance 14', () => {
    expect(sessionDays('rider')).toBe(30);
    expect(sessionDays('cashier')).toBe(30);
    expect(sessionDays('admin')).toBe(14);
    expect(sessionDays('finance')).toBe(14);
    expect(sessionDays('platform')).toBe(1);
  });

  test('a session runs out after its days', () => {
    const now = Date.now();
    expect(expired(new Date(now - 13 * DAY), 'admin', now)).toBe(false);
    expect(expired(new Date(now - 15 * DAY), 'admin', now)).toBe(true);
    expect(expired(new Date(now - 15 * DAY), 'rider', now)).toBe(false);
    expect(expired(new Date(now - 31 * DAY), 'rider', now)).toBe(true);
  });
});
