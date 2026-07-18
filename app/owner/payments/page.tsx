// Owner payment analytics (RET-2/OWN-009). Server component, styled like
// app/owner/page.tsx — reads the Phase-2 `v_payment_mix` view (payment method
// split + collected/refunded) plus two direct aggregate queries for online vs
// pay-at-counter share and collected-vs-pending, all through the service-role
// client (owner surfaces are server-side reads, same pattern as Phase 1).

import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { Card } from '@/components/owner/dashboard';
import type { PaymentMixRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

async function getPaymentMix(): Promise<PaymentMixRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('v_payment_mix')
    .select('*')
    .order('collected_inr', { ascending: false });
  if (error) {
    console.error('v_payment_mix query failed', error);
    return [];
  }
  return (data ?? []) as PaymentMixRow[];
}

// Online vs pay-at-counter share (RET-2) over the last `days`, counted from
// orders that actually reached a payment method (excludes still-pending/
// never-paid orders so the split reflects real fulfilled payments).
async function getOnlineVsCounter(days = 30): Promise<{ online: number; counter: number }> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { data, error } = await admin
    .from('orders')
    .select('payment_method')
    .gte('created_at', since)
    .not('payment_method', 'is', null);
  if (error) {
    console.error('online-vs-counter query failed', error);
    return { online: 0, counter: 0 };
  }
  let online = 0;
  let counter = 0;
  for (const row of (data ?? []) as { payment_method: string | null }[]) {
    if (row.payment_method === 'online') online++;
    else counter++;
  }
  return { online, counter };
}

// Payment-status counts (RET-2 "collected vs pending") over the last `days`.
async function getPaymentStatusCounts(days = 30): Promise<Record<string, number>> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { data, error } = await admin
    .from('orders')
    .select('payment_status')
    .gte('created_at', since);
  if (error) {
    console.error('payment-status counts query failed', error);
    return {};
  }
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { payment_status: string }[]) {
    counts[row.payment_status] = (counts[row.payment_status] ?? 0) + 1;
  }
  return counts;
}

export default async function OwnerPaymentsPage() {
  const [mix, split, statusCounts] = await Promise.all([
    getPaymentMix(),
    getOnlineVsCounter(30),
    getPaymentStatusCounts(30),
  ]);

  const totalCollected = mix.reduce((sum, r) => sum + r.collected_inr, 0);
  // v_payment_mix's refunded_inr_total is a single grand total repeated on
  // every row (not per-method) — take it once, never sum across rows.
  const totalRefunded = mix[0]?.refunded_inr_total ?? 0;
  const refundRatePct = totalCollected > 0 ? Math.round((totalRefunded / totalCollected) * 100) : 0;

  const totalSplit = split.online + split.counter;
  const onlinePct = totalSplit > 0 ? Math.round((split.online / totalSplit) * 100) : 0;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Payments</h1>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Collected" value={`₹${totalCollected}`} />
        <StatCard label="Refunded" value={`₹${totalRefunded}`} sub={`${refundRatePct}% of collected`} />
        <StatCard label="Online share (30d)" value={`${onlinePct}%`} sub={`${split.online} of ${totalSplit} paid orders`} />
        <StatCard label="Pending payment" value={String(statusCounts.payment_pending ?? 0)} sub="last 30 days" />
      </div>

      <Card title="Method mix">
        {mix.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No payments recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {mix.map((row) => (
              <li
                key={row.method}
                className="flex items-center justify-between border-b border-[#f2efe9] py-2 last:border-0"
              >
                <span className="font-bold uppercase text-charcoal">{row.method}</span>
                <span className="text-muted">
                  {row.payments} payment{row.payments === 1 ? '' : 's'} · ₹{row.collected_inr}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Online vs pay-at-counter · last 30 days">
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-[#f2efe9]">
          <div className="bg-tan" style={{ width: `${onlinePct}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted">
          {split.online} online · {split.counter} at the counter
        </p>
      </Card>

      <Card title="Payment status · last 30 days">
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          {['unpaid', 'payment_pending', 'paid', 'refunded', 'partially_refunded'].map((s) => (
            <div key={s} className="rounded-md bg-[#f2efe9] p-2 text-center">
              <p className="text-lg font-bold text-charcoal">{statusCounts[s] ?? 0}</p>
              <p className="text-[10px] uppercase text-muted">{s.replace('_', ' ')}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold text-charcoal">{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}
