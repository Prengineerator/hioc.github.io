'use client';

// One menu change request: who asked for what, the before → after, and (while
// pending) Approve / Reject. The decision is a PATCH to
// /api/owner/menu-requests/[id]; a failure (409 because the item is gone or the
// request was already decided, a short-code clash, ...) is shown on the card
// with the API's own words and the request stays as it was. One 409 is
// different: when the item was edited after the request was made (`stale`),
// approving would overwrite those newer edits, so the card says what changed and
// offers "Approve anyway" (re-sends the approval with force) beside Reject.
// An add-on group request (2026-10-addon-change-requests.sql) is decided the
// same way; only its labels and its before → after (AddonChangeDiff) differ.

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import { Notice, Pill } from '@/components/owner/marketing/ui';
import { isAddonRequest, type MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { AddonChangeDiff } from './AddonChangeDiff';
import { MenuChangeDiff } from './MenuChangeDiff';
import {
  STATUS_LABELS,
  actionTone,
  changedAddonFieldLabels,
  changedFieldLabels,
  formatIstDateTime,
  requestActionLabel,
  statusTone,
} from './menuDiff';

type Decision = 'approve' | 'reject';

function decidedMessage(request: MenuChangeRequest, decision: Decision): string {
  const name = `“${request.item_name || (isAddonRequest(request) ? 'add-on group' : 'item')}”`;
  if (decision === 'reject') return `Rejected the request for ${name}. The menu is unchanged.`;
  if (isAddonRequest(request)) {
    return request.action === 'create'
      ? `Approved ${name}. It can now be added to menu items.`
      : `Approved the changes to ${name}. They are live now.`;
  }
  if (request.action === 'create') return `Approved ${name}. It is now on the menu.`;
  if (request.action === 'delete') return `Approved. ${name} was removed from the menu.`;
  return `Approved the changes to ${name}. They are live now.`;
}

export function MenuRequestCard({
  request,
  addonNames,
  onDecided,
  onConflict,
}: {
  request: MenuChangeRequest;
  addonNames: Record<string, string>;
  /** The owner decided: `updated` is the request as the API now has it. */
  onDecided: (updated: MenuChangeRequest, message: string) => void;
  /** The API said 409: the list on screen may be out of date. */
  onConflict: () => void;
}) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState('');

  const pending = request.status === 'pending';
  const addon = isAddonRequest(request);
  const itemName = request.item_name || (addon ? 'Untitled add-on group' : 'Untitled item');
  const actionLabel = requestActionLabel(request);

  async function decide(decision: Decision, force = false) {
    setBusy(decision);
    setError(null);
    setStale(false);
    try {
      const trimmed = note.trim();
      const res = await fetch(`/api/owner/menu-requests/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: decision,
          ...(decision === 'reject' && trimmed ? { note: trimmed } : {}),
          ...(force ? { force: true } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (data as { error?: string }).error ??
            (decision === 'approve' ? 'Could not approve this request.' : 'Could not reject this request.'),
        );
        // A stale edit is still pending: nothing moved on, so there is nothing to refresh.
        if (res.status === 409 && (data as { stale?: boolean }).stale === true) setStale(true);
        else if (res.status === 409) onConflict();
        return;
      }
      const updated =
        (data as { request?: MenuChangeRequest }).request ??
        ({ ...request, status: decision === 'approve' ? 'approved' : 'rejected' } as MenuChangeRequest);
      setRejectOpen(false);
      onDecided(updated, decidedMessage(request, decision));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  }

  function approve() {
    // Deleting is the one approval that can't be walked back, so ask first.
    if (request.action === 'delete') setConfirmDelete(true);
    else void decide('approve');
  }

  const changed =
    request.action !== 'update'
      ? []
      : isAddonRequest(request)
        ? changedAddonFieldLabels(request.payload)
        : changedFieldLabels(request.payload);

  return (
    <article className="rounded-md border border-line bg-cream p-5 shadow-sm" aria-label={`${actionLabel}: ${itemName}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={actionTone(request.action)}>{actionLabel}</Pill>
            <h3 className="min-w-0 break-words text-lg font-bold text-charcoal">{itemName}</h3>
          </div>
          <p className="mt-1 text-sm text-muted">
            Requested by <span className="font-bold text-charcoal">{request.requested_by_name || 'Unknown'}</span> ·{' '}
            {formatIstDateTime(request.requested_at)} IST
          </p>
          {changed.length > 0 ? <p className="text-sm text-muted">Changes: {changed.join(', ')}</p> : null}
        </div>
        <Pill tone={statusTone(request.status)}>{STATUS_LABELS[request.status]}</Pill>
      </div>

      {request.action === 'delete' ? (
        <div className="mt-3">
          <Notice tone={pending || request.status === 'approved' ? 'bad' : 'info'}>
            <span className="font-bold">
              {pending
                ? 'Will be deleted'
                : request.status === 'approved'
                  ? 'Deleted from the menu'
                  : 'Not deleted'}
            </span>
            {pending ? ' if you approve. This is what is on the menu now:' : null}
          </Notice>
        </div>
      ) : null}

      <div className="mt-3">
        {isAddonRequest(request) ? (
          <AddonChangeDiff request={request} />
        ) : (
          <MenuChangeDiff request={request} addonNames={addonNames} />
        )}
      </div>

      {error && !rejectOpen ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}

      {pending ? (
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center">
          <Button
            onClick={stale ? () => void decide('approve', true) : approve}
            loading={busy === 'approve'}
            disabled={busy !== null}
            aria-label={`${stale ? 'Approve anyway' : 'Approve'}: ${itemName}`}
          >
            {stale ? 'Approve anyway' : 'Approve'}
          </Button>
          <Button
            variant="secondary"
            disabled={busy !== null}
            aria-label={`Reject: ${itemName}`}
            onClick={() => {
              setError(null);
              setStale(false);
              setNote('');
              setRejectOpen(true);
            }}
          >
            Reject
          </Button>
        </div>
      ) : (
        <div className="mt-4 border-t border-line pt-3 text-sm text-muted">
          <p>
            <span className="font-bold text-charcoal">{STATUS_LABELS[request.status]}</span>
            {request.decided_at ? ` on ${formatIstDateTime(request.decided_at)} IST` : null}
            {request.status === 'cancelled' && !request.decided_at ? ' (withdrawn, or replaced by a newer request)' : null}
          </p>
          {request.decision_note ? (
            <p className="mt-1 whitespace-pre-wrap break-words">
              Note: <span className="text-charcoal">{request.decision_note}</span>
            </p>
          ) : null}
        </div>
      )}

      <Modal
        open={rejectOpen}
        onClose={busy ? () => undefined : () => setRejectOpen(false)}
        title="Reject this request?"
        size="sm"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setRejectOpen(false)} disabled={busy !== null}>
              Go back
            </Button>
            <Button variant="danger" onClick={() => void decide('reject')} loading={busy === 'reject'}>
              Reject
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-charcoal">
            The menu stays as it is and the request is closed. Add a note if you want to say why.
          </p>
          <Textarea
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500} // the API's MAX_NOTE_LENGTH (lib/menu/changeRequests.ts)
            placeholder="Why, e.g. price not agreed yet"
          />
          {error ? (
            <p role="alert" className="text-sm font-bold text-red-700">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>

      {confirmDelete ? (
        <ConfirmDialog
          heading={`Delete '${itemName}'?`}
          body="Approving removes this item from the menu for good. This can't be undone."
          confirmLabel="Approve & delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void decide('approve');
          }}
        />
      ) : null}
    </article>
  );
}
