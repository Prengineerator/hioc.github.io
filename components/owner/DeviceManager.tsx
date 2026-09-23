'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { timeAgo } from '@/lib/utils/timeAgo';
import { readAutoPrintSettings } from '@/lib/staff/autoPrint';
import type { PosDevice, StoreSettings } from '@/lib/types';

// Owner CRUD for enrolled counter machines (DEV-2) and their defaults (DEV-3).
// Follows the TableManager pattern: a form, a list with per-row actions, all
// against /api/owner/devices (owner-gated, service-role writes).
//
// The one thing that is NOT like the other owner screens: enrolling acts on THIS
// browser. The secret is issued into a cookie on the machine making the request,
// so the copy has to be unambiguous about which machine is being named — an
// owner enrolling "Counter 1" from their laptop at home has just named their
// laptop, and nothing later in the flow would tell them.

// A three-state control (null = defer) needs three labelled options, and the
// label for `null` has to say what deferring actually gets you — "Use store
// setting" is useless if you can't see what the store setting is.
function TriStateSelect({
  label,
  value,
  inheritedLabel,
  onLabel,
  offLabel,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean | null;
  inheritedLabel: string;
  onLabel: string;
  offLabel: string;
  onChange: (v: boolean | null) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-bold uppercase tracking-wide text-muted">{label}</span>
      <select
        disabled={disabled}
        value={value === null ? 'inherit' : value ? 'on' : 'off'}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === 'inherit' ? null : v === 'on');
        }}
        className="rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan disabled:opacity-50"
      >
        <option value="inherit">{inheritedLabel}</option>
        <option value="on">{onLabel}</option>
        <option value="off">{offLabel}</option>
      </select>
    </label>
  );
}

export function DeviceManager() {
  const [devices, setDevices] = useState<PosDevice[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [storeAutoPrint, setStoreAutoPrint] = useState<{ kot: boolean; bill: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editName, setEditName] = useState('');
  const [confirmRevokeId, setConfirmRevokeId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/owner/devices', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load devices');
      setDevices(data.devices ?? []);
      setCurrentDeviceId(data.currentDeviceId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // What "use store setting" resolves to right now, so the option can say so.
  // Best-effort: a failed read just leaves the labels generic.
  useEffect(() => {
    fetch('/api/store-settings', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { settings?: StoreSettings } | null) => {
        if (data?.settings) setStoreAutoPrint(readAutoPrintSettings(data.settings));
      })
      .catch(() => {});
  }, []);

  async function handleEnroll(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to enroll this device');
      setNotice(
        data.renamedFrom
          ? `"${data.renamedFrom}" is now "${data.device.name}", with a new key.`
          : data.rekeyed
            ? `${data.device.name} has a new key. Any copy of the old one is now dead.`
            : `This machine is now enrolled as "${data.device.name}".`,
      );
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enroll this device');
    } finally {
      setSubmitting(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, okMsg: string) {
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/devices', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Update failed');
      setNotice(okMsg);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
      return false;
    }
  }

  const current = devices.find((d) => d.id === currentDeviceId) ?? null;
  const active = devices.filter((d) => !d.revoked_at);
  const revoked = devices.filter((d) => d.revoked_at);

  const kotInherit = storeAutoPrint
    ? `Use store setting (${storeAutoPrint.kot ? 'prints' : 'off'})`
    : 'Use store setting';
  const billInherit = storeAutoPrint
    ? `Use store setting (${storeAutoPrint.bill ? 'prints' : 'off'})`
    : 'Use store setting';

  return (
    <div className="flex flex-col gap-5">
      {/* Enroll — always acts on the machine you are using right now. */}
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-muted">
          {current ? 'This machine' : 'Enroll this machine'}
        </h2>
        {current ? (
          <p className="mb-4 text-sm text-charcoal">
            You are on <span className="font-bold">{current.name}</span>. Enrolling again gives this machine
            a new key — and a new name, if you type a different one. The old key stops working immediately.
          </p>
        ) : (
          <p className="mb-4 text-sm text-muted">
            Names the browser you are using right now — not another machine. Do this once per till, on the
            till itself. It stays enrolled for a year, through restarts.
          </p>
        )}
        <form onSubmit={handleEnroll} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-charcoal">Device name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              // On a machine that is already enrolled, re-entering its own name
              // is the ordinary case (re-keying), so show what that name is.
              placeholder={current?.name ?? 'Counter 1'}
              className="rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-charcoal px-5 py-2 text-sm font-bold text-cream transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Enrolling…' : current ? 'Re-enroll this machine' : 'Enroll this machine'}
          </button>
        </form>
        {error ? <p className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm font-medium text-[#2f6b38]">{notice}</p> : null}
      </div>

      {/* Enrolled devices + their defaults */}
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-muted">Enrolled devices</h2>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : active.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            No devices enrolled. The POS works exactly as it does today until you enroll one.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {active.map((d) => {
              const isThis = d.id === currentDeviceId;
              const editing = editingId === d.id;
              return (
                <li key={d.id} className="rounded-md border border-[#e5e5e5] bg-white p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {editing ? (
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={40}
                          className="w-40 rounded border border-[#d8d2c7] bg-white px-2 py-1 text-sm"
                        />
                      ) : (
                        <span className="font-bold text-charcoal">{d.name}</span>
                      )}
                      {isThis ? (
                        <span className="rounded-full bg-[#e3efe4] px-2 py-0.5 text-xs font-bold text-[#2f6b38]">
                          This machine
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3">
                      {editing ? (
                        <>
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = await patch(d.id, { name: editName.trim() }, 'Device renamed.');
                              if (ok) setEditingId('');
                            }}
                            className="text-sm font-bold text-charcoal hover:underline"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId('')}
                            className="text-sm font-medium text-muted hover:underline"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(d.id);
                            setEditName(d.name);
                          }}
                          className="text-sm font-medium text-charcoal hover:underline"
                        >
                          Rename
                        </button>
                      )}
                      {/* Two-step, because it cannot be undone: re-enrolling is
                          the only way back and it has to happen ON that machine. */}
                      {confirmRevokeId === d.id ? (
                        <>
                          <button
                            type="button"
                            onClick={async () => {
                              await patch(
                                d.id,
                                { revoke: true },
                                `${d.name} revoked. That machine is now an ordinary browser.`,
                              );
                              setConfirmRevokeId('');
                            }}
                            className="text-sm font-bold text-red-700 hover:underline"
                          >
                            Confirm revoke
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId('')}
                            className="text-sm font-medium text-muted hover:underline"
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRevokeId(d.id)}
                          className="text-sm font-medium text-red-700 hover:underline"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>

                  {/* DEV-3 — defaults, not locks. Saved on change: there is one
                      value per control and no valid intermediate state, so a
                      Save button would only add a step to forget. */}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-bold uppercase tracking-wide text-muted">
                        Opens on
                      </span>
                      <select
                        value={d.default_order_type ?? 'inherit'}
                        onChange={(e) =>
                          patch(
                            d.id,
                            { default_order_type: e.target.value === 'inherit' ? null : e.target.value },
                            `${d.name} updated.`,
                          )
                        }
                        className="rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan"
                      >
                        <option value="inherit">No preference (dine-in)</option>
                        <option value="dine_in">Dine-in</option>
                        <option value="takeaway">Takeaway</option>
                      </select>
                    </label>
                    <TriStateSelect
                      label="Kitchen ticket"
                      value={d.auto_print_kot}
                      inheritedLabel={kotInherit}
                      onLabel="Always print"
                      offLabel="Never print"
                      onChange={(v) => patch(d.id, { auto_print_kot: v }, `${d.name} updated.`)}
                    />
                    <TriStateSelect
                      label="Customer receipt"
                      value={d.auto_print_bill}
                      inheritedLabel={billInherit}
                      onLabel="Always print"
                      offLabel="Never print"
                      onChange={(v) => patch(d.id, { auto_print_bill: v }, `${d.name} updated.`)}
                    />
                  </div>

                  <p className="mt-3 text-xs text-muted">
                    Enrolled {new Date(d.enrolled_at).toLocaleDateString('en-IN')} · Last seen{' '}
                    {d.last_seen_at ? timeAgo(d.last_seen_at) : 'never'}
                  </p>
                </li>
              );
            })}
          </ul>
        )}

        {revoked.length > 0 ? (
          <div className="mt-5 border-t border-[#f2efe9] pt-4">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Revoked</h3>
            <ul className="flex flex-col gap-1 text-sm text-muted">
              {revoked.map((d) => (
                <li key={d.id}>
                  <span className="line-through">{d.name}</span> · revoked{' '}
                  {new Date(d.revoked_at as string).toLocaleDateString('en-IN')}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
