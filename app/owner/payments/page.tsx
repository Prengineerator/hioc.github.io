// Owner payment analytics (RET-2/OWN-009). Server component, styled like
// app/owner/page.tsx. "How the money came in" and the Collected / Refunded
// figures come from the reconciliation report (lib/reports/reconcile.ts) over
// the last 30 IST days: every tender, i.e. cash, UPI and card at the counter,
// split bills, and website payments. (They used to read v_payment_mix, which
// only sees the online gateway's `payments` table, so counter money never
// showed.) The website-vs-counter split and collected-vs-pending are direct
// aggregate queries, all through the service-role client.

import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { Card, inr, PaymentsByMethod } from '@/components/owner/dashboard';
import { istDateDaysAgo, istDateIso } from '@/lib/api/date';
import { loadReport } from '@/lib/reports/reconcileServer';
import type { Report } from '@/lib/reports/reconcile';
import { APP_PAYMENT_METHODS } from '@/lib/orders/payments';
import { formatIstDateTime, PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import { formatOrderNumber } from '@/lib/utils/orderNumber';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;

async function getLast30Days(): Promise<Report | null> {
  try {
    return await loadReport(createAdminSupabaseClient(), istDateDaysAgo(29), istDateIso());
  } catch (err) {
    console.error('owner payments: report failed', err);
    return null;
  }
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

interface AppPaymentRow {
  at: string;
  orderNumber: number | null;
  method: string;
  amountInr: number;
  reference: string | null;
  /** Cancelled, rejected or fully refunded — the platform shouldn't be paying for it. */
  dead: boolean;
}

// Every dining-app tender (Swiggy Dineout, Zomato District) over the last
// `days`, newest first, with the booking ID the counter recorded — the list the
// owner ticks off against each platform's payout statement. Null on a query
// failure (most likely 2026-10-aggregator-payments.sql not applied yet).
async function getAppPayments(days = 30): Promise<AppPaymentRow[] | null> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { data, error } = await admin
    .from('order_payments')
    .select('order_id, method, amount_inr, reference, created_at')
    .in('method', [...APP_PAYMENT_METHODS])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) {
    console.error('dining-app payments query failed', error);
    return null;
  }
  const rows = (data ?? []) as {
    order_id: string;
    method: string;
    amount_inr: number;
    reference: string | null;
    created_at: string;
  }[];
  if (rows.length === 0) return [];
  const { data: orders } = await admin
    .from('orders')
    .select('id, order_number, status, payment_status')
    .in('id', [...new Set(rows.map((r) => r.order_id))]);
  const byId = new Map(
    ((orders ?? []) as { id: string; order_number: number; status: string; payment_status: string }[]).map((o) => [
      o.id,
      o,
    ]),
  );
  return rows.map((r) => {
    const o = byId.get(r.order_id);
    return {
      at: r.created_at,
      orderNumber: o?.order_number ?? null,
      method: r.method,
      amountInr: r.amount_inr,
      reference: r.reference,
      dead: !!o && (o.status === 'cancelled' || o.status === 'rejected' || o.payment_status === 'refunded'),
    };
  });
}

export default async function OwnerPaymentsPage() {
  const [report, split, statusCounts, appPayments] = await Promise.all([
    getLast30Days(),
    getOnlineVsCounter(30),
    getPaymentStatusCounts(30),
    getAppPayments(30),
  ]);

  const totalCollected = report?.totals.receivedTotalInr ?? 0;
  const totalRefunded = report?.totals.refundsTotalInr ?? 0;
  const refundRatePct = totalCollected > 0 ? Math.round((totalRefunded / totalCollected) * 100) : 0;

  const totalSplit = split.online + split.counter;
  const onlinePct = totalSplit > 0 ? Math.round((split.online / totalSplit) * 100) : 0;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Payments</h1>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Collected (30d)" value={inr(totalCollected)} sub="cash, UPI, card and online" />
        <StatCard label="Refunded (30d)" value={inr(totalRefunded)} sub={`${refundRatePct}% of collected`} />
        <StatCard label="Online share (30d)" value={`${onlinePct}%`} sub={`${split.online} of ${totalSplit} paid orders`} />
        <StatCard label="Pending payment" value={String(statusCounts.payment_pending ?? 0)} sub="last 30 days" />
      </div>

      <Card title="How the money came in · last 30 days">
        {report ? (
          <PaymentsByMethod
            received={report.totals.received}
            refunds={report.totals.refunds}
            unpaidInr={report.totals.unpaidInr}
            unpaidOrders={report.totals.unpaidOrders}
            reportHref={`/owner/reports?from=${report.from}&to=${report.to}`}
          />
        ) : (
          <p className="py-6 text-center text-sm text-muted">Payments could not be loaded.</p>
        )}
      </Card>

      <Card title="Dining-app payments · last 30 days">
        <AppPaymentsTable rows={appPayments} />
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

function AppPaymentsTable({ rows }: { rows: AppPaymentRow[] | null }) {
  if (rows === null) {
    return <p className="py-6 text-center text-sm text-muted">Dining-app payments could not be loaded.</p>;
  }
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No Swiggy Dineout or Zomato District payments yet.</p>;
  }
  const totals = APP_PAYMENT_METHODS.map((m) => ({
    method: m,
    count: rows.filter((r) => r.method === m && !r.dead).length,
    amountInr: rows.filter((r) => r.method === m && !r.dead).reduce((sum, r) => sum + r.amountInr, 0),
  }));
  return (
    <div>
      <p className="text-sm text-charcoal">
        {totals.map((t, i) => (
          <span key={t.method}>
            {i > 0 ? ' · ' : ''}
            <span className="font-bold">{PAYMENT_METHOD_LABEL[t.method]}</span> {inr(t.amountInr)} ({t.count})
          </span>
        ))}
      </p>
      <p className="mt-1 text-xs text-muted">
        Match each booking ID against the platform&rsquo;s payout statement. Amounts are the bill, before the
        platform&rsquo;s commission.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="py-1.5 pr-3">When</th>
              <th className="py-1.5 pr-3">Order</th>
              <th className="py-1.5 pr-3">App</th>
              <th className="py-1.5 pr-3">Booking ID</th>
              <th className="py-1.5 pr-3 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`border-t border-[#f2efe9] ${r.dead ? 'text-muted line-through' : 'text-charcoal'}`}>
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatIstDateTime(r.at)}</td>
                <td className="py-1.5 pr-3">{r.orderNumber !== null ? formatOrderNumber(r.orderNumber) : '—'}</td>
                <td className="py-1.5 pr-3">{PAYMENT_METHOD_LABEL[r.method] ?? r.method}</td>
                <td className="py-1.5 pr-3 font-mono font-bold">
                  {r.reference ?? <span className="font-sans font-normal text-amber-800">not recorded</span>}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{inr(r.amountInr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.dead) ? (
        <p className="mt-2 text-xs text-muted">Struck through: cancelled, rejected or fully refunded — left out of the totals.</p>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold text-charcoal">{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}
