import { describe, expect, it } from 'vitest';
import { isMenuItemAvailable } from '@/lib/menu/availability';

// Effective availability incl. 86/snooze auto-reenable (S6/C3), no cron.
const now = new Date('2026-07-15T06:30:00Z');

describe('isMenuItemAvailable', () => {
  it('is available when manually available and not snoozed', () => {
    expect(isMenuItemAvailable({ is_available: true, unavailable_until: null }, now)).toBe(true);
  });

  it('is unavailable when manually turned off', () => {
    expect(isMenuItemAvailable({ is_available: false, unavailable_until: null }, now)).toBe(false);
  });

  it('is unavailable while inside a future snooze window', () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    expect(isMenuItemAvailable({ is_available: true, unavailable_until: future }, now)).toBe(false);
  });

  it('auto-reenables once the snooze window has passed', () => {
    const past = new Date(now.getTime() - 60 * 1000).toISOString();
    expect(isMenuItemAvailable({ is_available: true, unavailable_until: past }, now)).toBe(true);
  });
});
