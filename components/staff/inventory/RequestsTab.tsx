'use client';

// Requests tab (docs/INVENTORY-SPEC.md, INV-3/4). Each stock request walks
//   Requested → Assigned (manager picks who) → Picked (the assignee) →
//   Received (verified at the POS by someone other than the picker)
// and this screen shows the button for the next step only to the person who
// may take it. The API re-checks every rule (lib/inventory/rules.ts).
//
// With the warehouse on (docs/WAREHOUSE-SPEC.md) a request is filled from the
// warehouse: "Assigned" is who DELIVERS it (a team member or someone without a
// login), "Picked" is what the warehouse SENT (recorded by the owner or a
// manager), and whoever delivered it can't be the one who counts it in. A
// return to the warehouse shows here on its way; the owner counts it in and
// settles any difference on the owner's Warehouse page.

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import {
  canAssign,
  canCancel,
  canPick,
  canReceive,
  formatQty,
  isWarehouseRoute,
  lineHasDiscrepancy,
  requestStatusLabel,
  UNIT_LABELS,
  type RequestActor,
  type RequestFacts,
} from '@/lib/inventory/rules';
import { resolutionLabel } from '@/lib/inventory/warehouse';
import { DelivererPicker, delivererLabel, type DelivererChoice } from '@/components/staff/inventory/DelivererPicker';
import {
  api,
  inputBase,
  inputClass,
  primaryButton,
  secondaryButton,
  shortDate,
  type RequestsPayload,
  type StockRequestView,
} from '@/components/staff/inventory/client';
import { QtyExpiryInputs } from '@/components/staff/inventory/StockTab';

function facts(r: StockRequestView): RequestFacts {
  return {
    status: r.status,
    requested_by: r.requestedBy.id,
    assigned_to: r.assignedTo?.id ?? null,
    picked_by: r.pickedBy?.id ?? null,
    route: r.route,
  };
}

const ROUTE_CHIP: Record<'from_warehouse' | 'to_warehouse', string> = {
  from_warehouse: 'From the warehouse',
  to_warehouse: 'Back to the warehouse',
};

const STATUS_TONE: Record<StockRequestView['status'], string> = {
  requested: 'bg-amber-50 text-amber-900 border-amber-200',
  assigned: 'bg-blue-50 text-blue-900 border-blue-200',
  picked: 'bg-purple-50 text-purple-900 border-purple-200',
  received: 'bg-green-50 text-green-800 border-green-200',
  cancelled: 'bg-[#f4f4f4] text-muted border-[#e5e5e5]',
};

function time(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function RequestsTab({
  data,
  today,
  reload,
}: {
  data: RequestsPayload;
  today: string;
  reload: () => Promise<void>;
}) {
  const [picking, setPicking] = useState<StockRequestView | null>(null);
  const [choosingDeliverer, setChoosingDeliverer] = useState<StockRequestView | null>(null);
  const [receiving, setReceiving] = useState<StockRequestView | null>(null);
  const [cancelling, setCancelling] = useState<StockRequestView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const actor: RequestActor = {
    userId: data.actorId,
    role: data.canManage ? 'manager' : 'staff',
    surface: data.surface,
  };
  const open = data.requests.filter((r) => r.status !== 'received' && r.status !== 'cancelled');
  const closed = data.requests.filter((r) => r.status === 'received' || r.status === 'cancelled');

  async function assign(r: StockRequestView, assigneeId: string) {
    if (!assigneeId) return;
    setError('');
    setBusyId(r.id);
    const res = await api<{ emailed: 'sent' | 'failed' | 'skipped' }>(`/api/inventory/requests/${r.id}`, 'PATCH', {
      action: 'assign',
      assigneeId,
    });
    setBusyId(null);
    const name = data.assignees.find((p) => p.id === assigneeId)?.name ?? 'them';
    if (!res.ok) setError(`#${r.number}: ${res.error}`);
    else if (res.data.emailed === 'sent') setNotice(`#${r.number} assigned — ${name} has been emailed.`);
    else if (assigneeId !== data.actorId) setNotice(`#${r.number} assigned. ${name} could not be emailed (no personal email on file?) — tell them.`);
    else setNotice(`#${r.number} assigned to you.`);
    await reload();
  }

  function card(r: StockRequestView) {
    const f = facts(r);
    const mayAssign = canAssign(f, actor).ok;
    const mayPick = canPick(f, actor).ok;
    const receiveVerdict = canReceive(f, actor);
    const mayCancel = canCancel(f, actor).ok;
    const warehouse = isWarehouseRoute(r.route) ? r.route : null;
    const mine =
      r.assignedTo?.id === data.actorId && (r.status === 'assigned' || (warehouse !== null && r.status === 'picked'));
    const deliverer = delivererLabel(r);

    return (
      <li key={r.id} className={`rounded-md border bg-white p-4 ${mine ? 'border-tan' : 'border-[#e5e5e5]'}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-charcoal">
              {r.route === 'to_warehouse' ? 'Return' : 'Request'} #{r.number}
              {mine ? <span className="ml-2 text-sm font-bold text-tan-dark">{warehouse ? 'You’re delivering it' : 'Yours to pick'}</span> : null}
            </p>
            <p className="text-xs text-muted">
              by {r.requestedBy.name} · {time(r.createdAt)}
              {warehouse
                ? `${deliverer ? ` · delivered by ${deliverer}` : ''}${r.pickedBy && r.route === 'from_warehouse' ? ` · sent by ${r.pickedBy.name} ${time(r.pickedAt)}` : ''}`
                : `${r.assignedTo ? ` · picker ${r.assignedTo.name}` : ''}${r.pickedBy ? ` · picked by ${r.pickedBy.name} ${time(r.pickedAt)}` : ''}`}
              {r.receivedBy ? ` · ${r.route === 'to_warehouse' ? 'counted in' : 'verified'} by ${r.receivedBy.name} ${time(r.receivedAt)}` : ''}
            </p>
            {r.note ? <p className="mt-1 text-sm text-charcoal">“{r.note}”</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {warehouse ? (
              <span className="rounded-full border border-[#e5e5e5] bg-surface px-2 py-0.5 text-xs font-semibold text-charcoal">
                {ROUTE_CHIP[warehouse]}
              </span>
            ) : null}
            {r.hasDiscrepancy ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                  r.resolvedAt ? 'border-[#e5e5e5] bg-[#f4f4f4] text-muted' : 'border-red-200 bg-red-50 text-red-800'
                }`}
              >
                {warehouse
                  ? r.resolvedAt
                    ? 'Difference settled by the owner'
                    : 'Arrived different — the owner settles it'
                  : 'Arrived different from picked'}
              </span>
            ) : null}
            <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[r.status]}`}>
              {requestStatusLabel(r.status, r.route)}
            </span>
          </div>
        </div>

        <table className="mt-3 w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-medium">Item</th>
              <th className="py-1 text-right font-medium">Asked</th>
              <th className="py-1 text-right font-medium">{warehouse ? 'Sent' : 'Picked'}</th>
              <th className="py-1 text-right font-medium">Arrived</th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.itemId} className="border-t border-[#f0f0f0]">
                <td className="py-1.5 pr-2">
                  {l.itemName}
                  {l.expiryDate ? <span className="block text-xs text-muted">expires {shortDate(l.expiryDate)}</span> : null}
                  {warehouse && l.resolution ? (
                    <span className="block text-xs text-muted">
                      {formatQty(l.resolvedQty ?? 0, l.unit)}: {resolutionLabel(l.resolution, warehouse)}
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 text-right">{formatQty(l.qtyRequested, l.unit)}</td>
                <td className="py-1.5 text-right">{l.qtyPicked === null ? '—' : formatQty(l.qtyPicked, l.unit)}</td>
                <td
                  className={`py-1.5 text-right ${
                    lineHasDiscrepancy({ qty_picked: l.qtyPicked, qty_received: l.qtyReceived }) ? 'font-bold text-red-700' : ''
                  }`}
                >
                  {l.qtyReceived === null ? '—' : formatQty(l.qtyReceived, l.unit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {r.status === 'cancelled' && r.cancelReason ? <p className="mt-2 text-xs text-muted">Cancelled: {r.cancelReason}</p> : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {mayAssign && warehouse ? (
            <button
              type="button"
              className={r.status === 'requested' ? primaryButton : secondaryButton}
              onClick={() => setChoosingDeliverer(r)}
            >
              {r.status === 'requested' ? 'Choose who delivers' : 'Change delivery person'}
            </button>
          ) : null}
          {mayAssign && !warehouse ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">{r.assignedTo ? 'Re-assign' : 'Assign to'}</span>
              <select
                className={`${inputBase} w-auto`}
                value={r.assignedTo?.id ?? ''}
                disabled={busyId === r.id}
                onChange={(e) => void assign(r, e.target.value)}
                aria-label={`Assign request ${r.number}`}
              >
                <option value="">Choose…</option>
                {data.assignees.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {mayPick ? (
            <button type="button" className={primaryButton} onClick={() => setPicking(r)}>
              {r.route === 'from_warehouse' ? 'Record what was sent' : 'Mark picked'}
            </button>
          ) : null}
          {r.status === 'picked' ? (
            receiveVerdict.ok ? (
              <button type="button" className={primaryButton} onClick={() => setReceiving(r)}>
                Verify &amp; receive
              </button>
            ) : (
              <span className="text-xs text-muted">{receiveVerdict.message}</span>
            )
          ) : null}
          {mayCancel ? (
            <button type="button" className={secondaryButton} onClick={() => setCancelling(r)}>
              Cancel
            </button>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <div>
      {error ? <p className="mb-3 text-sm text-red-700">{error}</p> : null}
      {notice ? <p className="mb-3 text-sm text-green-700">{notice}</p> : null}
      {open.length === 0 ? (
        <p className="rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">
          No open requests. Use “{data.warehouse ? 'Request from warehouse' : 'Request stock'}” on the Stock tab when something runs low.
        </p>
      ) : (
        <ul className="space-y-3">{open.map(card)}</ul>
      )}

      {closed.length > 0 ? (
        <div className="mt-6">
          <button type="button" className="text-sm font-semibold text-charcoal underline" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Hide' : 'Show'} recent received / cancelled ({closed.length})
          </button>
          {showClosed ? <ul className="mt-3 space-y-3">{closed.map(card)}</ul> : null}
        </div>
      ) : null}

      {choosingDeliverer ? (
        <DelivererModal
          request={choosingDeliverer}
          people={data.assignees}
          actorId={data.actorId}
          onClose={() => setChoosingDeliverer(null)}
          onDone={async (message) => {
            setChoosingDeliverer(null);
            setNotice(message);
            await reload();
          }}
        />
      ) : null}
      {picking ? (
        <PickModal
          request={picking}
          onClose={() => setPicking(null)}
          onDone={async () => {
            setPicking(null);
            await reload();
          }}
        />
      ) : null}
      {receiving ? (
        <ReceiveModal
          request={receiving}
          today={today}
          onClose={() => setReceiving(null)}
          onDone={async (discrepancy) => {
            setReceiving(null);
            if (discrepancy) {
              setError(
                receiving.route === 'from_warehouse'
                  ? `#${receiving.number} received — some lines arrived different from what the warehouse sent. The owner has been told and settles it.`
                  : `#${receiving.number} received — some lines arrived different from what was picked; the owner can see it.`,
              );
            }
            await reload();
          }}
        />
      ) : null}
      {cancelling ? (
        <CancelModal
          request={cancelling}
          reasonRequired={!(cancelling.requestedBy.id === data.actorId && cancelling.status === 'requested')}
          onClose={() => setCancelling(null)}
          onDone={async () => {
            setCancelling(null);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

function PickModal({ request, onClose, onDone }: { request: StockRequestView; onClose: () => void; onDone: () => Promise<void> }) {
  const dispatch = request.route === 'from_warehouse';
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.lines.map((l) => [l.itemId, String(l.qtyRequested)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    setBusy(true);
    const res = await api(`/api/inventory/requests/${request.id}`, 'PATCH', {
      action: 'pick',
      lines: request.lines.map((l) => ({ itemId: l.itemId, qty: Number(qty[l.itemId] || 0) })),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={dispatch ? `Send request #${request.number}` : `Pick request #${request.number}`}
      subtitle={
        dispatch
          ? `Enter what actually leaves the warehouse (0 if there is none). ${request.deliveredBy ? `${request.deliveredBy} carries it; ` : ''}it is counted again at the POS.`
          : 'Enter what you actually picked (0 if it wasn’t available). It is counted again at the POS.'
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : dispatch ? 'Sent — on its way' : 'Picked — send to POS'}
          </button>
        </div>
      }
    >
      <ul className="divide-y divide-[#eee]">
        {request.lines.map((l) => (
          <li key={l.itemId} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span>
              <span className="font-semibold text-charcoal">{l.itemName}</span>
              <span className="block text-xs text-muted">asked {formatQty(l.qtyRequested, l.unit)}</span>
            </span>
            <label className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                value={qty[l.itemId]}
                onChange={(e) => setQty((p) => ({ ...p, [l.itemId]: e.target.value }))}
                className={`${inputBase} w-24 text-right tabular-nums`}
                aria-label={`${dispatch ? 'Sent' : 'Picked'} quantity of ${l.itemName}`}
              />
              <span className="w-10 text-muted">{UNIT_LABELS[l.unit]}</span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function ReceiveModal({
  request,
  today,
  onClose,
  onDone,
}: {
  request: StockRequestView;
  today: string;
  onClose: () => void;
  onDone: (discrepancy: boolean) => Promise<void>;
}) {
  const fromWarehouse = request.route === 'from_warehouse';
  // Blank on purpose: the verifier counts what is in front of them rather
  // than confirming a pre-filled number.
  const [rows, setRows] = useState<Record<string, { qty: string; expiry: string }>>(() =>
    Object.fromEntries(request.lines.map((l) => [l.itemId, { qty: '', expiry: '' }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const missing = request.lines.find((l) => rows[l.itemId].qty === '');
    if (missing) return setError(`Count ${missing.itemName} (enter 0 if it didn’t arrive).`);
    setBusy(true);
    const res = await api<{ hasDiscrepancy: boolean }>(`/api/inventory/requests/${request.id}`, 'PATCH', {
      action: 'receive',
      lines: request.lines.map((l) => ({
        itemId: l.itemId,
        qty: Number(rows[l.itemId].qty),
        expiryDate: rows[l.itemId].expiry || null,
      })),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone(res.data.hasDiscrepancy);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Verify request #${request.number}`}
      subtitle={
        fromWarehouse
          ? `Sent from the warehouse${request.deliveredBy ? `, delivered by ${request.deliveredBy}` : ''}. Count each item as it arrives and enter its expiry date.`
          : `Picked by ${request.pickedBy?.name ?? 'someone'}. Count each item as it arrives and enter its expiry date.`
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Verified — add to stock'}
          </button>
        </div>
      }
    >
      <ul className="divide-y divide-[#eee]">
        {request.lines.map((l) => (
          <li key={l.itemId} className="py-3">
            <p className="text-sm font-semibold text-charcoal">
              {l.itemName}
              <span className="ml-2 text-xs font-normal text-muted">
                {fromWarehouse ? 'sent' : 'picked'} {l.qtyPicked === null ? '—' : formatQty(l.qtyPicked, l.unit)}
                {fromWarehouse && l.dispatchExpiry ? ` · earliest expiry sent ${shortDate(l.dispatchExpiry)}` : ''}
              </span>
            </p>
            <QtyExpiryInputs
              unit={l.unit}
              tracksExpiry={l.tracksExpiry}
              today={today}
              qty={rows[l.itemId].qty}
              expiry={rows[l.itemId].expiry}
              expected={l.qtyPicked}
              expectedVerb={fromWarehouse ? 'Sent' : 'Picked'}
              name={l.itemName}
              onChange={(v) => setRows((p) => ({ ...p, [l.itemId]: { ...p[l.itemId], ...v } }))}
            />
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function CancelModal({
  request,
  reasonRequired,
  onClose,
  onDone,
}: {
  request: StockRequestView;
  reasonRequired: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    setBusy(true);
    const res = await api(`/api/inventory/requests/${request.id}`, 'PATCH', { action: 'cancel', reason });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone();
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Cancel request #${request.number}?`}
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy || (reasonRequired && reason.trim().length < 3)}>
            {busy ? 'Cancelling…' : 'Cancel request'}
          </button>
        </div>
      }
    >
      <label className="block text-sm">
        <span className="text-charcoal">Reason{reasonRequired ? '' : ' (optional)'}</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} mt-1`} placeholder="e.g. requested by mistake" />
      </label>
    </Modal>
  );
}

function DelivererModal({
  request,
  people,
  actorId,
  onClose,
  onDone,
}: {
  request: StockRequestView;
  people: RequestsPayload['assignees'];
  actorId: string;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<DelivererChoice | null>(
    request.assignedTo ? { assigneeId: request.assignedTo.id } : request.deliverer ? { deliverer: request.deliverer } : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!choice) return setError('Choose who delivers it.');
    setError('');
    setBusy(true);
    const res = await api<{ emailed: 'sent' | 'failed' | 'skipped' }>(`/api/inventory/requests/${request.id}`, 'PATCH', {
      action: 'assign',
      ...choice,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const name = 'assigneeId' in choice ? people.find((p) => p.id === choice.assigneeId)?.name ?? 'They' : choice.deliverer.name;
    await onDone(
      'deliverer' in choice || choice.assigneeId === actorId
        ? `#${request.number}: ${'deliverer' in choice ? name : 'you'} deliver${'deliverer' in choice ? 's' : ''} it.`
        : res.data.emailed === 'sent'
          ? `#${request.number}: ${name} delivers it and has been emailed.`
          : `#${request.number}: ${name} delivers it. They could not be emailed (no personal email on file?) — tell them.`,
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Who delivers request #${request.number}?`}
      subtitle="A team member, or someone without a login (a driver) by name. Whoever delivers it can’t be the one who counts it in."
      footer={
        <div className="flex items-center justify-between gap-2">
          {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
          <button type="button" className={primaryButton} onClick={submit} disabled={busy || !choice}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <DelivererPicker
        idPrefix={`deliverer-${request.id}`}
        people={people}
        initial={{ assigneeId: request.assignedTo?.id ?? null, name: request.deliverer?.name, phone: request.deliverer?.phone }}
        onChange={setChoice}
      />
    </Modal>
  );
}
