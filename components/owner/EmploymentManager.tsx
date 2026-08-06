'use client';

// SHEET-4 — salary and shift, per person, effective-dated.
//
// There is no "edit" button here, and that is the design. A change writes a NEW
// record starting on a date you choose, and the old one closes the day before.
// Editing a rate in place would silently restate what an earlier month was paid
// at — which is the kind of thing nobody notices until someone disputes a
// payslip and the evidence has already been overwritten.

import { useCallback, useEffect, useState } from 'react';
import type { StaffEmployment } from '@/lib/types';

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function EmploymentManager() {
  const [members, setMembers] = useState<Member[]>([]);
  const [records, setRecords] = useState<StaffEmployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [openFor, setOpenFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Both owner-only. Fetched here rather than passed down so this panel can
      // be dropped anywhere on the owner surface without threading props.
      const [recRes, memRes] = await Promise.all([
        fetch('/api/owner/employment', { cache: 'no-store' }),
        fetch('/api/owner/staff', { cache: 'no-store' }),
      ]);
      if (recRes.ok) setRecords((await recRes.json()).records as StaffEmployment[]);
      if (memRes.ok) setMembers((await memRes.json()).members as Member[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentFor = (userId: string) =>
    records.find((r) => r.user_id === userId && r.effective_to === null) ?? null;

  if (loading) return <p className="text-sm text-muted">Loading salary records…</p>;

  return (
    <section className="rounded-md border border-[#e5e5e5] bg-white p-5">
      <h2 className="text-lg font-bold text-charcoal">Salary &amp; shifts</h2>
      <p className="mt-1 text-sm text-muted">
        Used to work out pay from hours actually worked, and to know when a shift should have
        ended. Only you can see this.
      </p>

      <ul className="mt-4 divide-y divide-[#f0f0f0]">
        {members.map((m) => {
          const current = currentFor(m.id);
          const history = records.filter((r) => r.user_id === m.id && r.effective_to !== null);
          return (
            <li key={m.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-bold text-charcoal">{m.name || m.email}</p>
                  {current ? (
                    <p className="text-sm text-muted">
                      ₹{current.monthly_salary_inr.toLocaleString('en-IN')}/month ·{' '}
                      {Number(current.contracted_hours_per_day)}h ·{' '}
                      {current.shift_start_time.slice(0, 5)}–{current.shift_end_time.slice(0, 5)} ·{' '}
                      {current.weekly_off_dow === null ? 'no weekly off' : `off ${DOW[current.weekly_off_dow]}`}
                      <span className="ml-2 text-xs">from {current.effective_from}</span>
                    </p>
                  ) : (
                    <p className="text-sm text-red-700">
                      Not set up — payroll can&apos;t compute for this person.
                    </p>
                  )}
                  {history.length ? (
                    <p className="mt-0.5 text-xs text-muted">
                      {history.length} earlier {history.length === 1 ? 'record' : 'records'} kept for
                      past months
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setOpenFor(openFor === m.id ? null : m.id)}
                  className="rounded-md border border-charcoal px-3 py-1.5 text-sm font-bold text-charcoal"
                >
                  {current ? 'Change' : 'Set up'}
                </button>
              </div>

              {openFor === m.id ? (
                <EmploymentForm
                  userId={m.id}
                  current={current}
                  onSaved={() => {
                    setOpenFor(null);
                    void load();
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EmploymentForm({
  userId,
  current,
  onSaved,
}: {
  userId: string;
  current: StaffEmployment | null;
  onSaved: () => void;
}) {
  const [salary, setSalary] = useState(String(current?.monthly_salary_inr ?? ''));
  const [hours, setHours] = useState(String(current ? Number(current.contracted_hours_per_day) : 9));
  const [start, setStart] = useState(current?.shift_start_time.slice(0, 5) ?? '10:00');
  const [end, setEnd] = useState(current?.shift_end_time.slice(0, 5) ?? '19:00');
  const [off, setOff] = useState(current?.weekly_off_dow === null || current === null ? '' : String(current.weekly_off_dow));
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 8) + '01');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/owner/employment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          monthly_salary_inr: Number(salary),
          contracted_hours_per_day: Number(hours),
          shift_start_time: start,
          shift_end_time: end,
          weekly_off_dow: off === '' ? null : Number(off),
          effective_from: from,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body.error as string) ?? 'Could not save.');
        return;
      }
      onSaved();
    } catch {
      setError('Network problem — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-[#e5e5e5] bg-[#faf7f4] p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Monthly salary (₹)">
          <input
            type="number"
            inputMode="numeric"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            className="w-full rounded-md border border-[#ddd] px-3 py-2"
          />
        </Field>
        <Field label="Hours per day">
          <input
            type="number"
            step="0.5"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="w-full rounded-md border border-[#ddd] px-3 py-2"
          />
        </Field>
        <Field label="Weekly off">
          <select
            value={off}
            onChange={(e) => setOff(e.target.value)}
            className="w-full rounded-md border border-[#ddd] px-3 py-2"
          >
            <option value="">None</option>
            {DOW.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Shift starts">
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full rounded-md border border-[#ddd] px-3 py-2"
          />
        </Field>
        <Field label="Shift ends">
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full rounded-md border border-[#ddd] px-3 py-2"
          />
        </Field>
        <Field label="Applies from">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full rounded-md border border-[#ddd] px-3 py-2"
          />
        </Field>
      </div>

      <p className="mt-2 text-xs text-muted">
        Shift times are used for late marks and to close a shift somebody forgot to end. Days
        before &ldquo;applies from&rdquo; keep whatever was in force then.
      </p>

      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}

      <button
        type="button"
        disabled={busy}
        onClick={save}
        className="mt-3 rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-bold text-charcoal">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
