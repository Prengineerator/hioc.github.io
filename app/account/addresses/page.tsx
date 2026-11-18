'use client';

// Account → Addresses (docs/SHOP-V2-SPEC.md E3). The saved-address book the shop
// checkout preselects from: a card per address with Edit, Delete (asks first) and
// Make default (not shown on the default, which wears a "Default" badge). Works
// with the shop flag off — the book belongs to the account, not the shop.
//
// Talks to /api/account/addresses (GET/POST), /[id] (PATCH/DELETE) and
// /[id]/default (POST). After every change it re-reads the list, so the server's
// choice of new default after a delete is what the page shows. The 10-address
// limit is shown inline (before the form opens, and again if the API says 409).

import { useCallback, useEffect, useState } from 'react';
import { AddressCard } from '@/components/shop/AddressCard';
import { AddressForm, emptyAddressForm, focusAddressField, type FormValues } from '@/components/shop/AddressForm';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { ADDRESS_LIMIT_MESSAGE, MAX_SAVED_ADDRESSES, canAddAddress, sortAddresses } from '@/lib/account/addressRules';
import type { CustomerAddress } from '@/lib/shop/types';

const FORM_ID = 'saved-address';
const FIELDS = ['customer_name', 'phone', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pincode'] as const;

type FieldError = { field: string; error: string };

export default function AddressesPage() {
  const [addresses, setAddresses] = useState<CustomerAddress[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // The form modal: null = closed, 'new' = adding, otherwise the address being edited.
  const [editing, setEditing] = useState<CustomerAddress | 'new' | null>(null);
  const [values, setValues] = useState<FormValues>(emptyAddressForm());
  const [label, setLabel] = useState('Home');
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleting, setDeleting] = useState<CustomerAddress | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await fetch('/api/account/addresses', { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as { addresses?: CustomerAddress[]; error?: string };
      if (!res.ok || !data.addresses) {
        setLoadError(data.error ?? 'Could not load your addresses.');
        return;
      }
      setAddresses(sortAddresses(data.addresses));
    } catch {
      setLoadError('No connection. Check your internet and try again.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const count = addresses?.length ?? 0;
  const canAdd = canAddAddress(count);

  function openForm(target: CustomerAddress | 'new') {
    setNotice('');
    setFieldError(null);
    setFormError('');
    if (target === 'new') {
      setValues(emptyAddressForm());
      setLabel(count === 0 ? 'Home' : 'Work');
    } else {
      const { customer_name, phone, address_line1, address_line2, landmark, city, state, pincode } = target;
      setValues(emptyAddressForm({ customer_name, phone, address_line1, address_line2, landmark, city, state, pincode }));
      setLabel(target.label);
    }
    setEditing(target);
  }

  function closeForm() {
    if (!saving) setEditing(null);
  }

  async function save() {
    if (!editing || saving) return;
    setFieldError(null);
    setFormError('');
    setSaving(true);
    try {
      const body: Record<string, string> = { label };
      for (const f of FIELDS) body[f] = values[f] ?? '';
      const isNew = editing === 'new';
      const res = await fetch(isNew ? '/api/account/addresses' : `/api/account/addresses/${editing.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
      if (!res.ok) {
        if (res.status === 409) setFormError(ADDRESS_LIMIT_MESSAGE);
        else if (data.field) {
          setFieldError({ field: data.field, error: data.error ?? 'Check this field' });
          focusAddressField(FORM_ID, data.field);
        } else setFormError(data.error ?? 'Could not save this address. Please try again.');
        return;
      }
      setEditing(null);
      setNotice(isNew ? 'Address saved.' : 'Address updated.');
      await load();
    } catch {
      setFormError('No connection. Check your internet and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(a: CustomerAddress) {
    setNotice('');
    setBusyId(a.id);
    try {
      const res = await fetch(`/api/account/addresses/${a.id}/default`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(data.error ?? 'Could not change your default address.');
        return;
      }
      setNotice(`${a.label} is now your default address.`);
      await load();
    } catch {
      setNotice('No connection. Check your internet and try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    const a = deleting;
    if (!a) return;
    setBusyId(a.id);
    try {
      const res = await fetch(`/api/account/addresses/${a.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(data.error ?? 'Could not delete this address.');
      } else {
        setNotice('Address deleted.');
        await load();
      }
    } catch {
      setNotice('No connection. Check your internet and try again.');
    } finally {
      setBusyId(null);
      setDeleting(null);
    }
  }

  const editingNew = editing === 'new';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Your addresses</h1>
          <p className="mt-1 text-sm text-muted">Saved addresses make checkout one tap. Past orders keep the address they went to.</p>
        </div>
        {addresses && addresses.length > 0 && canAdd ? (
          <Button onClick={() => openForm('new')}>Add address</Button>
        ) : null}
      </div>

      <div role="status" aria-live="polite">
        {notice ? <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-charcoal">{notice}</p> : null}
      </div>

      {addresses && !canAdd ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-charcoal">
          {ADDRESS_LIMIT_MESSAGE} ({count} of {MAX_SAVED_ADDRESSES} saved)
        </p>
      ) : null}

      {loadError ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-line bg-cream px-6 py-12 text-center">
          <p role="alert" className="text-sm text-charcoal">
            {loadError}
          </p>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : addresses === null ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading your addresses">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : addresses.length === 0 ? (
        <EmptyState
          icon=""
          heading="Save an address to check out in one tap"
          body="Add where you'd like your coffee delivered and we'll fill it in next time."
          action={<Button onClick={() => openForm('new')}>Add address</Button>}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {addresses.map((a) => (
            <li key={a.id}>
              <AddressCard address={a}>
                <Button variant="secondary" size="sm" onClick={() => openForm(a)} aria-label={`Edit ${a.label} address`}>
                  Edit
                </Button>
                {a.is_default ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void makeDefault(a)}
                    loading={busyId === a.id}
                    aria-label={`Make ${a.label} address the default`}
                  >
                    Make default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-700 hover:bg-red-50"
                  onClick={() => setDeleting(a)}
                  disabled={busyId === a.id}
                  aria-label={`Delete ${a.label} address`}
                >
                  Delete
                </Button>
              </AddressCard>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={editing !== null}
        onClose={closeForm}
        title={editingNew ? 'Add address' : 'Edit address'}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button onClick={() => void save()} loading={saving} fullWidth>
              {saving ? 'Saving…' : 'Save address'}
            </Button>
            <Button variant="secondary" onClick={closeForm} disabled={saving} fullWidth>
              Cancel
            </Button>
          </div>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          noValidate
        >
          <AddressForm
            idPrefix={FORM_ID}
            value={values}
            onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
            errors={fieldError}
            withLabel
            labelValue={label}
            onLabelChange={setLabel}
            disabled={saving}
          />
          {formError ? (
            <p role="alert" className="mt-4 text-sm font-semibold text-red-700">
              {formError}
            </p>
          ) : null}
          {/* Lets Enter submit from a field without adding a second visible button. */}
          <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
            Save
          </button>
        </form>
      </Modal>

      <Modal
        open={deleting !== null}
        onClose={() => (busyId ? undefined : setDeleting(null))}
        title="Delete this address?"
        size="sm"
        footer={
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button variant="danger" onClick={() => void confirmDelete()} loading={busyId !== null} fullWidth>
              Delete
            </Button>
            <Button variant="secondary" onClick={() => setDeleting(null)} disabled={busyId !== null} fullWidth>
              Keep it
            </Button>
          </div>
        }
      >
        <p className="text-sm text-charcoal">Delete this address? Past orders keep their address.</p>
      </Modal>
    </div>
  );
}
