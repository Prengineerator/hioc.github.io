'use client';

// POS → Menu: the edits, new items and deletes this shop has sent to the owner
// that are still waiting for a decision (menu_change_requests, status pending).
// A requester, a manager or the owner can cancel one before it is decided.

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import type { MenuChangeAction, MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { timeAgo } from '@/lib/utils/timeAgo';
import { ACTION_LABEL, describeChange } from './requestSummary';

const ACTION_PILL: Record<MenuChangeAction, string> = {
  create: 'bg-amber-100 text-amber-900',
  update: 'bg-amber-100 text-amber-900',
  delete: 'bg-red-100 text-red-800',
};

export function PendingMenuRequests({
  requests,
  canCancel,
  onChanged,
}: {
  requests: MenuChangeRequest[];
  /** Cancelling is a menu change, so it follows canEditMenu (POS only). */
  canCancel: boolean;
  /** A request was cancelled, or turned out to be decided already: reload the list. */
  onChanged: () => void;
}) {
  const [confirmTarget, setConfirmTarget] = useState<MenuChangeRequest | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (requests.length === 0) return null;

  async function cancelRequest(request: MenuChangeRequest) {
    setConfirmTarget(null);
    setCancellingId(request.id);
    setError(null);
    try {
      const res = await fetch(`/api/menu/requests/${request.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? 'Could not cancel the request. Try again.');
      }
      // 409 means it was decided in the meantime: the refresh drops it from the list.
      onChanged();
    } catch {
      setError('Could not cancel the request. Check the connection and try again.');
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <section
      aria-label="Menu changes waiting for the owner"
      className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4"
    >
      <h2 className="text-sm font-bold text-amber-900">Waiting for owner approval ({requests.length})</h2>
      <p className="mt-0.5 text-xs text-amber-900/80">
        The menu stays as it is until the owner approves.
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <ul className="mt-2 divide-y divide-amber-200">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${ACTION_PILL[r.action]}`}
                >
                  {ACTION_LABEL[r.action]}
                </span>
                <span className="break-words font-bold text-charcoal">{r.item_name || 'Untitled item'}</span>
              </div>
              <p className="mt-0.5 text-sm text-charcoal">{describeChange(r)}</p>
              <p className="text-xs text-muted">
                {r.requested_by_name ?? 'Staff'} · {timeAgo(r.requested_at)}
              </p>
            </div>
            {canCancel ? (
              <Button
                variant="ghost"
                size="sm"
                className="border border-line bg-cream"
                loading={cancellingId === r.id}
                disabled={cancellingId !== null}
                onClick={() => setConfirmTarget(r)}
              >
                Cancel
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {confirmTarget ? (
        <ConfirmDialog
          heading={`Cancel the request for '${confirmTarget.item_name || 'this item'}'?`}
          body="The owner won't see it and the menu stays as it is."
          confirmLabel="Yes, cancel request"
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => void cancelRequest(confirmTarget)}
        />
      ) : null}
    </section>
  );
}
