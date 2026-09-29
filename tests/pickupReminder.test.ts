import { describe, expect, it } from 'vitest';
import {
  PICKUP_REMINDER_COOLDOWN_SEC,
  formatCountdown,
  formatReminderAgo,
  reminderCooldownRemaining,
  reminderCutoffIso,
} from '@/lib/notifications/pickupReminder';

const now = Date.parse('2026-09-29T10:00:00.000Z');
const ago = (sec: number) => new Date(now - sec * 1000).toISOString();

describe('reminderCooldownRemaining', () => {
  it('is 0 when never reminded', () => {
    expect(reminderCooldownRemaining(null, now)).toBe(0);
    expect(reminderCooldownRemaining(undefined, now)).toBe(0);
  });
  it('counts down from 5 minutes', () => {
    expect(PICKUP_REMINDER_COOLDOWN_SEC).toBe(300);
    expect(reminderCooldownRemaining(ago(0), now)).toBe(300);
    expect(reminderCooldownRemaining(ago(120), now)).toBe(180);
    expect(reminderCooldownRemaining(ago(299), now)).toBe(1);
  });
  it('is 0 at exactly 5 minutes and after', () => {
    expect(reminderCooldownRemaining(ago(300), now)).toBe(0);
    expect(reminderCooldownRemaining(ago(3600), now)).toBe(0);
  });
  it('clamps a future timestamp (clock skew) to the full cooldown', () => {
    expect(reminderCooldownRemaining(new Date(now + 3_600_000).toISOString(), now)).toBe(300);
  });
  it('treats garbage as never reminded', () => {
    expect(reminderCooldownRemaining('nope', now)).toBe(0);
  });
});

describe('reminderCutoffIso', () => {
  it('is exactly the cooldown before now', () => {
    expect(reminderCutoffIso(now)).toBe(ago(300));
  });
});

describe('formatReminderAgo', () => {
  it('reads naturally', () => {
    expect(formatReminderAgo(null, now)).toBe('');
    expect(formatReminderAgo(ago(20), now)).toBe('just now');
    expect(formatReminderAgo(ago(180), now)).toBe('3 min ago');
    expect(formatReminderAgo(ago(59 * 60), now)).toBe('59 min ago');
    expect(formatReminderAgo(ago(2 * 3600 + 60), now)).toBe('2 h ago');
  });
});

describe('formatCountdown', () => {
  it('formats m:ss', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(0.2)).toBe('0:01');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});
