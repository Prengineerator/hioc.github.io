// Owner overview (O1–O4). Server component: reads the analytics layer (F5) and
// renders today-at-a-glance, the live-ops mirror, revenue trend, orders/SLA,
// best/worst sellers, peak-hours heatmap, and rejection reasons.

import {
  getDailySales,
  getItemSales,
  getHourlyOrders,
  getOrderDurations,
  getRejectReasons,
  getStatusCounts,
  getTodayAtAGlance,
} from '@/lib/analytics/queries';
import {
  Card,
  GlanceCards,
  Heatmap,
  RevenueBars,
  ReasonList,
  SellerList,
} from '@/components/owner/dashboard';
import { LiveOps } from '@/components/owner/LiveOps';

export const dynamic = 'force-dynamic';

// median & p90 of a nullable duration series (seconds → minutes), in JS (OWN-008).
function percentile(values: (number | null)[], p: number): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const idx = Math.min(nums.length - 1, Math.floor((p / 100) * nums.length));
  return Math.round(nums[idx] / 60);
}

export default async function OwnerOverviewPage() {
  const [glance, daily, items, hourly, durations, reasons, counts] = await Promise.all([
    getTodayAtAGlance(),
    getDailySales(30),
    getItemSales(50),
    getHourlyOrders(),
    getOrderDurations(30),
    getRejectReasons(),
    getStatusCounts(30),
  ]);

  const acceptSecs = durations.map((d) => d.accept_secs);
  const prepSecs = durations.map((d) => d.prep_secs);
  const total30 = Object.values(counts).reduce((a, b) => a + b, 0);
  const rate = (n: number) => (total30 ? Math.round((n / total30) * 100) : 0);

  const bestSellers = items.slice(0, 8);
  const worstSellers = [...items].reverse().slice(0, 8);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Today at a glance</h1>
      <GlanceCards g={glance} />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Live operations">
          <LiveOps />
        </Card>
        <Card title="Revenue · last 30 days">
          <RevenueBars rows={daily} />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Orders · last 30 days">
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            {['received', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled'].map((s) => (
              <div key={s} className="rounded-md bg-[#f2efe9] p-2 text-center">
                <p className="text-lg font-bold text-charcoal">{counts[s] ?? 0}</p>
                <p className="text-[10px] uppercase text-muted">{s}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            Acceptance {rate((counts.accepted ?? 0) + (counts.completed ?? 0) + (counts.preparing ?? 0) + (counts.ready ?? 0))}% ·
            Rejection {rate(counts.rejected ?? 0)}%
          </p>
        </Card>
        <Card title="Fulfilment SLA · last 30 days">
          <div className="grid grid-cols-2 gap-4 text-center">
            <SlaStat label="Time to accept" median={percentile(acceptSecs, 50)} p90={percentile(acceptSecs, 90)} />
            <SlaStat label="Prep time" median={percentile(prepSecs, 50)} p90={percentile(prepSecs, 90)} />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Best sellers"><SellerList title="Top by revenue" rows={bestSellers} /></Card>
        <Card title="Slowest movers"><SellerList title="Bottom by revenue" rows={worstSellers} /></Card>
      </div>

      <Card title="Peak hours (orders)"><Heatmap rows={hourly} /></Card>
      <Card title="Rejection & cancellation reasons"><ReasonList rows={reasons} /></Card>
    </div>
  );
}

function SlaStat({ label, median, p90 }: { label: string; median: number | null; p90: number | null }) {
  return (
    <div>
      <p className="text-xs uppercase text-muted">{label}</p>
      <p className="mt-1 text-xl font-bold text-charcoal">{median === null ? '—' : `${median}m`}</p>
      <p className="text-xs text-muted">p90 {p90 === null ? '—' : `${p90}m`}</p>
    </div>
  );
}
