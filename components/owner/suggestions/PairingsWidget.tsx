// COFFEY-ADDONS-PAIRINGS-SPEC §4.4 — the "Checkout pairings" card on the owner
// Suggestions Overview tab: shown / added / ordered, the add rate, the attributed
// revenue and the top pairs. Pure (no hooks), like the rest of OverviewWidgets,
// so it renders inside the async server page. Card and inr come from the owner
// dashboard module, the same ones OverviewWidgets uses.

import { Card, inr } from '@/components/owner/dashboard';
import type { PairingStats } from '@/lib/suggest/pairingStats';

function Tile({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="rounded-md bg-[#f2efe9] p-3 text-center">
      <p className="text-xl font-bold text-charcoal">{value}</p>
      <p className="text-xs uppercase text-muted">{label}</p>
    </div>
  );
}

export function PairingsCard({
  stats,
  missingTable,
  enabled,
}: {
  stats: PairingStats;
  missingTable: boolean;
  enabled: boolean;
}) {
  if (missingTable) {
    return (
      <Card title="Checkout pairings">
        <p className="text-sm text-muted">Apply supabase/2026-10-coffey-addons-pairings.sql to start measuring.</p>
      </Card>
    );
  }

  return (
    <Card title="Checkout pairings">
      {!enabled && (
        <p className="mb-3 text-xs text-muted">
          The checkout card is off (NEXT_PUBLIC_FLAG_CHECKOUT_PAIRINGS). Numbers appear once it&apos;s switched on.
        </p>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Tile value={stats.shown} label="Shown" />
        <Tile value={stats.added} label="Added" />
        <Tile value={stats.ordered} label="Ordered" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Tile value={stats.addRate === null ? '—' : `${Math.round(stats.addRate * 100)}%`} label="Add rate" />
        <Tile value={inr(stats.revenueInr)} label="Attributed revenue" />
      </div>

      {stats.topPairs.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No pairings added or ordered yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[320px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-bold uppercase text-muted">
                <th scope="col" className="py-2 pr-3 font-bold">
                  With → Suggested
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-bold">
                  Added
                </th>
                <th scope="col" className="py-2 text-right font-bold">
                  Ordered
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.topPairs.map((p) => (
                <tr key={`${p.anchorItemId}:${p.menuItemId}`} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3 text-charcoal">
                    {p.anchorName} → {p.name}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted">{p.added}</td>
                  <td className="py-2 text-right tabular-nums text-muted">{p.ordered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
