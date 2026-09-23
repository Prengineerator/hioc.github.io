'use client';

// CC-3 / CC-D5 — a manager or owner excusing one staffer's cash count for
// their next clock-in or clock-out, with a mandatory reason (logged, visible
// to the owner). Rendered on the attendance page only when the server has
// already decided the signed-in account is manager/owner (see
// app/staff/attendance/page.tsx) — this component doesn't re-derive role.
//
// The staffer picker reuses /api/leave/team (LEAVE-2's team roster — every
// manager can already reach it, and its rows carry the real user_id the
// override API needs). If that ever 403s for some account this one can't
// happen to, or returns nobody, this falls back to a free-text id field
// rather than leaving a manager with no way to grant an override at all.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MIN_OVERRIDE_REASON, overrideReasonProblem } from '@/lib/cash/counts';
import type { CreateOverrideBody, PunchType } from '@/lib/cash/counts';

interface StaffOption {
  id: string;
  name: string;
}

interface OverrideRaw {
  id?: string;
  userId?: string;
  user_id?: string;
  staffName?: string;
  name?: string;
  punchType?: PunchType;
  punch_type?: PunchType;
  reason: string;
  grantedByName?: string;
  granted_by_name?: string;
  expiresAt?: string;
  expires_at?: string;
  usedAt?: string | null;
  used_at?: string | null;
}

interface OverrideView {
  id: string;
  userId: string;
  staffName: string;
  punchType: PunchType;
  reason: string;
  grantedByName: string;
  expiresAt: string;
  usedAt: string | null;
}

// The GET response shape for /api/cash-counts/overrides isn't nailed down in
// the shared contract (only the POST body, CreateOverrideBody, is) — read it
// defensively under a few plausible field/wrapper spellings rather than
// assuming one.
function normalizeOverride(o: OverrideRaw): OverrideView {
  const userId = o.userId ?? o.user_id ?? '';
  const expiresAt = o.expiresAt ?? o.expires_at ?? '';
  return {
    id: o.id ?? `${userId}-${expiresAt}`,
    userId,
    staffName: o.staffName ?? o.name ?? '',
    punchType: (o.punchType ?? o.punch_type ?? 'in') as PunchType,
    reason: o.reason,
    grantedByName: o.grantedByName ?? o.granted_by_name ?? '',
    expiresAt,
    usedAt: o.usedAt ?? o.used_at ?? null,
  };
}

function extractList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.overrides)) return obj.overrides;
    if (Array.isArray(obj.rows)) return obj.rows;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

function formatExpiry(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!iso || Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60_000);
  return mins <= 1 ? 'in 1 min' : `in ${mins} min`;
}

export function CashOverridePanel() {
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffUnavailable, setStaffUnavailable] = useState(false);
  const [userId, setUserId] = useState('');
  const [punchType, setPunchType] = useState<PunchType>('in');
  const [reason, setReason] = useState('');
  const [overrides, setOverrides] = useState<OverrideView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadStaff = useCallback(async () => {
    try {
      const res = await fetch('/api/leave/team', { cache: 'no-store' });
      if (!res.ok) {
        setStaffUnavailable(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { rows?: { user_id: string; name: string }[] } | null;
      const options = (data?.rows ?? []).map((r) => ({ id: r.user_id, name: r.name }));
      setStaff(options);
      setStaffUnavailable(options.length === 0);
      if (options.length > 0) {
        setUserId((prev) => (prev && options.some((o) => o.id === prev) ? prev : options[0].id));
      }
    } catch {
      setStaffUnavailable(true);
    }
  }, []);

  const loadOverrides = useCallback(async () => {
    try {
      const res = await fetch('/api/cash-counts/overrides', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      setOverrides(extractList(data).map((o) => normalizeOverride(o as OverrideRaw)));
    } catch {
      /* keep last-known-good */
    }
  }, []);

  useEffect(() => {
    void loadStaff();
    void loadOverrides();
  }, [loadStaff, loadOverrides]);

  const reasonProblem = useMemo(() => overrideReasonProblem(reason), [reason]);

  async function grant() {
    setError('');
    setNotice('');
    if (!userId.trim()) {
      setError('Pick or enter who this is for.');
      return;
    }
    if (reasonProblem) {
      setError(reasonProblem);
      return;
    }
    setBusy(true);
    try {
      const body: CreateOverrideBody = { userId: userId.trim(), punchType, reason: reason.trim() };
      const res = await fetch('/api/cash-counts/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        setError((data.error as string) ?? 'Could not grant that override.');
        return;
      }
      setNotice('Override granted.');
      setReason('');
      await loadOverrides();
    } catch {
      setError('Network problem — please try again.');
    } finally {
      setBusy(false);
    }
  }

  const activeOverrides = overrides.filter(
    (o) => !o.usedAt && (!o.expiresAt || Date.parse(o.expiresAt) > Date.now()),
  );

  return (
    <section className="mx-auto max-w-md px-4 pb-10">
      <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted">Excuse a cash count</h2>
      <p className="mt-1 text-xs text-muted">
        Lets one staffer skip counting for their next clock-in or clock-out. Logged and visible to the owner.
      </p>

      <div className="mt-3 rounded-md border border-[#e5e5e5] bg-white p-4">
        {staff.length > 0 && !staffUnavailable ? (
          <label className="block text-sm">
            <span className="text-charcoal">Staffer</span>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={busy}
              className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none disabled:bg-[#f6efe9]"
            >
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block text-sm">
            <span className="text-charcoal">Staff login ID</span>
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Their login ID"
              disabled={busy}
              className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none disabled:bg-[#f6efe9]"
            />
          </label>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setPunchType('in')}
            disabled={busy}
            className={`min-h-[44px] rounded-md border px-3 py-2.5 text-sm font-bold transition-colors disabled:opacity-50 ${
              punchType === 'in' ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] text-charcoal'
            }`}
          >
            Clock in
          </button>
          <button
            type="button"
            onClick={() => setPunchType('out')}
            disabled={busy}
            className={`min-h-[44px] rounded-md border px-3 py-2.5 text-sm font-bold transition-colors disabled:opacity-50 ${
              punchType === 'out' ? 'border-charcoal bg-charcoal text-cream' : 'border-[#ddd] text-charcoal'
            }`}
          >
            Clock out
          </button>
        </div>

        <label className="mt-3 block text-sm">
          <span className="text-charcoal">
            Reason <span className="text-muted">(at least {MIN_OVERRIDE_REASON} characters)</span>
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            disabled={busy}
            placeholder="e.g. drawer already counted at handover"
            className="mt-1 w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-sm focus:border-tan focus:outline-none disabled:bg-[#f6efe9]"
          />
        </label>

        <button
          type="button"
          onClick={grant}
          disabled={busy}
          className="mt-3 min-h-[44px] w-full rounded-md bg-tan px-4 py-2.5 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50"
        >
          {busy ? 'Granting…' : 'Grant override'}
        </button>

        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-green-700">{notice}</p> : null}
      </div>

      {activeOverrides.length > 0 ? (
        <ul className="mt-4 divide-y divide-[#eee] rounded-md border border-[#e5e5e5] bg-white">
          {activeOverrides.map((o) => (
            <li key={o.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-bold text-charcoal">{o.staffName || o.userId}</span>
                <span className="text-xs text-muted">{o.punchType === 'in' ? 'clock in' : 'clock out'}</span>
              </div>
              <p className="mt-1 text-xs text-muted">{o.reason}</p>
              {o.expiresAt ? (
                <p className="mt-1 text-[11px] text-muted">Expires {formatExpiry(o.expiresAt)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
