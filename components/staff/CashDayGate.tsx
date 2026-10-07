'use client';

// The counter takes no orders until the cash day is in order (owner request
// 2026-10-07; rules in lib/cash/autoEnd.ts):
//   • a day left open past its 3:00 am end → count the drawer and close it;
//   • then, every day, no day open        → count the float and open today.
// Until then every POS screen shows the cash drawer instead, with a line on
// what to do. Clocking in, leave and the device / printer / settings pages stay
// usable (isGatedStaffPath).
//
// The staff layout passes the step it read on the server, so a fresh load
// never flashes the POS. After that the layout stays mounted across
// navigations, so the step is re-read here: when the cash screen opens or
// closes a day, when the window regains focus, every few minutes, and at the
// moment the open day ends — a counter left on overnight locks at 3:00 am.
// A failed read keeps the last step: the server fails open, never this.

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { CashDayManager } from '@/components/staff/CashDayManager';
import { isGatedStaffPath, type CashDayGateStep } from '@/lib/cash/autoEnd';

const RECHECK_MS = 5 * 60 * 1000;
// setTimeout's ceiling (~24.8 days); a later end is re-armed by the next check.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

interface GateStatus {
  step: CashDayGateStep;
  endsAt: string | null;
}

export function CashDayGate({
  initialStep,
  initialEndsAt,
  children,
}: {
  initialStep: CashDayGateStep;
  initialEndsAt: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const [status, setStatus] = useState<GateStatus>({ step: initialStep, endsAt: initialEndsAt });

  const recheck = useCallback(async () => {
    try {
      const res = await fetch('/api/cash-days/status', { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      setStatus({ step: body.step ?? null, endsAt: body.open_day?.ends_at ?? null });
    } catch {
      /* keep the last step */
    }
  }, []);

  useEffect(() => {
    const onFocus = () => void recheck();
    window.addEventListener('focus', onFocus);
    const t = setInterval(recheck, RECHECK_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(t);
    };
  }, [recheck]);

  // Lock the moment a running day ends, not up to five minutes later.
  useEffect(() => {
    if (status.step !== null || !status.endsAt) return;
    const wait = Date.parse(status.endsAt) - Date.now() + 1000;
    if (!Number.isFinite(wait) || wait > MAX_TIMEOUT_MS) return;
    const t = setTimeout(recheck, Math.max(0, wait));
    return () => clearTimeout(t);
  }, [status.step, status.endsAt, recheck]);

  if (status.step === null || !isGatedStaffPath(pathname)) return <>{children}</>;

  return (
    <div>
      <div
        role="status"
        className={
          'mx-auto mt-4 max-w-3xl rounded-md border px-4 py-3 text-sm ' +
          (status.step === 'close_overdue'
            ? 'border-red-200 bg-red-50 text-red-800'
            : 'border-tan bg-surface text-charcoal')
        }
      >
        {status.step === 'close_overdue' ? (
          <>
            <p className="font-bold">The last cash day was never closed.</p>
            <p className="mt-0.5">
              It ended on its own at 3:00 am. Count the drawer and close it below, then open today&apos;s day — the
              counter unlocks once today is open.
            </p>
          </>
        ) : (
          <>
            <p className="font-bold">Open today&apos;s cash day to start.</p>
            <p className="mt-0.5">Count the float in the drawer below. The counter unlocks once the day is open.</p>
          </>
        )}
      </div>
      <CashDayManager onDayChange={recheck} />
    </div>
  );
}
