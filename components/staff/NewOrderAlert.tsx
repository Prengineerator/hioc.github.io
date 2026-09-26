'use client';

/**
 * Banner shown while newly-arrived orders sit unacknowledged in "received".
 * The alarm itself now plays from the staff shell (components/staff/
 * StaffShell.tsx) on EVERY staff page, so leaving Orders for New order or
 * Tables no longer silences it; this banner only reports the count, plus a
 * hint when the browser hasn't allowed sound yet.
 */
export function NewOrderAlert({ count, soundReady }: { count: number; soundReady: boolean }) {
  if (count <= 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center gap-2 rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream shadow-sm"
    >
      <span aria-hidden="true">🔔</span>
      <span>
        {count} new order{count === 1 ? '' : 's'} waiting — Accept or Reject to clear
        {!soundReady ? ' · tap anywhere to allow the alarm sound' : ''}
      </span>
    </div>
  );
}
