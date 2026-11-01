'use client';

// Owner → Warehouse → Requests (docs/WAREHOUSE-SPEC.md). Every warehouse
// transfer, grouped by what it needs next, and the owner's step for each:
//
//   New requests        choose who delivers it (a team member or someone else)
//   Ready to send       record what the warehouse actually sent → in transit
//   Returns arriving    count a return in at the warehouse
//   Arrived different   settle each line that doesn't match
//   On the way          sent, waiting to be counted in at the store's POS
//
// The buttons follow the same rules the API enforces (lib/inventory/rules.ts,
// lib/inventory/warehouse.ts); the API re-checks every one.

import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import {
  canAssign,
  canCancel,
  canPick,
  formatQty,
  requestStatusLabel,
  roundQty,
  UNIT_LABELS,
  type RequestActor,
} from '@/lib/inventory/rules';
import {
  canReceiveReturn,
  canResolve,
  lineDifference,
  needsSettling,
  resolutionLabel,
  resolutionOptions,
  type Resolution,
} from '@/lib/inventory/warehouse';
import {
  api,
  age,
  inputBase,
  inputClass,
  primaryButton,
  secondaryButton,
  shortDate,
  when,
  type StockRequestView,
  type WarehousePayload,
} from '@/components/owner/warehouse/client';
import { DelivererPicker, delivererLabel, type DelivererChoice } from '@/components/staff/inventory/DelivererPicker';
import { QtyExpiryInputs } from '@/components/staff/inventory/StockTab';

const ENDPOINT = (id: string) => `/api/owner/warehouse/requests/${id}`;

function facts(r: StockRequestView) {
  return {
    status: r.status,
    requested_by: r.requestedBy.id,
    assigned_to: r.assignedTo?.id ?? null,
    picked_by: r.pickedBy?.id ?? null,
    route: r.route,
  };
}

function transferFacts(r: StockRequestView) {
  return { route: r.route, status: r.status, hasDiscrepancy: r.hasDiscrepancy, resolvedAt: r.resolvedAt };
}

function title(r: StockRequestView): string {
  return r.route === 'to_warehouse' ? `Return #${r.number}` : `Store request #${r.number}`;
}

export function TransfersTab({ data, reload }: { data: WarehousePayload; reload: () => Promise<void> }) {
  const [assigning, setAssigning] = useState<StockRequestView | null>(null);
  const [dispatching, setDispatching] = useState<StockRequestView | null>(null);
  const [receiving, setReceiving] = useState<StockRequestView | null>(null);
  const [settling, setSettling] = useState<StockRequestView | null>(null);
  const [cancelling, setCancelling] = useState<StockRequestView | null>(null);
  const [notice, setNotice] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const actor: RequestActor = { userId: data.actorId, role: 'owner', surface: 'web' };
  const whOnHand = useMemo(() => new Map(data.items.map((i) => [i.id, i.warehouse.onHand])), [data.items]);

  const groups = useMemo(() => {
    const rs = data.requests;
    return {
      toAssign: rs.filter((r) => r.route === 'from_warehouse' && r.status === 'requested'),
      toDispatch: rs.filter((r) => r.route === 'from_warehouse' && r.status === 'assigned'),
      toReceive: rs.filter((r) => r.route === 'to_warehouse' && r.status === 'picked'),
      toSettle: rs.filter((r) => needsSettling(r)),
      onRoad: rs.filter((r) => r.route === 'from_warehouse' && r.status === 'picked'),
      closed: rs
        .filter((r) => (r.status === 'received' && !needsSettling(r)) || r.status === 'cancelled')
        .sort((a, b) => (b.receivedAt ?? b.createdAt).localeCompare(a.receivedAt ?? a.createdAt)),
    };
  }, [data.requests]);

  const done = async (message: string) => {
    setAssigning(null);
    setDispatching(null);
    setReceiving(null);
    setSettling(null);
    setCancelling(null);
    setNotice(message);
    await reload();
  };

  function card(r: StockRequestView) {
    const f = facts(r);
    const tf = transferFacts(r);
    const mayAssign = canAssign(f, actor).ok;
    const mayDispatch = canPick(f, actor).ok;
    const mayReceive = canReceiveReturn(tf, actor).ok;
    const maySettle = canResolve(tf, actor).ok;
    const mayCancel = canCancel(f, actor).ok;
    const notSent = r.route === 'from_warehouse' && (r.status === 'requested' || r.status === 'assigned');
    const deliverer = delivererLabel(r);

    return (
      <li key={r.id} className={`rounded-md border bg-white p-4 ${maySettle ? 'border-red-300' : 'border-line'}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-charcoal">{title(r)}</p>
            <p className="text-xs text-muted">
              {r.route === 'to_warehouse' ? 'sent by' : 'asked by'} {r.requestedBy.name} · {when(r.createdAt)}
              {deliverer ? ` · delivered by ${deliverer}` : ''}
              {r.pickedAt && r.route === 'from_warehouse' ? ` · sent ${when(r.pickedAt)}` : ''}
              {r.status === 'picked' && r.pickedAt ? ` · on the road ${age(r.pickedAt)}` : ''}
              {r.receivedBy ? ` · counted in by ${r.receivedBy.name} ${when(r.receivedAt)}` : ''}
            </p>
            {r.note ? <p className="mt-1 text-sm text-charcoal">“{r.note}”</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {r.hasDiscrepancy ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                  r.resolvedAt ? 'border-line bg-surface text-charcoal' : 'border-red-200 bg-red-50 text-red-800'
                }`}
              >
                {r.resolvedAt ? 'Difference settled' : 'Arrived different'}
              </span>
            ) : null}
            <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-semibold text-charcoal">
              {requestStatusLabel(r.status, r.route)}
            </span>
          </div>
        </div>

        {/* Fits a phone: once something has been sent, "Asked" steps aside
            below sm so Sent and Arrived — what matching is about — stay in view. */}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-left align-bottom text-xs text-muted">
                <th className="py-1 font-medium">Item</th>
                {r.route === 'from_warehouse' ? (
                  <th className={`py-1 pl-2 text-right font-medium ${notSent ? '' : 'hidden sm:table-cell'}`}>Asked</th>
                ) : null}
                {notSent ? <th className="py-1 pl-2 text-right font-medium">In warehouse</th> : null}
                <th className="py-1 pl-2 text-right font-medium">Sent</th>
                <th className="py-1 pl-2 text-right font-medium">Arrived</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => {
                const diff = l.qtyReceived === null ? 0 : lineDifference(l);
                const held = whOnHand.get(l.itemId) ?? 0;
                return (
                  <tr key={l.itemId} className="border-t border-[#f0f0f0] align-top">
                    <td className="py-1.5 pr-2">
                      {l.itemName}
                      {l.resolution ? (
                        <span className="block text-xs text-muted">
                          {formatQty(l.resolvedQty ?? 0, l.unit)}: {resolutionLabel(l.resolution, r.route)}
                        </span>
                      ) : null}
                    </td>
                    {r.route === 'from_warehouse' ? (
                      <td className={`whitespace-nowrap py-1.5 pl-2 text-right ${notSent ? '' : 'hidden sm:table-cell'}`}>
                        {formatQty(l.qtyRequested, l.unit)}
                      </td>
                    ) : null}
                    {notSent ? (
                      <td className={`whitespace-nowrap py-1.5 pl-2 text-right ${held < l.qtyRequested ? 'font-semibold text-amber-800' : ''}`}>
                        {formatQty(held, l.unit)}
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap py-1.5 pl-2 text-right">{l.qtyPicked === null ? '—' : formatQty(l.qtyPicked, l.unit)}</td>
                    <td className={`whitespace-nowrap py-1.5 pl-2 text-right ${diff !== 0 ? 'font-bold text-red-700' : ''}`}>
                      {l.qtyReceived === null ? '—' : formatQty(l.qtyReceived, l.unit)}
                      {diff !== 0 ? (
                        <span className="block text-xs font-semibold">
                          {diff > 0 ? `${formatQty(diff, l.unit)} short` : `${formatQty(-diff, l.unit)} over`}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {r.status === 'cancelled' && r.cancelReason ? <p className="mt-2 text-xs text-muted">Cancelled: {r.cancelReason}</p> : null}
        {r.resolvedAt ? (
          <p className="mt-2 text-xs text-muted">
            Settled by {r.resolvedBy?.name ?? 'the owner'} {when(r.resolvedAt)}
            {r.resolutionNote ? ` — “${r.resolutionNote}”` : ''}
          </p>
        ) : null}
        {r.route === 'from_warehouse' && r.status === 'picked' ? (
          <p className="mt-2 text-xs text-muted">Waiting to be counted in at the store’s POS, by someone other than the delivery person.</p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {mayAssign ? (
            <button type="button" className={r.status === 'requested' ? primaryButton : secondaryButton} onClick={() => setAssigning(r)}>
              {r.status === 'requested' ? 'Choose who delivers' : 'Change delivery person'}
            </button>
          ) : null}
          {mayDispatch ? (
            <button type="button" className={primaryButton} onClick={() => setDispatching(r)}>
              Record what was sent
            </button>
          ) : null}
          {mayReceive ? (
            <button type="button" className={primaryButton} onClick={() => setReceiving(r)}>
              Count it in
            </button>
          ) : null}
          {maySettle ? (
            <button type="button" className={primaryButton} onClick={() => setSettling(r)}>
              Settle the difference
            </button>
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

  const section = (heading: string, hint: string, list: StockRequestView[]) =>
    list.length === 0 ? null : (
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-bold text-charcoal">
            {heading} <span className="text-sm font-semibold text-muted">({list.length})</span>
          </h2>
          <p className="text-sm text-muted">{hint}</p>
        </div>
        <ul className="space-y-3">{list.map(card)}</ul>
      </section>
    );

  const nothingOpen =
    groups.toAssign.length + groups.toDispatch.length + groups.toReceive.length + groups.toSettle.length + groups.onRoad.length === 0;

  return (
    <div className="space-y-8">
      {notice ? (
        <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {notice}
        </p>
      ) : null}
      {nothingOpen ? (
        <p className="rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">
          Nothing waiting. When the store asks for stock it appears here, and you are emailed.
        </p>
      ) : null}
      {section('Arrived different', 'Settle each line that doesn’t match what was sent.', groups.toSettle)}
      {section('New requests', 'Choose who delivers each one.', groups.toAssign)}
      {section('Ready to send', 'Record what actually leaves the warehouse — that comes off the stock sheet.', groups.toDispatch)}
      {section('Returns on the way to the warehouse', 'Count each one in when it arrives.', groups.toReceive)}
      {section('On the way to the store', 'Sent; the store counts it in at the POS.', groups.onRoad)}

      {groups.closed.length > 0 ? (
        <div>
          <button type="button" className="text-sm font-semibold text-charcoal underline" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Hide' : 'Show'} recent finished transfers ({groups.closed.length})
          </button>
          {showClosed ? <ul className="mt-3 space-y-3">{groups.closed.map(card)}</ul> : null}
        </div>
      ) : null}

      {assigning ? <AssignModal request={assigning} data={data} onClose={() => setAssigning(null)} onDone={done} /> : null}
      {dispatching ? (
        <DispatchModal request={dispatching} whOnHand={whOnHand} onClose={() => setDispatching(null)} onDone={done} />
      ) : null}
      {receiving ? <ReceiveReturnModal request={receiving} today={data.today} onClose={() => setReceiving(null)} onDone={done} /> : null}
      {settling ? <SettleModal request={settling} onClose={() => setSettling(null)} onDone={done} /> : null}
      {cancelling ? <CancelModal request={cancelling} onClose={() => setCancelling(null)} onDone={done} /> : null}
    </div>
  );
}

type DoneFn = (message: string) => Promise<void>;

function Footer({ error, busy, label, busyLabel, onClick, disabled }: {
  error: string;
  busy: boolean;
  label: string;
  busyLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      {error ? <p className="text-sm text-red-700">{error}</p> : <span />}
      <button type="button" className={primaryButton} onClick={onClick} disabled={busy || disabled}>
        {busy ? busyLabel : label}
      </button>
    </div>
  );
}

function AssignModal({ request, data, onClose, onDone }: { request: StockRequestView; data: WarehousePayload; onClose: () => void; onDone: DoneFn }) {
  const [choice, setChoice] = useState<DelivererChoice | null>(
    request.assignedTo
      ? { assigneeId: request.assignedTo.id }
      : request.deliverer
        ? { deliverer: request.deliverer }
        : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!choice) return setError('Choose who delivers it.');
    setError('');
    setBusy(true);
    const res = await api<{ emailed: 'sent' | 'failed' | 'skipped' }>(ENDPOINT(request.id), 'PATCH', { action: 'assign', ...choice });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const name = 'assigneeId' in choice ? data.assignees.find((p) => p.id === choice.assigneeId)?.name ?? 'They' : choice.deliverer.name;
    await onDone(
      'deliverer' in choice
        ? `#${request.number}: ${name} delivers it. Now record what you send.`
        : res.data.emailed === 'sent'
          ? `#${request.number}: ${name} delivers it and has been emailed.`
          : choice.assigneeId === data.actorId
            ? `#${request.number}: you are delivering it.`
            : `#${request.number}: ${name} delivers it. They could not be emailed (no personal email on file?) — tell them.`,
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Who delivers ${title(request)}?`}
      subtitle="A team member, or someone without a login (a driver) by name. Whoever carries it can’t be the one who counts it in at the store."
      footer={<Footer error={error} busy={busy} label="Save" busyLabel="Saving…" onClick={submit} disabled={!choice} />}
    >
      <DelivererPicker
        idPrefix={`assign-${request.id}`}
        people={data.assignees}
        initial={{ assigneeId: request.assignedTo?.id ?? null, name: request.deliverer?.name, phone: request.deliverer?.phone }}
        onChange={setChoice}
      />
    </Modal>
  );
}

function DispatchModal({
  request,
  whOnHand,
  onClose,
  onDone,
}: {
  request: StockRequestView;
  whOnHand: Map<string, number>;
  onClose: () => void;
  onDone: DoneFn;
}) {
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.lines.map((l) => [l.itemId, String(l.qtyRequested)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    const lines = request.lines.map((l) => ({ itemId: l.itemId, qty: Number(qty[l.itemId] || 0) }));
    if (lines.some((l) => !Number.isFinite(l.qty) || l.qty < 0)) return setError('Quantities must be 0 or more.');
    setBusy(true);
    const res = await api<{ short: { itemId: string; shortfall: number }[] }>(ENDPOINT(request.id), 'PATCH', { action: 'pick', lines });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const short = res.data.short
      .map((s) => {
        const l = request.lines.find((x) => x.itemId === s.itemId);
        return l ? `${l.itemName} (${formatQty(s.shortfall, l.unit)})` : null;
      })
      .filter(Boolean);
    await onDone(
      short.length
        ? `#${request.number} is on its way. The sheet held less than you sent of ${short.join(', ')} — count ${short.length === 1 ? 'it' : 'them'} on the Stock sheet.`
        : `#${request.number} is on its way. It came off the stock sheet and shows under In transit.`,
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send ${title(request)}`}
      subtitle={`Enter what actually leaves the warehouse (0 if you have none). ${request.deliveredBy ? `${request.deliveredBy} carries it; ` : ''}the store counts it in again.`}
      footer={<Footer error={error} busy={busy} label="Sent — on its way" busyLabel="Saving…" onClick={submit} />}
    >
      <ul className="divide-y divide-[#eee]">
        {request.lines.map((l) => {
          const held = whOnHand.get(l.itemId) ?? 0;
          const n = Number(qty[l.itemId] || 0);
          return (
            <li key={l.itemId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <span className="font-semibold text-charcoal">{l.itemName}</span>
                <span className="block text-xs text-muted">
                  asked {formatQty(l.qtyRequested, l.unit)} · warehouse has {formatQty(held, l.unit)}
                </span>
                {n > held ? (
                  <span className="block text-xs font-semibold text-amber-800">More than the sheet holds — it will ask you to count it.</span>
                ) : null}
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
                  aria-label={`Quantity of ${l.itemName} sent`}
                />
                <span className="w-10 text-muted">{UNIT_LABELS[l.unit]}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function ReceiveReturnModal({
  request,
  today,
  onClose,
  onDone,
}: {
  request: StockRequestView;
  today: string;
  onClose: () => void;
  onDone: DoneFn;
}) {
  // Blank on purpose: count what is in front of you, don't confirm a number.
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
    const res = await api<{ hasDiscrepancy: boolean }>(ENDPOINT(request.id), 'PATCH', {
      action: 'receive_return',
      lines: request.lines.map((l) => ({ itemId: l.itemId, qty: Number(rows[l.itemId].qty), expiryDate: rows[l.itemId].expiry || null })),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone(
      res.data.hasDiscrepancy
        ? `Return #${request.number} counted in — some lines don’t match what left the store. Settle them under “Arrived different”.`
        : `Return #${request.number} counted in. It is on the stock sheet.`,
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Count in return #${request.number}`}
      subtitle={`Sent by ${request.requestedBy.name}${request.deliveredBy ? `, carried by ${request.deliveredBy}` : ''}. Count each item and enter its expiry date.`}
      footer={<Footer error={error} busy={busy} label="Counted — add to the warehouse" busyLabel="Saving…" onClick={submit} />}
    >
      <ul className="divide-y divide-[#eee]">
        {request.lines.map((l) => (
          <li key={l.itemId} className="py-3">
            <p className="text-sm font-semibold text-charcoal">
              {l.itemName}
              <span className="ml-2 text-xs font-normal text-muted">
                sent {l.qtyPicked === null ? '—' : formatQty(l.qtyPicked, l.unit)}
                {l.dispatchExpiry ? ` · earliest expiry sent ${shortDate(l.dispatchExpiry)}` : ''}
              </span>
            </p>
            <QtyExpiryInputs
              unit={l.unit}
              tracksExpiry={l.tracksExpiry}
              today={today}
              qty={rows[l.itemId].qty}
              expiry={rows[l.itemId].expiry}
              expected={l.qtyPicked}
              expectedVerb="Sent"
              name={l.itemName}
              onChange={(v) => setRows((p) => ({ ...p, [l.itemId]: { ...p[l.itemId], ...v } }))}
            />
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function SettleModal({ request, onClose, onDone }: { request: StockRequestView; onClose: () => void; onDone: DoneFn }) {
  const mismatched = request.lines
    .map((l) => ({ line: l, diff: lineDifference(l) }))
    .filter((m) => m.diff !== 0);
  const [choice, setChoice] = useState<Record<string, Resolution | ''>>(() =>
    Object.fromEntries(mismatched.map((m) => [m.line.itemId, ''])),
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const origin = request.route === 'to_warehouse' ? 'the store' : 'the warehouse';

  async function submit() {
    setError('');
    const open = mismatched.find((m) => !choice[m.line.itemId]);
    if (open) return setError(`Choose what happened to ${open.line.itemName}.`);
    setBusy(true);
    const res = await api(ENDPOINT(request.id), 'PATCH', {
      action: 'resolve',
      note,
      lines: mismatched.map((m) => ({ itemId: m.line.itemId, resolution: choice[m.line.itemId] })),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone(`${title(request)} settled.`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Settle ${title(request)}`}
      subtitle={`What was counted in is already on the shelf. Say what happened to each difference — it changes ${origin}’s stock only where you say so.`}
      footer={<Footer error={error} busy={busy} label="Settle" busyLabel="Saving…" onClick={submit} />}
    >
      <ul className="space-y-4">
        {mismatched.map(({ line, diff }) => (
          <li key={line.itemId}>
            <fieldset>
              <legend className="text-sm font-semibold text-charcoal">
                {line.itemName}:{' '}
                <span className="font-normal text-muted">
                  sent {formatQty(line.qtyPicked ?? 0, line.unit)}, arrived {formatQty(line.qtyReceived ?? 0, line.unit)} —{' '}
                </span>
                <span className="text-red-700">
                  {diff > 0 ? `${formatQty(roundQty(diff), line.unit)} short` : `${formatQty(roundQty(-diff), line.unit)} over`}
                </span>
              </legend>
              <div className="mt-2 space-y-1.5">
                {resolutionOptions(diff).map((opt) => (
                  <label key={opt} className="flex min-h-[44px] items-center gap-3 rounded-md border border-line px-3 text-sm">
                    <input
                      type="radio"
                      name={`settle-${line.itemId}`}
                      className="h-5 w-5"
                      checked={choice[line.itemId] === opt}
                      onChange={() => setChoice((p) => ({ ...p, [line.itemId]: opt }))}
                    />
                    <span>{resolutionLabel(opt, request.route)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </li>
        ))}
      </ul>
      <label className="mt-4 block text-sm">
        <span className="text-charcoal">Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} mt-1`} maxLength={300} placeholder="e.g. driver says one crate stayed in the van" />
      </label>
    </Modal>
  );
}

function CancelModal({ request, onClose, onDone }: { request: StockRequestView; onClose: () => void; onDone: DoneFn }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    setBusy(true);
    const res = await api(ENDPOINT(request.id), 'PATCH', { action: 'cancel', reason });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await onDone(`${title(request)} cancelled.`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Cancel ${title(request)}?`}
      footer={<Footer error={error} busy={busy} label="Cancel it" busyLabel="Cancelling…" onClick={submit} disabled={reason.trim().length < 3} />}
    >
      <label className="block text-sm">
        <span className="text-charcoal">Reason</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} mt-1`} placeholder="e.g. we don’t stock this any more" />
      </label>
    </Modal>
  );
}
