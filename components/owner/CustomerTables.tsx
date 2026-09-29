'use client';

// The three customer tables on app/owner/customers/page.tsx. That page is a
// server component, so each table is a client wrapper over plain, serialisable
// rows (the page resolves profile names and passes flat rows, not Maps).

import { DataTable } from '@/components/ui/DataTable';
import type { PetpoojaCustomerForDisplay } from '@/lib/legacy/ownerStats';

/** Format a rupee amount with Indian grouping: 1,00,000 for 100000. */
function formatRupees(amount: number): string {
  return Math.round(amount).toLocaleString('en-IN');
}

/** Format a date in IST (Asia/Kolkata timezone) as "D MMM YYYY", e.g. "25 Sep 2026". */
function formatDateIST(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

export interface TopCustomerRow {
  key: string;
  name: string;
  phone: string;
  orders: number;
  revenue_inr: number;
  aov_inr: number;
}

const HEADER = 'text-xs font-bold uppercase text-muted';

export function TopCustomerTable({ rows }: { rows: TopCustomerRow[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.key}
      emptyMessage="No customers yet"
      minWidth={420}
      headerTextClassName={HEADER}
      columns={[
        {
          key: 'customer',
          header: 'Customer',
          filter: 'text',
          // Search matches the name and the phone.
          value: (r) => `${r.name} ${r.phone}`,
          cellClassName: 'text-charcoal',
          render: (r) => (
            <>
              {r.name}
              <span className="block text-xs text-muted">{r.phone}</span>
            </>
          ),
        },
        {
          key: 'orders',
          header: 'Orders',
          filter: 'number',
          align: 'right',
          value: (r) => r.orders,
          cellClassName: 'text-charcoal',
        },
        {
          key: 'spend',
          header: 'Spend',
          filter: 'number',
          align: 'right',
          value: (r) => r.revenue_inr,
          cellClassName: 'font-bold text-tan-dark',
          render: (r) => `₹${r.revenue_inr}`,
        },
        {
          key: 'aov',
          header: 'AOV',
          filter: 'number',
          align: 'right',
          value: (r) => r.aov_inr,
          cellClassName: 'text-muted',
          render: (r) => `₹${r.aov_inr}`,
        },
      ]}
    />
  );
}

/** Shared by the "top" and "lapsed" Petpooja lists, which show the same columns. */
function PetpoojaTable({ rows, emptyMessage }: { rows: PetpoojaCustomerForDisplay[]; emptyMessage: string }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.key}
      emptyMessage={emptyMessage}
      minWidth={420}
      headerTextClassName={HEADER}
      columns={[
        {
          key: 'customer',
          header: 'Customer',
          filter: 'text',
          value: (r) => `${r.name} ${r.maskedPhone}`,
          cellClassName: 'text-charcoal',
          render: (r) => (
            <>
              {r.name}
              <span className="block text-xs text-muted">{r.maskedPhone}</span>
            </>
          ),
        },
        {
          key: 'bills',
          header: 'Bills',
          filter: 'number',
          align: 'right',
          value: (r) => r.orderCount,
          cellClassName: 'text-charcoal',
        },
        {
          key: 'spend',
          header: 'Spend',
          filter: 'number',
          align: 'right',
          value: (r) => r.totalSpendInr,
          cellClassName: 'font-bold text-tan-dark',
          render: (r) => `₹${formatRupees(r.totalSpendInr)}`,
        },
        {
          key: 'last_bill',
          header: 'Last bill',
          filter: 'date',
          align: 'right',
          value: (r) => r.lastOrderAt,
          cellClassName: 'text-xs text-muted',
          render: (r) => (r.lastOrderAt ? formatDateIST(r.lastOrderAt) : '—'),
        },
      ]}
    />
  );
}

export function TopPetpoojaTable({ rows }: { rows: PetpoojaCustomerForDisplay[] }) {
  return <PetpoojaTable rows={rows} emptyMessage="No Petpooja customers yet" />;
}

export function LapsedRegularsTable({ rows }: { rows: PetpoojaCustomerForDisplay[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No lapsed regulars yet</p>;
  }
  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        <b>Win-back candidates:</b> These regulars haven&apos;t ordered in 60+ days, in Petpooja or in this app. Petpooja never collected marketing consent, so reach out through a channel that collects consent first.
      </p>
      <PetpoojaTable rows={rows} emptyMessage="No lapsed regulars yet" />
    </div>
  );
}
