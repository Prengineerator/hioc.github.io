// Pickup-reminder rules shared by POST /api/orders/[id]/remind and the staff UI,
// so the server's cooldown and the countdown on the card cannot drift apart.
// Pure and dependency-free.

/** At most one reminder per order per this many seconds. */
export const PICKUP_REMINDER_COOLDOWN_SEC = 300;

/**
 * Whole seconds left before this order may be reminded again; 0 = allowed now.
 *
 * A timestamp in the future (a tablet clock ahead of the server's) is clamped to
 * the full cooldown rather than trusted: otherwise a skewed clock could lock an
 * order out of reminders for hours. An unparseable value counts as "never".
 */
export function reminderCooldownRemaining(
  remindedAt: string | null | undefined,
  nowMs: number,
): number {
  if (!remindedAt) return 0;
  const at = Date.parse(remindedAt);
  if (Number.isNaN(at)) return 0;
  const elapsedSec = Math.max(0, Math.floor((nowMs - at) / 1000));
  return Math.max(0, PICKUP_REMINDER_COOLDOWN_SEC - elapsedSec);
}

/** ISO cutoff: an order last reminded at or before this may be reminded now. */
export function reminderCutoffIso(nowMs: number): string {
  return new Date(nowMs - PICKUP_REMINDER_COOLDOWN_SEC * 1000).toISOString();
}

/** "just now" / "3 min ago" / "2 h ago" — '' when never reminded. */
export function formatReminderAgo(remindedAt: string | null | undefined, nowMs: number): string {
  if (!remindedAt) return '';
  const at = Date.parse(remindedAt);
  if (Number.isNaN(at)) return '';
  const mins = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}

/** "4:05" — a countdown for the button label. */
export function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
