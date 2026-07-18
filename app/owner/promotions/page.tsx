// Owner promotions surface (LOY-2/LOY-5/RET-3). The coupon-performance table
// reads straight from v_coupon_performance via the admin client (a plain
// Server Component read, same convention as app/owner/page.tsx); coupon +
// announcement CRUD is delegated to client components that talk to
// app/api/coupons and app/api/announcements.

import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { Card } from '@/components/owner/dashboard';
import { CouponManager } from '@/components/promotions/CouponManager';
import { AnnouncementManager } from '@/components/promotions/AnnouncementManager';
import type { CouponPerformanceRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function getCouponPerformance(): Promise<CouponPerformanceRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('v_coupon_performance')
    .select('*')
    .order('discount_given_inr', { ascending: false });
  if (error) {
    console.error('getCouponPerformance failed', error);
    return [];
  }
  return (data ?? []) as CouponPerformanceRow[];
}

export default async function OwnerPromotionsPage() {
  const performance = await getCouponPerformance();
  const totalRedemptions = performance.reduce((sum, r) => sum + r.redemptions, 0);
  const totalDiscount = performance.reduce((sum, r) => sum + r.discount_given_inr, 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6">
      <h1 className="text-2xl font-bold text-charcoal">Promotions</h1>

      <Card title="Coupon performance">
        <div className="mb-4 flex gap-6 text-sm">
          <span className="text-charcoal">
            <span className="font-bold">{totalRedemptions}</span> redemptions
          </span>
          <span className="text-charcoal">
            <span className="font-bold">₹{totalDiscount}</span> total discount given
          </span>
        </div>
        {performance.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No coupon redemptions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead>
                <tr className="border-b border-[#e5e5e5] text-xs uppercase text-muted">
                  <th className="py-2 pr-3">Code</th>
                  <th className="py-2 pr-3">Redemptions</th>
                  <th className="py-2 pr-3">Discount given</th>
                </tr>
              </thead>
              <tbody>
                {performance.map((row) => (
                  <tr key={row.code} className="border-b border-[#f2efe9]">
                    <td className="py-2 pr-3 font-bold text-charcoal">{row.code}</td>
                    <td className="py-2 pr-3 text-charcoal">{row.redemptions}</td>
                    <td className="py-2 pr-3 text-charcoal">₹{row.discount_given_inr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Coupons">
        <CouponManager />
      </Card>

      <Card title="Announcements">
        <AnnouncementManager />
      </Card>
    </div>
  );
}
