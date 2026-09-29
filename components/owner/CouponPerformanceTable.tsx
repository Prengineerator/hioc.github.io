'use client';

// Coupon-performance table for app/owner/promotions/page.tsx. The page is a
// server component (it reads v_coupon_performance), so the sortable/filterable
// table lives here as a client wrapper that receives the plain rows.

import { DataTable } from '@/components/ui/DataTable';
import type { CouponPerformanceRow } from '@/lib/types';

export function CouponPerformanceTable({ rows }: { rows: CouponPerformanceRow[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.code}
      emptyMessage="No coupon redemptions yet."
      minWidth={420}
      cellPadding="py-2 pr-3"
      headerTextClassName="text-xs uppercase text-muted"
      columns={[
        { key: 'code', header: 'Code', filter: 'text', value: (r) => r.code, cellClassName: 'font-bold text-charcoal' },
        {
          key: 'redemptions',
          header: 'Redemptions',
          filter: 'number',
          value: (r) => r.redemptions,
          cellClassName: 'text-charcoal',
        },
        {
          key: 'discount',
          header: 'Discount given',
          filter: 'number',
          value: (r) => r.discount_given_inr,
          cellClassName: 'text-charcoal',
          render: (r) => `₹${r.discount_given_inr}`,
        },
      ]}
    />
  );
}
