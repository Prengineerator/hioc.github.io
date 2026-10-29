'use client';

// Items sub-tab of /owner/menu: the owner's own menu editor. Same table and
// form as the staff POS (components/staff), but pointed at /api/owner/menu, so
// every change here applies at once — no approval step. Items that staff have
// a pending edit or delete for are flagged by the table.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Notice } from '@/components/owner/marketing/ui';
import { MenuItemTable, type SnoozeDuration } from '@/components/staff/MenuItemTable';
import { MenuItemFormModal, type MenuItemFormValues } from '@/components/staff/MenuItemFormModal';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import type { MenuItem } from '@/lib/types';
import type { MenuChangeAction } from '@/lib/menu/changeRequestTypes';
import { endOfBusinessDayIso } from '@/lib/businessDay';

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error ?? fallback;
}

export function OwnerMenuItems({
  pendingByItemId,
  pendingCount,
  onOpenApprovals,
  onChanged,
}: {
  /** Items with a staff edit/delete waiting for approval. */
  pendingByItemId: Record<string, MenuChangeAction>;
  /** All requests waiting, for the reminder above the table. */
  pendingCount: number;
  onOpenApprovals: () => void;
  /** The owner changed the menu: the pending list may be out of date (a deleted item's request). */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; item: MenuItem } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MenuItem | null>(null);
  const [query, setQuery] = useState('');

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/menu?includeUnavailable=true&includeInStore=true&allSizes=true', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await readError(res, 'Could not load the menu.'));
      const data = await res.json();
      setItems(data.items ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the menu.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  // 86 / snooze — see lib/menu/availability.ts: a timed snooze keeps
  // is_available true and sets unavailable_until; an indefinite 86 flips
  // is_available off. The row updates at once and is put right if the save fails.
  async function patchAvailability(item: MenuItem, body: { is_available: boolean; unavailable_until?: string | null }) {
    setActionError(null);
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...body } : i)));
    try {
      const res = await fetch(`/api/owner/menu/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res, `Could not update '${item.name}'.`));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Could not update '${item.name}'.`);
      void fetchItems();
    }
  }

  function handleSnooze(item: MenuItem, duration: SnoozeDuration) {
    void patchAvailability(
      item,
      duration === 'indefinite'
        ? { is_available: false }
        : {
            is_available: true,
            unavailable_until:
              duration === '2h'
                ? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
                : endOfBusinessDayIso(),
          },
    );
  }

  function handleReenable(item: MenuItem) {
    void patchAvailability(item, { is_available: true, unavailable_until: null });
  }

  // The form shows the API's message itself when this throws.
  async function handleFormSubmit(values: MenuItemFormValues) {
    const editing = modal?.mode === 'edit' ? modal.item : null;
    const res = await fetch(editing ? `/api/owner/menu/${editing.id}` : '/api/owner/menu', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (!res.ok) throw new Error(await readError(res, 'Failed to save'));
    setModal(null);
    setActionError(null);
    void fetchItems();
    onChanged();
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setActionError(null);
    try {
      const res = await fetch(`/api/owner/menu/${target.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res, `Could not delete '${target.name}'.`));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Could not delete '${target.name}'.`);
    }
    void fetchItems();
    onChanged();
  }

  // Client-side search over the loaded menu (name or category); the list is
  // small enough that filtering in memory is instant.
  const q = query.trim().toLowerCase();
  const visibleItems = q
    ? items.filter((i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q))
    : items;

  return (
    <div className="flex flex-col gap-4">
      {pendingCount > 0 ? (
        <Notice
          tone="warn"
          title={`${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'} from the POS ${pendingCount === 1 ? 'is' : 'are'} waiting for your approval`}
          action={
            <Button variant="secondary" size="sm" onClick={onOpenApprovals}>
              Review
            </Button>
          }
        >
          Items with a waiting edit or delete are marked in the list. Your own changes below apply straight away.
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search menu by name or category…"
          aria-label="Search menu"
          className="min-h-[44px] w-full rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-tan sm:max-w-sm"
        />
        <Button onClick={() => setModal({ mode: 'create' })}>Add item</Button>
      </div>

      {actionError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
          {actionError}
        </p>
      ) : null}

      {loading ? (
        <Spinner label="Loading menu items…" />
      ) : loadError ? (
        <Notice
          tone="bad"
          role="alert"
          title="This did not load"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setLoading(true);
                void fetchItems();
              }}
            >
              Try again
            </Button>
          }
        >
          {loadError}
        </Notice>
      ) : visibleItems.length === 0 ? (
        <p className="rounded-md border border-line bg-cream py-10 text-center text-sm text-muted">
          {q ? <>No items match &ldquo;{query}&rdquo;.</> : 'No menu items yet. Add the first one.'}
        </p>
      ) : (
        <MenuItemTable
          items={visibleItems}
          pendingByItemId={pendingByItemId}
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
          uploadUrl="/api/owner/menu/upload"
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
