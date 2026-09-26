// Customer analytics (RET-1) + segregation fix (owner feedback: "Customer is
// not segregated in Owner app ... orders all show as 'customer'"). Server
// component, styled like app/owner/page.tsx.
//
// "Identified customers" used to come straight from v_customer_stats
// (supabase/phase2-migration.sql §10), which groups ONLY by orders.user_id —
// so a regular linked at the counter by phone (orders.customer_user_id,
// supabase/2026-08-counter-loyalty.sql) was invisible, lumped in with
// one-off walk-ins. That's now computed here in TypeScript instead, from raw
// order rows over a bounded recent window (SEGMENTATION_DAYS below), grouped
// by COALESCE(user_id, customer_user_id) — see lib/analytics/customerSegments.ts
// (segmentCustomers, pure/unit-tested) and
// lib/analytics/queries.ts#getOrdersForCustomerSegmentation. Deliberately NOT a
// new SQL view/migration: there is already a backlog of unapplied ones
// (supabase/2026-08-counter-loyalty.sql, the pos-devices migration — see
// memory), and a bounded JS scan is cheap at cafe volume (same precedent as
// getStatusCounts/getDineInPeakHours in queries.ts).
//
// One behavior change from before: "Identified customers" / AOV / LTV below
// are now "last SEGMENTATION_DAYS days", not all-time — v_customer_stats had
// no window at all, which doesn't compose with a bounded scan. New vs
// returning still reads v_new_vs_returning (RET-1 view, user_id-only —
// unchanged; a true cohort view combining both link types is out of this
// pillar's scope, same note as before).

import {
  getCustomerSegmentation,
  getNewVsReturning,
} from '@/lib/analytics/queries';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { Card } from '@/components/owner/dashboard';
import type { IdentifiedCustomerAgg } from '@/lib/analytics/customerSegments';
import type { NewVsReturningRow } from '@/lib/types';
import {
  getPetpoojaCustomerOverview,
} from '@/lib/legacy/ownerStats';
import type { PetpoojaCustomerForDisplay } from '@/lib/legacy/ownerStats';

export const dynamic = 'force-dynamic';

const TOP_N = 10;
const SEGMENTATION_DAYS = 90;

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

/**
 * Format a rupee amount with Indian grouping: 1,00,000 for 100000.
 */
function formatRupees(amount: number): string {
  return Math.round(amount).toLocaleString('en-IN');
}

/**
 * Format a date in IST (Asia/Kolkata timezone) as "D MMM YYYY", e.g. "25 Sep 2026".
 */
function formatDateIST(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

export default async function OwnerCustomersPage() {
  const admin = createAdminSupabaseClient();
  const [segmentation, nvr, petpoojaOverview] = await Promise.all([
    getCustomerSegmentation(SEGMENTATION_DAYS),
    getNewVsReturning(30),
    getPetpoojaCustomerOverview(admin, new Date()),
  ]);
  const { identified: stats, anonymousWalkInOrders, phoneOnlyGuestOrders, phoneOnlyGuestPhones } = segmentation;

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
  const names = await getNames(topBySpend.map((s) => s.key));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Customers</h1>
      <p className="-mt-3 text-xs text-muted">Identified-customer stats below cover the last {SEGMENTATION_DAYS} days.</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <Stat label="Identified customers" value={String(totalCustomers)} sub={`last ${SEGMENTATION_DAYS}d, web + counter`} />
        <Stat label="Repeat rate" value={`${repeatRate}%`} sub="≥2 orders" />
        <Stat label="Avg orders / customer" value={String(avgOrdersPerCustomer)} />
        <Stat label="Overall AOV" value={`₹${formatRupees(overallAov)}`} />
        <Stat label="Est. LTV / customer" value={`₹${formatRupees(ltvEstimate)}`} sub={`last ${SEGMENTATION_DAYS}d revenue`} />
        <Stat label="Walk-in orders" value={String(anonymousWalkInOrders)} sub="counter, no name/phone/account" />
        <Stat
          label="Phone-only guests"
          value={String(phoneOnlyGuestOrders)}
          sub={`${phoneOnlyGuestPhones} distinct number${phoneOnlyGuestPhones === 1 ? '' : 's'}, no account`}
        />
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

      {/* Petpooja customer base — Aug 2023 to Sep 2026 */}
      {petpoojaOverview.ok ? (
        <div className="mt-8">
          <h2 className="text-xl font-bold text-charcoal mb-5">Petpooja Customer Base</h2>
          <p className="text-xs text-muted mb-5">Historical customer data from the POS system, Aug 2023 – Sep 2026. Read-only archive.</p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Total Petpooja customers" value={String(petpoojaOverview.stats.totalCustomers)} />
            <Stat label="With ≥1 completed bill" value={String(petpoojaOverview.stats.customersWithBills)} />
            <Stat label="Repeat customers" value={String(petpoojaOverview.stats.repeatCustomers)} sub="≥2 orders" />
            <Stat label="All-time spend" value={`₹${formatRupees(petpoojaOverview.stats.totalSpendInr)}`} sub="Aug 2023 – Sep 2026" />
          </div>

          <div className="grid gap-5 lg:grid-cols-2 mt-5">
            <Card title="Top Petpooja customers by spend">
              <TopPetpoojaTable rows={petpoojaOverview.top} />
            </Card>
            <Card title="Lapsed regulars">
              <LapsedRegularsTable rows={petpoojaOverview.lapsed} />
            </Card>
          </div>
        </div>
      ) : (
        <p className="mt-8 text-xs text-muted">Petpooja data unavailable right now</p>
      )}
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

function TopCustomerTable({ rows, names }: { rows: IdentifiedCustomerAgg[]; names: Map<string, NameRow> }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No customers yet</p>;
  }
  return (
    <div className="overflow-x-auto">
    <table className="w-full min-w-[420px] text-sm">
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
          const n = names.get(r.key);
          // Fall back to the order's own customer_name/phone (typed at the
          // counter) when the profile has neither — see sample_name/phone on
          // segmentCustomers.
          const displayName = n?.name || r.sample_name || 'Customer';
          const displayPhone = n?.phone || r.sample_phone || '—';
          return (
            <tr key={r.key} className="border-b border-[#f2efe9]">
              <td className="py-1.5 text-charcoal">
                {displayName}
                <span className="block text-xs text-muted">{displayPhone}</span>
              </td>
              <td className="py-1.5 text-right text-charcoal">{r.orders}</td>
              <td className="py-1.5 text-right font-bold text-tan">₹{r.revenue_inr}</td>
              <td className="py-1.5 text-right text-muted">₹{r.aov_inr}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function TopPetpoojaTable({ rows }: { rows: PetpoojaCustomerForDisplay[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No Petpooja customers yet</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase text-muted">
            <th className="py-1 font-bold">Customer</th>
            <th className="py-1 text-right font-bold">Bills</th>
            <th className="py-1 text-right font-bold">Spend</th>
            <th className="py-1 text-right font-bold">Last bill</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.key} className="border-b border-[#f2efe9]">
              <td className="py-1.5 text-charcoal">
                {r.name}
                <span className="block text-xs text-muted">{r.maskedPhone}</span>
              </td>
              <td className="py-1.5 text-right text-charcoal">{r.orderCount}</td>
              <td className="py-1.5 text-right font-bold text-tan">₹{formatRupees(r.totalSpendInr)}</td>
              <td className="py-1.5 text-right text-muted text-xs">
                {r.lastOrderAt ? formatDateIST(r.lastOrderAt) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LapsedRegularsTable({ rows }: { rows: PetpoojaCustomerForDisplay[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No lapsed regulars yet</p>;
  }
  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        <b>Win-back candidates:</b> These regulars haven&apos;t ordered in 60+ days, in Petpooja or in this app. Petpooja never collected marketing consent, so reach out through a channel that collects consent first.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase text-muted">
              <th className="py-1 font-bold">Customer</th>
              <th className="py-1 text-right font-bold">Bills</th>
              <th className="py-1 text-right font-bold">Spend</th>
              <th className="py-1 text-right font-bold">Last bill</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key} className="border-b border-[#f2efe9]">
                <td className="py-1.5 text-charcoal">
                  {r.name}
                  <span className="block text-xs text-muted">{r.maskedPhone}</span>
                </td>
                <td className="py-1.5 text-right text-charcoal">{r.orderCount}</td>
                <td className="py-1.5 text-right font-bold text-tan">₹{formatRupees(r.totalSpendInr)}</td>
                <td className="py-1.5 text-right text-muted text-xs">
                  {r.lastOrderAt ? formatDateIST(r.lastOrderAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
