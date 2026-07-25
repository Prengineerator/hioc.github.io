'use client';

import { useCallback, useEffect, useState } from 'react';

interface Permission {
  permission_key: string;
  min_role: 'staff' | 'manager';
  updated_by: string | null;
  updated_at: string;
}

// Owner-facing label + one-line hint per permission key.
const PERMISSION_META: Record<string, { label: string; hint: string }> = {
  pos_order_entry: { label: 'Take orders (POS)', hint: 'Punch in dine-in / takeaway orders at the counter' },
  settle_payment: { label: 'Settle payment', hint: 'Collect cash / UPI / card and close an order' },
  menu_edit: { label: 'Edit the menu', hint: 'Add, change, 86, or remove menu items' },
  cash_day_open: { label: 'Open the cash day', hint: 'Start the day with an opening float' },
  void_line: { label: 'Void a line', hint: 'Remove an item from an order (with a reason)' },
  comp_order: { label: 'Comp / settle at ₹0', hint: 'Waive a charge or settle at zero (with a reason)' },
  refund: { label: 'Issue a refund', hint: 'Refund a captured payment' },
  cash_day_close: { label: 'Close the cash day', hint: 'Count the drawer and sign off the day' },
};

const MIN_ROLE_OPTIONS: { value: 'staff' | 'manager'; label: string }[] = [
  { value: 'staff', label: 'Staff & up' },
  { value: 'manager', label: 'Manager & up' },
];

export function PermissionMatrix() {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/owner/permissions', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load permissions');
      setPermissions(data.permissions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load permissions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleChange(key: string, minRole: 'staff' | 'manager') {
    setError('');
    setNotice('');
    setSavingKey(key);
    try {
      const res = await fetch('/api/owner/permissions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission_key: key, min_role: minRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to update permission');
      const label = PERMISSION_META[key]?.label ?? key;
      setNotice(`"${label}" now needs ${minRole === 'manager' ? 'a manager' : 'staff'} and up.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update permission');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-muted">Permissions</h2>
      <p className="mb-4 text-sm text-muted">
        Choose who may perform each sensitive action. Changes take effect immediately. Owners always
        have every permission.
      </p>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : permissions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No permissions configured.</p>
      ) : (
        <div className="flex flex-col">
          {permissions.map((p) => {
            const meta = PERMISSION_META[p.permission_key];
            return (
              <div
                key={p.permission_key}
                className="flex flex-col gap-2 border-b border-[#f2efe9] py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <span className="font-medium text-charcoal">{meta?.label ?? p.permission_key}</span>
                  {meta?.hint ? <span className="block text-xs text-muted">{meta.hint}</span> : null}
                </div>
                <div
                  role="group"
                  aria-label={meta?.label ?? p.permission_key}
                  className="inline-flex shrink-0 overflow-hidden rounded-md border border-[#d8d2c7]"
                >
                  {MIN_ROLE_OPTIONS.map((opt) => {
                    const active = p.min_role === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={active}
                        disabled={savingKey === p.permission_key || active}
                        onClick={() => handleChange(p.permission_key, opt.value)}
                        className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                          active
                            ? 'bg-charcoal text-cream'
                            : 'bg-white text-charcoal hover:bg-[#f2efe9] disabled:opacity-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {error ? <p className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm font-medium text-[#2f6b38]">{notice}</p> : null}
    </div>
  );
}
