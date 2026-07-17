'use client';

import { useCallback, useEffect, useState } from 'react';
import { MenuItemTable } from '@/components/staff/MenuItemTable';
import {
  MenuItemFormModal,
  type MenuItemFormValues,
} from '@/components/staff/MenuItemFormModal';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import { Spinner } from '@/components/ui/Spinner';
import type { MenuItem } from '@/lib/types';

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

  async function handleToggleAvailable(item: MenuItem, next: boolean) {
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, is_available: next } : i)),
    );
    await fetch(`/api/menu/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_available: next }),
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
          onToggleAvailable={handleToggleAvailable}
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
