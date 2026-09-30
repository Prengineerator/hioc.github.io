import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { isInStoreOnly } from '@/lib/menu/inStore';
import { applyMenuSwitches, isCategoryHidden, switchesFromSettings } from '@/lib/menu/menuSwitches';
import { MENU_ITEM_SELECT, shapeMenuItem, type MenuItemRow } from '@/lib/orders/lines';
import { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import { loadActivePlans } from '@/lib/passes/server';
import { isGatewayConfigured } from '@/lib/payments/gateway';
import { getStoreSettings } from '@/lib/store/settings';

export const dynamic = 'force-dynamic';

// GET /api/passes/plans — public (the /ritual page is readable signed out).
//
// Everything the page needs to show the offer and nothing that is not already
// public on the menu:
//   plans           the plans on sale (is_active), in the owner's own sort_order.
//                   Inactive plans never leave the server. A plan has no price
//                   (CP-D24: price_inr and drink_value_inr are null): what a
//                   customer pays depends on the drink they pick, see `eligible`.
//   eligible        the drinks a Ritual can be bought for (menu_items.pass_eligible)
//                   with the SIZES on sale and each size's menu price, so the page
//                   can show "Cappuccino L ₹120 → ₹600" before anything is bought
//                   (price = the plan's drinks_paid × the size's price, CP-D22).
//                   `is_available` lets the page grey out a drink that is off the
//                   menu today rather than hide it. The server stays authoritative:
//                   POST /api/passes/checkout prices the cup again from the menu.
//   online_purchase whether the server holds Razorpay keys. There is no "reserve
//                   and pay at the counter" (CP-D8), so when this is false the
//                   page shows "Buy at the counter" instead of a Buy button. It
//                   asks the gateway module's own credentials check, so it cannot
//                   disagree with what a real payment attempt would do.
//   gst             the store's GST setting, so the page can say "+ GST" (or not)
//                   next to a price without hard-coding a rate.
//
// WHAT COUNTS AS "ON SALE" for a drink is what the menu shows the customer, by the
// same rules (lib/menu/menuSwitches.ts applyMenuSwitches): a switched-off category
// drops the drink, a switched-off size (store_settings.hidden_variant_labels, by
// name, everywhere or per category) drops that size, and an item whose only sizes
// are switched off keeps them (the menu's own safety rule). On top of that, a drink
// with no size left, a size priced at ₹0 (a Ritual needs a cup value of at least
// ₹1) and an in-store-only drink (the website would refuse it: this list is public)
// are omitted. Sizes are cheapest first.
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
      .select(MENU_ITEM_SELECT)
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

  const switches = switchesFromSettings(settings);
  const eligible = ((menu.data ?? []) as unknown as MenuItemRow[])
    .map((row) => applyMenuSwitches(shapeMenuItem(row), switches))
    .filter((item) => !isCategoryHidden(item.category, switches.hiddenCategories) && !isInStoreOnly(item))
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      is_available: isMenuItemAvailable(item),
      sizes: item.variants
        .filter((v) => v.price_inr >= 1)
        .map((v) => ({ variant_id: v.id, label: v.label, price_inr: v.price_inr, sort_order: v.sort_order }))
        .sort((a, b) => a.price_inr - b.price_inr || a.sort_order - b.sort_order || a.label.localeCompare(b.label))
        .map(({ variant_id, label, price_inr }) => ({ variant_id, label, price_inr })),
    }))
    .filter((item) => item.sizes.length > 0);

  return NextResponse.json({
    plans, // already in the owner's sort_order (loadActivePlans)
    eligible,
    online_purchase: isGatewayConfigured(),
    gst: { percent: settings.gst_percent, inclusive: settings.gst_inclusive },
  });
}
