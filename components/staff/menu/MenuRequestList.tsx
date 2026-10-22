'use client';

// The rows of pending menu requests, shared by the "waiting for owner approval"
// panel on the POS Menu screen and the list behind the header's Menu badge:
// action pill, item name, what changes, who asked and when, and a Cancel button
// where the viewer may use it (canCancel). The cancel flow itself is
// useCancelMenuRequest; the owner of that hook passes it in.

import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import type { MenuChangeAction, MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { timeAgo } from '@/lib/utils/timeAgo';
import type { CancelMenuRequest } from './useCancelMenuRequest';
import { describeChange, requestLabel } from './requestSummary';

const ACTION_PILL: Record<MenuChangeAction, string> = {
  create: 'bg-amber-100 text-amber-900',
  update: 'bg-amber-100 text-amber-900',
  delete: 'bg-red-100 text-red-800',
};

export function MenuRequestRow({
  request: r,
  canCancel,
  cancel,
}: {
  request: MenuChangeRequest;
  canCancel: boolean;
  cancel: CancelMenuRequest;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${ACTION_PILL[r.action]}`}>
            {requestLabel(r)}
          </span>
          <span className="break-words font-bold text-charcoal">
            {r.item_name || (r.target === 'addon_group' ? 'Untitled add-on group' : 'Untitled item')}
          </span>
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
          loading={cancel.cancellingId === r.id}
          disabled={cancel.cancellingId !== null}
          onClick={() => cancel.ask(r)}
        >
          Cancel
        </Button>
      ) : null}
    </li>
  );
}

export function MenuRequestList({
  requests,
  canCancel,
  cancel,
  className = 'divide-amber-200',
}: {
  requests: MenuChangeRequest[];
  /** Per request: may this viewer cancel it? (canCancelMenuRequest) */
  canCancel: (request: MenuChangeRequest) => boolean;
  cancel: CancelMenuRequest;
  /** Divider colour for the rows. */
  className?: string;
}) {
  return (
    <>
      {cancel.error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {cancel.error}
        </p>
      ) : null}

      <ul className={`mt-2 divide-y ${className}`}>
        {requests.map((r) => (
          <MenuRequestRow key={r.id} request={r} canCancel={canCancel(r)} cancel={cancel} />
        ))}
      </ul>

      {cancel.confirmTarget ? (
        <ConfirmDialog
          heading={`Cancel the request for '${cancel.confirmTarget.item_name || 'this item'}'?`}
          body="The owner won't see it and the menu stays as it is."
          confirmLabel="Yes, cancel request"
          onCancel={cancel.dismiss}
          onConfirm={() => void cancel.confirm()}
        />
      ) : null}
    </>
  );
}
