'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MenuItemTable, type SnoozeDuration } from '@/components/staff/MenuItemTable';
import {
  MenuItemFormModal,
  type MenuItemFormValues,
} from '@/components/staff/MenuItemFormModal';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import { Spinner } from '@/components/ui/Spinner';
import type { MenuItem } from '@/lib/types';
import { useStaffShell } from '@/components/staff/StaffShell';
import { MENU_POS_ONLY_MESSAGE } from '@/lib/staff/surfaceRules';
import { MenuSwitchesPanel } from '@/components/staff/MenuSwitchesPanel';
import { PendingMenuRequests } from '@/components/staff/menu/PendingMenuRequests';
import { STAFF_MENU_CHANGED_EVENT, publishStaffMenuPending } from '@/components/staff/menu/menuEvents';
import { parseMenuRequestViewer, type MenuRequestViewer } from '@/components/staff/menu/requestViewer';
import type { MenuChangeAction, MenuChangeRequest } from '@/lib/menu/changeRequestTypes';

// How often the "waiting for owner approval" list refreshes while the page is open.
const PENDING_POLL_MS = 30_000;
const SENT_FOR_APPROVAL = 'Sent to the owner for approval — the menu changes once they approve.';

// 202 from a menu route = the change was stored as a request, not applied.
const isSentForApproval = (res: Response) => res.status === 202;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

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
  // Menu changes happen on the POS only (lib/staff/surfaceRules.ts).
  const { canEditMenu } = useStaffShell();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; item: MenuItem } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<MenuItem | null>(null);
  const [query, setQuery] = useState('');
  // Items list, or the on/off switches for categories, sizes and add-ons.
  const [view, setView] = useState<'items' | 'switches'>('items');
  // Edits, new items and deletes the owner hasn't decided yet.
  const [pending, setPending] = useState<MenuChangeRequest[]>([]);
  // Who is looking, so Cancel shows only on requests they may cancel.
  const [viewer, setViewer] = useState<MenuRequestViewer | null>(null);
  const pendingIdsRef = useRef<Set<string> | null>(null);
  const [notice, setNotice] = useState<{ kind: 'sent' | 'error'; text: string } | null>(null);
  // Set once a create/edit/delete applies at once (the owner's own POS), so the
  // "goes to the owner" hints stop showing for them.
  const [appliedDirectly, setAppliedDirectly] = useState(false);

  const fetchItems = useCallback(async () => {
    const res = await fetch('/api/menu?includeUnavailable=true&includeInStore=true&allSizes=true', {
      cache: 'no-store',
    });
    const data = await res.json();
    setItems(data.items ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch('/api/menu/requests?status=pending', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { requests?: MenuChangeRequest[]; viewer?: unknown };
      const next = data.requests ?? [];
      const nextViewer = parseMenuRequestViewer(data.viewer);
      const nextIds = new Set(next.map((r) => r.id));
      const prevIds = pendingIdsRef.current;
      pendingIdsRef.current = nextIds;
      setPending(next);
      setViewer(nextViewer);
      // The header's Menu badge and its list follow at once.
      publishStaffMenuPending({ requests: next, viewer: nextViewer });
      // A request that left the queue was approved (or decided/cancelled
      // elsewhere): reload the menu so an approved change shows up.
      if (prevIds && Array.from(prevIds).some((id) => !nextIds.has(id))) {
        fetchItems().catch(() => {});
      }
    } catch {
      // Keep the last list; the next poll tries again.
    }
  }, [fetchItems]);

  // Load the pending list, then keep it fresh while the tab is visible.
  useEffect(() => {
    void fetchPending();
    const refresh = () => {
      if (document.visibilityState === 'visible') void fetchPending();
    };
    const timer = setInterval(refresh, PENDING_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    // A request cancelled from the header's Menu badge.
    const onCancelledElsewhere = () => void fetchPending();
    window.addEventListener(STAFF_MENU_CHANGED_EVENT, onCancelledElsewhere);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener(STAFF_MENU_CHANGED_EVENT, onCancelledElsewhere);
    };
  }, [fetchPending]);

  // The "sent for approval" notice clears itself; an error stays until dismissed.
  useEffect(() => {
    if (notice?.kind !== 'sent') return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // Item id → the change waiting for the owner, for the badge in the table
  // (a delete outranks an edit if both somehow exist). New items have no id yet.
  const pendingByItemId = useMemo(() => {
    const map: Record<string, MenuChangeAction> = {};
    for (const r of pending) {
      if (!r.menu_item_id || r.action === 'create') continue;
      if (map[r.menu_item_id] !== 'delete') map[r.menu_item_id] = r.action;
    }
    return map;
  }, [pending]);

  // Sold-out changes apply at once. If the server held one for approval anyway
  // (202), put the row back as it was and say so; if it refused, do the same.
  async function patchAvailability(item: MenuItem, body: Partial<MenuItem>) {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...body } : i)));
    try {
      const res = await fetch(`/api/menu/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (isSentForApproval(res)) {
        setNotice({ kind: 'sent', text: SENT_FOR_APPROVAL });
        void fetchPending();
        void fetchItems();
      } else if (!res.ok) {
        setNotice({ kind: 'error', text: await errorMessage(res, 'Could not update the item. Try again.') });
        void fetchItems();
      }
    } catch {
      setNotice({ kind: 'error', text: 'Could not update the item. Check the connection and try again.' });
      void fetchItems();
    }
  }

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
    await patchAvailability(item, body);
  }

  async function handleReenable(item: MenuItem) {
    await patchAvailability(item, { is_available: true, unavailable_until: null });
  }

  // Edits, new items and deletes: the owner's own POS applies them at once
  // (200/201); anyone else's are stored as a request for the owner (202).
  async function handleFormSubmit(values: MenuItemFormValues) {
    const res =
      modal?.mode === 'edit'
        ? await fetch(`/api/menu/${modal.item.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
          })
        : await fetch('/api/menu', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
          });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to save'));
    if (isSentForApproval(res)) {
      setNotice({ kind: 'sent', text: SENT_FOR_APPROVAL });
    } else {
      setAppliedDirectly(true);
    }
    setModal(null);
    void fetchPending();
    fetchItems();
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const res = await fetch(`/api/menu/${target.id}`, { method: 'DELETE' });
      if (!res.ok) {
        setNotice({ kind: 'error', text: await errorMessage(res, `Could not delete '${target.name}'.`) });
      } else if (isSentForApproval(res)) {
        setNotice({ kind: 'sent', text: SENT_FOR_APPROVAL });
      } else {
        setAppliedDirectly(true);
      }
    } catch {
      setNotice({ kind: 'error', text: `Could not delete '${target.name}'. Check the connection and try again.` });
    }
    void fetchPending();
    fetchItems();
  }

  // Client-side search over the loaded menu (name or category). The list is
  // small (~120 items) so filtering in-memory is instant.
  const q = query.trim().toLowerCase();
  const visibleItems = q
    ? items.filter(
        (i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q),
      )
    : items;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Menu Items</h1>
        {canEditMenu ? (
          <button
            type="button"
            onClick={() => setModal({ mode: 'create' })}
            className="rounded-md bg-tan-dark px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-darker"
          >
            Add Item
          </button>
        ) : null}
      </div>

      {canEditMenu && !appliedDirectly ? (
        <p className="-mt-2 mb-4 text-sm text-muted">
          Edits, new items and deletes go to the owner for approval. Sold-out and on/off switches apply right away.
        </p>
      ) : null}

      {notice ? (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={
            'mb-4 flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ' +
            (notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-amber-200 bg-amber-50 text-amber-900')
          }
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="-my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-black/5"
          >
            ✕
          </button>
        </div>
      ) : null}

      {!canEditMenu ? (
        <p className="mb-4 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
          {MENU_POS_ONLY_MESSAGE} This list is read-only here.
        </p>
      ) : null}

      <div className="mb-4 flex gap-2" role="tablist" aria-label="Menu view">
        {(
          [
            ['items', 'Items'],
            ['switches', 'On / off'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={
              'min-h-[40px] rounded-full border px-4 text-sm font-bold transition-colors ' +
              (view === id ? 'border-charcoal bg-charcoal text-cream' : 'border-line text-charcoal hover:border-tan')
            }
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'switches' ? (
        loading ? (
          <Spinner label="Loading menu items…" />
        ) : (
          <MenuSwitchesPanel items={items} canEdit={canEditMenu} />
        )
      ) : (
      <>
      <PendingMenuRequests
        requests={pending}
        canCancel={canEditMenu}
        viewer={viewer}
        onChanged={() => void fetchPending()}
      />

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search menu by name or category…"
        className="mb-4 w-full rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-tan sm:max-w-sm"
      />

      {loading ? (
        <Spinner label="Loading menu items…" />
      ) : visibleItems.length === 0 ? (
        <p className="rounded-md border border-line bg-cream py-10 text-center text-sm text-muted">
          No items match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <MenuItemTable
          items={visibleItems}
          onSnooze={handleSnooze}
          onReenable={handleReenable}
          onEdit={(item) => setModal({ mode: 'edit', item })}
          onDelete={(item) => setDeleteTarget(item)}
          readOnly={!canEditMenu}
          pendingByItemId={pendingByItemId}
        />
      )}
      </>
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
          body="This can't be undone. Unless you're the owner, the delete goes to the owner for approval first."
          confirmLabel="Delete"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
        />
      ) : null}
    </div>
  );
}
