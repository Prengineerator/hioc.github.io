'use client';

// "Send pickup reminder" for a Ready order — used on the live card and in the
// order detail. The 5-minute cooldown is enforced by the server; this only
// mirrors it (countdown on the button, "Reminded 3 min ago" underneath) so
// staff aren't invited to tap something that will bounce. The parent owns the
// request and the toast.

import { useEffect, useState } from 'react';
import {
  formatCountdown,
  formatReminderAgo,
  reminderCooldownRemaining,
} from '@/lib/notifications/pickupReminder';

export function PickupReminderButton({
  remindedAt,
  onRemind,
  className,
}: {
  remindedAt: string | null | undefined;
  onRemind: () => Promise<void>;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);

  // Tick only while there is something to count: the cooldown, then the "N min
  // ago" label once a minute. Idle Ready cards cost nothing.
  useEffect(() => {
    if (!remindedAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [remindedAt]);

  const remaining = reminderCooldownRemaining(remindedAt, now);
  const ago = formatReminderAgo(remindedAt, now);

  const tap = async (e: React.MouseEvent) => {
    // On a card this sits inside the tap-to-open-detail surface.
    e.stopPropagation();
    if (sending || remaining > 0) return;
    setSending(true);
    try {
      await onRemind();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={tap}
        disabled={sending || remaining > 0}
        className="min-h-[44px] w-full rounded-md border border-[#e5e5e5] bg-cream px-3 py-2 text-xs font-bold text-charcoal transition-colors hover:border-tan hover:text-tan disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-[#e5e5e5] disabled:hover:text-charcoal"
      >
        {sending
          ? 'Sending…'
          : remaining > 0
            ? `Remind again in ${formatCountdown(remaining)}`
            : 'Send pickup reminder'}
      </button>
      {ago ? <p className="mt-1 text-center text-[11px] text-muted">Reminded {ago}</p> : null}
    </div>
  );
}
