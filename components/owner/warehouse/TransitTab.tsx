'use client';

// Owner → Warehouse → In transit (docs/WAREHOUSE-SPEC.md). The transit sheet:
// every line on the road right now (left one place, not yet counted in at the
// other), who is carrying it and for how long; and below it every line that
// was counted in different from what was sent and is not settled yet. Both
// are derived from the transfers (lib/inventory/warehouse.ts transitLines,
// unmatchedLines) — transit is never a number someone types.

import { formatQty } from '@/lib/inventory/rules';
import { transitLines, unmatchedLines } from '@/lib/inventory/warehouse';
import { age, primaryButton, shortDate, when, type WarehousePayload } from '@/components/owner/warehouse/client';

const DIRECTION = {
  from_warehouse: 'Warehouse → store',
  to_warehouse: 'Store → warehouse',
} as const;

export function TransitTab({ data, onOpenRequests }: { data: WarehousePayload; onOpenRequests: () => void }) {
  const onRoad = transitLines(data.requests);
  const unmatched = unmatchedLines(data.requests);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-bold text-charcoal">On the road ({onRoad.length})</h2>
        <p className="text-sm text-muted">Sent, not yet counted in at the other end.</p>
        {onRoad.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">Nothing in transit.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-line bg-white">
            <table className="w-full min-w-[640px] text-sm tabular-nums">
              <thead className="bg-surface text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Quantity</th>
                  <th className="px-3 py-2 font-medium">Carried by</th>
                  <th className="px-3 py-2 font-medium">Sent</th>
                </tr>
              </thead>
              <tbody>
                {onRoad.map((l) => (
                  <tr key={`${l.requestId}-${l.itemId}`} className="border-t border-[#f0f0f0]">
                    <td className="px-3 py-2 font-semibold">{l.number}</td>
                    <td className="px-3 py-2">{DIRECTION[l.route]}</td>
                    <td className="px-3 py-2">
                      {l.itemName}
                      {l.dispatchExpiry ? <span className="block text-xs text-muted">earliest expiry {shortDate(l.dispatchExpiry)}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{formatQty(l.qty, l.unit)}</td>
                    <td className="px-3 py-2">{l.deliveredBy || '—'}</td>
                    <td className="px-3 py-2">
                      {when(l.dispatchedAt)}
                      {l.dispatchedAt ? <span className="block text-xs text-muted">{age(l.dispatchedAt)} ago</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-bold text-charcoal">Arrived different, not settled ({unmatched.length})</h2>
        <p className="text-sm text-muted">
          What was counted in is already on the shelf at the other end. The difference stays here until you settle it.
        </p>
        {unmatched.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-[#ddd] bg-white p-6 text-center text-sm text-muted">
            Everything that arrived matched what was sent.
          </p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto rounded-md border border-red-200 bg-white">
              <table className="w-full min-w-[640px] text-sm tabular-nums">
                <thead className="bg-red-50 text-left text-xs text-red-900">
                  <tr>
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">Direction</th>
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">Sent</th>
                    <th className="px-3 py-2 text-right font-medium">Arrived</th>
                    <th className="px-3 py-2 text-right font-medium">Difference</th>
                    <th className="px-3 py-2 font-medium">Carried by</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatched.map((l) => (
                    <tr key={`${l.requestId}-${l.itemId}`} className="border-t border-[#f0f0f0]">
                      <td className="px-3 py-2 font-semibold">{l.number}</td>
                      <td className="px-3 py-2">{DIRECTION[l.route]}</td>
                      <td className="px-3 py-2">{l.itemName}</td>
                      <td className="px-3 py-2 text-right">{formatQty(l.sent, l.unit)}</td>
                      <td className="px-3 py-2 text-right">{formatQty(l.arrived, l.unit)}</td>
                      <td className="px-3 py-2 text-right font-bold text-red-700">
                        {l.difference > 0 ? `${formatQty(l.difference, l.unit)} short` : `${formatQty(-l.difference, l.unit)} over`}
                      </td>
                      <td className="px-3 py-2">{l.deliveredBy || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className={`${primaryButton} mt-3`} onClick={onOpenRequests}>
              Settle on the Requests tab
            </button>
          </>
        )}
      </section>
    </div>
  );
}
