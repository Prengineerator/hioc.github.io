'use client';

import { useCallback, useEffect, useState } from 'react';
import { MenuItemTable, type SnoozeDuration } from '@/components/staff/MenuItemTable';
import {
  MenuItemFormModal,
  type MenuItemFormValues,
} from '@/components/staff/MenuItemFormModal';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import { StoreControls } from '@/components/staff/StoreControls';
import { Spinner } from '@/components/ui/Spinner';
import type { MenuItem } from '@/lib/types';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Today's 24:00 IST ("end of day") expressed as a UTC ISO instant — mirrors
// the IST wall-clock convention in lib/store/hours.ts (that file's helpers
// are private, so this small piece is duplicated rather than exported).
function endOfDayIstIso(now: Date): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const mo = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const nextMidnightUtcMs = Date.UTC(y, mo, d + 1, 0, 0, 0) - IST_OFFSET_MS;
  return new Date(nextMidnightUtcMs).toISOString();
}

export default function StaffMenuPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; item: MenuItem } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<MenuItem | null>(null);

  const fetchItems = useCallback(async () => {
    const res = await fetch('/api/menu?includeUnavailable=true', {
      cache: 'no-store',
    });
    const data = await res.json();
    setItems(data.items ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // S6 86/snooze — see lib/menu/availability.ts for the semantics this
  // implements: a timed snooze keeps is_available true and sets
  // unavailable_until; an indefinite 86 just flips is_available off.
  async function handleSnooze(item: MenuItem, duration: SnoozeDuration) {
    const body =
      duration === 'indefinite'
        ? { is_available: false }
        : {
            is_available: true,
            unavailable_until:
              duration === '2h'
                ? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
                : endOfDayIstIso(new Date()),
          };
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...body } : i)));
    await fetch(`/api/menu/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function handleReenable(item: MenuItem) {
    const body = { is_available: true, unavailable_until: null };
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...body } : i)));
    await fetch(`/api/menu/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function handleFormSubmit(values: MenuItemFormValues) {
    if (modal?.mode === 'edit') {
      const res = await fetch(`/api/menu/${modal.item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to save' }));
        throw new Error(data.error ?? 'Failed to save');
      }
    } else {
      const res = await fetch('/api/menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to save' }));
        throw new Error(data.error ?? 'Failed to save');
      }
    }
    setModal(null);
    fetchItems();
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    await fetch(`/api/menu/${deleteTarget.id}`, { method: 'DELETE' });
    setDeleteTarget(null);
    fetchItems();
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div id="store" className="mb-8 scroll-mt-20">
        <StoreControls />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Menu Items</h1>
        <button
          type="button"
          onClick={() => setModal({ mode: 'create' })}
          className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Add Item
        </button>
      </div>

      {loading ? (
        <Spinner label="Loading menu items…" />
      ) : (
        <MenuItemTable
          items={items}
          onSnooze={handleSnooze}
          onReenable={handleReenable}
          onEdit={(item) => setModal({ mode: 'edit', item })}
          onDelete={(item) => setDeleteTarget(item)}
        />
      )}

      {modal ? (
        <MenuItemFormModal
          mode={modal.mode}
          initial={modal.mode === 'edit' ? modal.item : undefined}
          onClose={() => setModal(null)}
          onSubmit={handleFormSubmit}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          heading={`Delete '${deleteTarget.name}'?`}
          body="This can't be undone."
          confirmLabel="Delete"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
        />
      ) : null}
    </div>
  );
}
