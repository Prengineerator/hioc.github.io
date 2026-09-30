import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import { loadActivePlans } from '@/lib/passes/server';
import { isGatewayConfigured } from '@/lib/payments/gateway';
import { getStoreSettings } from '@/lib/store/settings';

export const dynamic = 'force-dynamic';

// GET /api/passes/plans — public (the /ritual page is readable signed out).
//
// Everything the page needs to show the offer and nothing that is not already
// public on the menu:
//   plans           the plans on sale (is_active), cheapest-to-dearest inside the
//                   owner's own sort_order. Inactive plans never leave the server.
//   eligible        the drinks a pass can pay for (menu_items.pass_eligible), for
//                   the chips under the plans. `is_available` lets the page grey
//                   out one that is off the menu today rather than hide it.
//   online_purchase whether the server holds Razorpay keys. There is no "reserve
//                   and pay at the counter" (CP-D8), so when this is false the
//                   page shows "Buy at the counter" instead of a Buy button. It
//                   asks the gateway module's own credentials check, so it cannot
//                   disagree with what a real payment attempt would do.
//   gst             the store's GST setting, so the page can say "+ GST" (or not)
//                   next to a price without hard-coding a rate.
//
// Flag off: 404, so the feature does not exist until the owner switches it on.
export async function GET() {
  const off = coffeePassDisabled();
  if (off) return off;

  const admin = createAdminSupabaseClient();
  const [plans, menu, settings] = await Promise.all([
    loadActivePlans(admin),
    admin
      .from('menu_items')
      .select('id, name, category, is_available, sort_order')
      .eq('pass_eligible', true)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    getStoreSettings(),
  ]);
  if (menu.error) {
    console.error('GET /api/passes/plans: eligible drinks failed', menu.error);
    return errorResponse(
      500,
      isMissingPassSchema(menu.error)
        ? `Could not load the plans — ${PASS_MIGRATION_HINT}`
        : 'Could not load the plans.',
    );
  }

  const eligible = ((menu.data ?? []) as { id: string; name: string; category: string; is_available: boolean }[]).map(
    (m) => ({ id: m.id, name: m.name, category: m.category, is_available: m.is_available !== false }),
  );

  return NextResponse.json({
    plans: [...plans].sort(
      (a, b) => a.sort_order - b.sort_order || a.price_inr - b.price_inr || a.name.localeCompare(b.name),
    ),
    eligible,
    online_purchase: isGatewayConfigured(),
    gst: { percent: settings.gst_percent, inclusive: settings.gst_inclusive },
  });
}
