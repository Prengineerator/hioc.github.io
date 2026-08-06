'use client';

// ATT-1 / ATT-2 / ATT-4 — the staffer's whole attendance surface: one big
// button, an honest error when the punch is refused, and their own hours.
//
// Design stance: this screen is used at the start and end of a shift, often
// one-handed, often on a cracked phone in a hurry. So the primary action is a
// single large target, the state is legible at a glance, and every failure says
// what to DO next rather than what went wrong.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { AttendanceSession } from '@/lib/types';

interface DayRow {
  date: string;
  minutes: number;
  sessions: number;
  needsApproval: boolean;
  edited: boolean;
}

interface MeResponse {
  open: AttendanceSession | null;
  days: DayRow[];
  today: DayRow;
  totals: {
    weekMinutes: number;
    monthMinutes: number;
    monthDaysPresent: number;
    needsApprovalDays: number;
  };
  configured: boolean;
}

const CONSENT_KEY = 'hioc.attendance.locationNoticeAck.v1';

function formatHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatIstTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

function formatIstDate(date: string): string {
  // `date` is already an IST business date (YYYY-MM-DD); render it without
  // re-crossing a timezone, which would shift it by a day.
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Reads a fresh position.
 *
 * `maximumAge: 0` asks the browser not to hand back a cached fix — the server
 * still enforces staleness itself, because this is a request to the client, not
 * a guarantee from it.
 */
function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20_000,
    });
  });
}

function geolocationHelp(code: number | 'unsupported'): string {
  if (code === 'unsupported') {
    return "This browser can't share location. Open the staff site in Chrome or Safari to mark attendance.";
  }
  if (code === 1) {
    return "Location is blocked for this site. On iPhone: Settings → Safari → Location. On Android: tap the lock icon in the address bar → Permissions → Location → Allow. Then try again.";
  }
  if (code === 2) {
    return "Your device couldn't work out where it is. Step near a window or just outside, then try again.";
  }
  return 'Getting your location took too long. Try again.';
}

export function AttendancePunch() {
  const [state, setState] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showConsent, setShowConsent] = useState(false);
  const [elapsed, setElapsed] = useState('');
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/attendance/me', { cache: 'no-store' });
      if (!res.ok) return;
      setState((await res.json()) as MeResponse);
    } catch {
      /* keep last-known-good */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setShowConsent(window.localStorage.getItem(CONSENT_KEY) === null);
  }, []);

  // Running shift timer.
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    const openAt = state?.open?.clock_in_at;
    if (!openAt) {
      setElapsed('');
      return;
    }
    const tick = () => {
      const mins = Math.max(0, Math.floor((Date.now() - Date.parse(openAt)) / 60_000));
      setElapsed(formatHm(mins));
    };
    tick();
    tickRef.current = setInterval(tick, 30_000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [state?.open?.clock_in_at]);

  const acknowledgeConsent = () => {
    window.localStorage.setItem(CONSENT_KEY, new Date().toISOString());
    setShowConsent(false);
  };

  async function punch(type: 'in' | 'out') {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      let position: GeolocationPosition;
      try {
        position = await getPosition();
      } catch (err) {
        const code = (err as GeolocationPositionError)?.code;
        setError(geolocationHelp(typeof code === 'number' ? code : 'unsupported'));
        return;
      }

      // Raw readings only. The server computes distance and decides — this
      // component has no idea where the cafe is or how wide the fence is, and
      // that is deliberate.
      const res = await fetch('/api/attendance/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy_m: position.coords.accuracy,
          fix_age_ms: Math.max(0, Date.now() - position.timestamp),
        }),
      });

      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setError((data.error as string) ?? 'That did not work. Please try again.');
        return;
      }

      if (data.alreadyOpen) {
        setNotice("You were already clocked in — that shift is still running.");
      } else if (type === 'in') {
        const at = (data.session as AttendanceSession)?.clock_in_at;
        setNotice(`Clocked in at ${at ? formatIstTime(at) : 'now'}.`);
      } else {
        const s = data.session as AttendanceSession;
        const mins =
          s?.clock_out_at && s?.clock_in_at
            ? Math.round((Date.parse(s.clock_out_at) - Date.parse(s.clock_in_at)) / 60_000)
            : 0;
        setNotice(`Clocked out at ${s?.clock_out_at ? formatIstTime(s.clock_out_at) : 'now'} — ${formatHm(mins)} this shift.`);
      }
      await load();
    } catch {
      setError('Network problem — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-md px-4 py-16 text-center text-muted">Loading…</div>;
  }

  const open = state?.open ?? null;

  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-2xl font-bold text-charcoal">Attendance</h1>

      {showConsent ? (
        <div className="mt-4 rounded-md border border-[#e5e5e5] bg-white p-4 text-sm text-charcoal">
          <p className="font-bold">Before you start</p>
          <p className="mt-2 text-muted">
            When you tap Clock in or Clock out, we read your location <strong>at that
            moment only</strong> — to confirm you&apos;re at the cafe. We don&apos;t track you
            between punches, during your shift, or when you&apos;re off. The owner sees how far
            from the cafe each punch was.
          </p>
          <p className="mt-2 text-muted">
            You can see your own record below at any time.{' '}
            <Link href="/privacy" className="text-tan underline">
              Full privacy policy
            </Link>
            .
          </p>
          <button
            type="button"
            onClick={acknowledgeConsent}
            className="mt-3 w-full rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream"
          >
            Got it
          </button>
        </div>
      ) : null}

      {state && !state.configured ? (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          The cafe&apos;s location hasn&apos;t been set up yet, so attendance can&apos;t be
          marked. Ask the owner to set it in Settings.
        </div>
      ) : null}

      <div className="mt-6 rounded-md border border-[#e5e5e5] bg-white p-6 text-center">
        {open ? (
          <>
            <p className="text-xs uppercase tracking-[0.2em] text-muted">On shift</p>
            <p className="mt-2 text-4xl font-bold text-charcoal">{elapsed || '0m'}</p>
            <p className="mt-1 text-sm text-muted">
              since {formatIstTime(open.clock_in_at)}
            </p>
          </>
        ) : (
          <>
            <p className="text-xs uppercase tracking-[0.2em] text-muted">Not clocked in</p>
            <p className="mt-2 text-sm text-muted">
              {state?.today.minutes ? `${formatHm(state.today.minutes)} so far today` : 'No hours yet today'}
            </p>
          </>
        )}

        <button
          type="button"
          disabled={busy || (state ? !state.configured : false)}
          onClick={() => punch(open ? 'out' : 'in')}
          className={`mt-6 w-full rounded-md px-6 py-5 text-lg font-bold text-cream transition-colors disabled:opacity-50 ${
            open ? 'bg-charcoal hover:bg-black' : 'bg-tan hover:bg-tan-dark'
          }`}
        >
          {busy ? 'Checking your location…' : open ? 'Clock out' : 'Clock in'}
        </button>
      </div>

      {error ? (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>
      ) : null}

      {state ? (
        <>
          <div className="mt-8 grid grid-cols-3 gap-3 text-center">
            <Stat label="This week" value={formatHm(state.totals.weekMinutes)} />
            <Stat label="This month" value={formatHm(state.totals.monthMinutes)} />
            <Stat label="Days present" value={String(state.totals.monthDaysPresent)} />
          </div>

          {state.totals.needsApprovalDays > 0 ? (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {state.totals.needsApprovalDays === 1 ? '1 day is' : `${state.totals.needsApprovalDays} days are`}{' '}
              waiting for the owner to confirm — usually a missed clock-out. Those hours
              aren&apos;t counted yet.
            </p>
          ) : null}

          <h2 className="mt-8 text-sm font-bold uppercase tracking-[0.15em] text-muted">Recent days</h2>
          {state.days.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No attendance recorded yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-[#eee] rounded-md border border-[#e5e5e5] bg-white">
              {state.days.slice(0, 14).map((d) => (
                <li key={d.date} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="text-charcoal">{formatIstDate(d.date)}</span>
                  <span className="flex items-center gap-2">
                    {d.edited ? (
                      <span className="rounded bg-[#f0ece7] px-2 py-0.5 text-[11px] text-muted">edited</span>
                    ) : null}
                    {d.needsApproval ? (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] text-amber-900">
                        needs approval
                      </span>
                    ) : null}
                    <span className="font-bold text-charcoal">{formatHm(d.minutes)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[#e5e5e5] bg-white px-2 py-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-muted">{label}</p>
      <p className="mt-1 text-lg font-bold text-charcoal">{value}</p>
    </div>
  );
}
