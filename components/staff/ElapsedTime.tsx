'use client';

// Live elapsed-time readout (R3/R4) — ticks every second so staff see exactly
// how long an order has been waiting / in its current stage, colour-coded so a
// slow order stands out. Self-contained (own 1s interval); cheap at board scale.

import { useEffect, useState } from 'react';

function format(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ElapsedTime({
  since,
  warnAfterMin,
  dangerAfterMin,
  prefix,
  className,
}: {
  since: string; // ISO timestamp to count from
  warnAfterMin?: number;
  dangerAfterMin?: number;
  prefix?: string;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secs = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const mins = secs / 60;
  const color =
    dangerAfterMin && mins >= dangerAfterMin
      ? 'text-red-600'
      : warnAfterMin && mins >= warnAfterMin
        ? 'text-amber-600'
        : '';

  return (
    <span className={`tabular-nums ${color} ${className ?? ''}`.trim()}>
      {prefix}
      {format(secs)}
    </span>
  );
}
