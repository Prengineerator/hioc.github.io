'use client';

// Who carries a warehouse transfer (docs/WAREHOUSE-SPEC.md, WH-D3): a team
// member from the list, or "Someone else" — a driver or helper without a
// login — by name and (optionally) phone. Used by the owner's Warehouse page
// and the staff Stock screen, for assigning a request and for sending a
// return. The API validates the same way (lib/inventory/warehouse.ts
// parseDeliverer); this only builds the body.

import { useState } from 'react';
import { inputBase, inputClass, type PersonRef } from '@/components/staff/inventory/client';

export type DelivererChoice =
  | { assigneeId: string }
  | { deliverer: { name: string; phone: string } };

const OUTSIDE = '__outside__';

export function delivererLabel(r: { assignedTo: PersonRef | null; deliverer: { name: string; phone: string } | null }): string {
  if (r.assignedTo) return r.assignedTo.name;
  if (r.deliverer) return r.deliverer.phone ? `${r.deliverer.name} (${r.deliverer.phone})` : r.deliverer.name;
  return '';
}

/**
 * Controlled by the parent through `onChange`, which gets the body fragment to
 * send, or null while the choice is incomplete (nothing picked, or "Someone
 * else" with no name yet).
 */
export function DelivererPicker({
  people,
  initial,
  disabled,
  onChange,
  idPrefix,
}: {
  people: PersonRef[];
  initial?: { assigneeId?: string | null; name?: string; phone?: string };
  disabled?: boolean;
  onChange: (choice: DelivererChoice | null) => void;
  idPrefix: string;
}) {
  const [who, setWho] = useState<string>(initial?.assigneeId ?? (initial?.name ? OUTSIDE : ''));
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');

  function emit(nextWho: string, nextName: string, nextPhone: string) {
    if (nextWho === OUTSIDE) onChange(nextName.trim().length >= 2 ? { deliverer: { name: nextName.trim(), phone: nextPhone.trim() } } : null);
    else onChange(nextWho ? { assigneeId: nextWho } : null);
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm" htmlFor={`${idPrefix}-who`}>
        <span className="text-charcoal">Who delivers it</span>
      </label>
      <select
        id={`${idPrefix}-who`}
        className={`${inputBase} w-full`}
        value={who}
        disabled={disabled}
        onChange={(e) => {
          setWho(e.target.value);
          emit(e.target.value, name, phone);
        }}
      >
        <option value="">Choose…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value={OUTSIDE}>Someone else (no login) …</option>
      </select>
      {who === OUTSIDE ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input
              value={name}
              disabled={disabled}
              onChange={(e) => {
                setName(e.target.value);
                emit(who, e.target.value, phone);
              }}
              className={`${inputClass} mt-1`}
              placeholder="e.g. Ravi (driver)"
              maxLength={60}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Phone (optional)</span>
            <input
              value={phone}
              disabled={disabled}
              inputMode="tel"
              onChange={(e) => {
                setPhone(e.target.value);
                emit(who, name, e.target.value);
              }}
              className={`${inputClass} mt-1`}
              placeholder="98765 43210"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
