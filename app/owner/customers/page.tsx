// Customer analytics (RET-1). Server component reading the Phase-2 analytics
// views (supabase/phase2-migration.sql §10) via the admin client: new vs
// returning split, repeat rate, top customers by spend, AOV, avg
// orders/customer, and an LTV estimate. Styled like app/owner/page.tsx.
//
// NOTE: v_customer_stats/v_new_vs_returning are all-time/rolling-window
// aggregates, not per-cohort — a true 30/60/90-day repeat-rate cohort and
// cohort-retention curve would need additional SQL views, which is out of
// this pillar's scope (see final report). "Repeat rate" below is computed
// all-time from v_customer_stats; "new vs returning" uses the view's daily
// rows over the last 30 days.

import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { Card } from '@/components/owner/dashboard';
import type { CustomerStatsRow, NewVsReturningRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_N = 10;

async function getCustomerStats(): Promise<CustomerStatsRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('v_customer_stats')
    .select('*')
    .order('revenue_inr', { ascending: false });
  if (error) {
    console.error('v_customer_stats query failed', error);
    return [];
  }
  return (data ?? []) as CustomerStatsRow[];
}

async function getNewVsReturning(days: number): Promise<NewVsReturningRow[]> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await admin
    .from('v_new_vs_returning')
    .select('*')
    .gte('order_date', since)
    .order('order_date', { ascending: false });
  if (error) {
    console.error('v_new_vs_returning query failed', error);
    return [];
  }
  return (data ?? []) as NewVsReturningRow[];
}

interface NameRow {
  id: string;
  name: string;
  phone: string;
}

async function getNames(userIds: string[]): Promise<Map<string, NameRow>> {
  if (userIds.length === 0) return new Map();
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('profiles').select('id, name, phone').in('id', userIds);
  if (error) {
    console.error('profiles lookup for top customers failed', error);
    return new Map();
  }
  return new Map((data ?? []).map((r) => [r.id as string, r as NameRow]));
}

export default async function OwnerCustomersPage() {
  const [stats, nvr] = await Promise.all([getCustomerStats(), getNewVsReturning(30)]);

  const totalCustomers = stats.length;
  const repeatCustomers = stats.filter((s) => s.orders > 1).length;
  const repeatRate = totalCustomers ? Math.round((repeatCustomers / totalCustomers) * 100) : 0;
  const totalOrders = stats.reduce((sum, s) => sum + s.orders, 0);
  const totalRevenue = stats.reduce((sum, s) => sum + s.revenue_inr, 0);
  const avgOrdersPerCustomer = totalCustomers ? Math.round((totalOrders / totalCustomers) * 10) / 10 : 0;
  const overallAov = totalOrders ? Math.round(totalRevenue / totalOrders) : 0;
  const ltvEstimate = totalCustomers ? Math.round(totalRevenue / totalCustomers) : 0;

  const newSum = nvr.reduce((sum, r) => sum + r.new_customers, 0);
  const returningSum = nvr.reduce((sum, r) => sum + r.returning_customers, 0);

  const topBySpend = stats.slice(0, TOP_N);
  const names = await getNames(topBySpend.map((s) => s.user_id));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Customers</h1>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Identified customers" value={String(totalCustomers)} />
        <Stat label="Repeat rate" value={`${repeatRate}%`} sub="all-time, ≥2 orders" />
        <Stat label="Avg orders / customer" value={String(avgOrdersPerCustomer)} />
        <Stat label="Overall AOV" value={`₹${overallAov}`} />
        <Stat label="Est. LTV / customer" value={`₹${ltvEstimate}`} sub="lifetime revenue to date" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="New vs returning · last 30 days">
          <div className="mb-3 flex gap-4 text-sm">
            <span className="text-charcoal">
              <span className="inline-block h-2 w-2 rounded-full bg-tan align-middle" />{' '}
              <b>{newSum}</b> new
            </span>
            <span className="text-charcoal">
              <span className="inline-block h-2 w-2 rounded-full bg-[#c9b7a4] align-middle" />{' '}
              <b>{returningSum}</b> returning
            </span>
          </div>
          <NewVsReturningBars rows={nvr} />
        </Card>
        <Card title="Top customers by spend">
          <TopCustomerTable rows={topBySpend} names={names} />
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold text-charcoal">{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function NewVsReturningBars({ rows }: { rows: NewVsReturningRow[] }) {
  const data = [...rows].reverse();
  if (data.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No identified-customer orders yet</p>;
  }
  const max = Math.max(...data.map((r) => Math.max(r.new_customers, r.returning_customers)), 1);
  return (
    <div className="flex h-40 items-end gap-1">
      {data.map((r) => (
        <div
          key={r.order_date}
          className="flex flex-1 items-end justify-center gap-0.5"
          title={`${r.order_date}: ${r.new_customers} new, ${r.returning_customers} returning`}
        >
          <div className="w-1/2 rounded-t bg-tan" style={{ height: `${(r.new_customers / max) * 100}%` }} />
          <div
            className="w-1/2 rounded-t bg-[#c9b7a4]"
            style={{ height: `${(r.returning_customers / max) * 100}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function TopCustomerTable({ rows, names }: { rows: CustomerStatsRow[]; names: Map<string, NameRow> }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No customers yet</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase text-muted">
          <th className="py-1 font-bold">Customer</th>
          <th className="py-1 text-right font-bold">Orders</th>
          <th className="py-1 text-right font-bold">Spend</th>
          <th className="py-1 text-right font-bold">AOV</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const n = names.get(r.user_id);
          return (
            <tr key={r.user_id} className="border-b border-[#f2efe9]">
              <td className="py-1.5 text-charcoal">
                {n?.name || 'Customer'}
                <span className="block text-xs text-muted">{n?.phone || '—'}</span>
              </td>
              <td className="py-1.5 text-right text-charcoal">{r.orders}</td>
              <td className="py-1.5 text-right font-bold text-tan">₹{r.revenue_inr}</td>
              <td className="py-1.5 text-right text-muted">₹{r.aov_inr}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
