import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser, getCounterActor } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { getStoreSettings } from '@/lib/store/settings';
import { validateAndComputeCoupon } from '@/lib/promotions/coupons';
import { getBalance, quoteRedemption } from '@/lib/loyalty/ledger';
import { findVerifiedCustomerByPhone, toStoredPhone } from '@/lib/loyalty/customerLink';
import { switchesFromSettings } from '@/lib/menu/menuSwitches';
import {
  MENU_ITEM_SELECT,
  parseItems,
  resolveOrderLines,
  shapeMenuItem,
  type MenuItemRow,
  type ResolvedLine,
} from '@/lib/orders/lines';
import { afterPass, allocateOrderPass, composeOrderBill } from '@/lib/orders/passPricing';
import { parsePassDrinks, passShortfallMessage } from '@/lib/passes/rules';
import type { PassShortfall, PassSummary } from '@/lib/passes/types';

export const dynamic = 'force-dynamic';

/** The `pass` block of a quote (docs/COFFEE-PASS-SPEC.md §7). */
interface PassPreview {
  requested: number;
  applied: number;
  /** Rupees the pass covers on this cart. */
  discount_inr: number;
  /** Units in the cart a pass could pay for. */
  eligible_units: number;
  /** Cups left across the customer's usable passes (ignores the daily cap). */
  available: number;
  /** The most cups this cart could use right now: what the checkout pre-fills (CP-D10). */
  max_usable: number;
  shortfall: PassShortfall;
  message: string | null;
  /** The customer's usable passes, soonest-expiring first. */
  passes: PassSummary[];
}

// POST /api/orders/quote — public. A NON-authoritative checkout preview:
// given a cart (`items`, priced server-side exactly as POST /api/orders prices
// it) or, for older callers, a client-computed cart subtotal, plus an optional
// coupon code / Beanies to redeem / HIOC Ritual cups to use, returns the full
// bill breakup (subtotal/GST/packaging/pass/coupon discount/Beanies
// discount/total) so CheckoutForm can show it live (PAY-1) before the customer
// submits. POST /api/orders re-derives everything server-side from the actual
// cart + session at submit time — this route never creates or mutates
// anything, so a stale/spoofed subtotal here can't cost the business money.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const {
    subtotal_inr: clientSubtotal,
    taxable_subtotal_inr,
    coupon_code,
    redeem_points,
    item_ids,
    categories,
    order_type,
    customer_phone,
    items: rawItems,
  } = body;

  // Dine-in has no packaging charge (D5). The quote is a preview only, so we
  // don't hard-validate order_type here — any non-'dine_in' value is treated as
  // packaged, exactly as POST /api/orders re-derives authoritatively at submit.
  const isDineIn = order_type === 'dine_in';

  // HIOC Ritual cups to spend. Malformed is a 400 (the checkout never sends one);
  // a valid count while the feature is off is simply not previewed (`pass: null`).
  const passDrinksParsed = parsePassDrinks(body.pass_drinks);
  if (!passDrinksParsed.ok) return errorResponse(400, passDrinksParsed.error);
  const requestedPassDrinks = passDrinksParsed.value;

  // With `items` the server prices the cart itself and the client's subtotal is
  // ignored altogether (a spoofed one cannot even preview a wrong bill). Without
  // it this is the older subtotal-only preview, which cannot see which drinks a
  // pass could pay for, so it carries no pass block.
  const hasItems = rawItems !== undefined;
  if (!hasItems) {
    if (typeof clientSubtotal !== 'number' || !Number.isFinite(clientSubtotal) || clientSubtotal < 0) {
      return errorResponse(400, 'subtotal_inr must be a non-negative number');
    }
  }
  const parsedItems = hasItems ? parseItems(rawItems) : null;
  if (typeof parsedItems === 'string') return errorResponse(400, parsedItems);

  let itemIds: string[] = [];
  if (item_ids !== undefined) {
    if (!Array.isArray(item_ids) || item_ids.some((v) => typeof v !== 'string')) {
      return errorResponse(400, 'item_ids must be an array of strings');
    }
    itemIds = item_ids as string[];
  }

  let cats: string[] = [];
  if (categories !== undefined) {
    if (!Array.isArray(categories) || categories.some((v) => typeof v !== 'string')) {
      return errorResponse(400, 'categories must be an array of strings');
    }
    cats = categories as string[];
  }

  // VAL-1 — whose promotions and points this preview is about.
  //
  // On the web that is the caller's own session, as it always was. At the
  // counter the caller is STAFF (a classic session, or — PIN-3 — an enrolled
  // device's operator) and the beneficiary is the customer in front of them,
  // resolved from their phone by the same server-side, verified-only rule
  // POST /api/orders uses (never a body-supplied user id).
  //
  // Gated on staff access on purpose: this route is public and returns a
  // Beanies balance, so resolving a phone for anyone would turn it into a
  // "how many Beanies does this number have?" oracle for the whole internet.
  // The same goes for a pass: its cups are only ever shown to the account's own
  // session or to staff who resolved it by a verified phone.
  //
  // getAuthUser() and getCounterActor() are fetched concurrently rather than
  // one deriving the other (same accepted duplication as POST /api/orders):
  // getCounterActor() re-resolves its own session internally, and this route
  // fires on every cart change for what's usually an anonymous visitor, so
  // paying for a second round trip only when a session actually exists is the
  // right trade — see that route's own comment on why they can't share one.
  // Perf: getStoreSettings() depends on none of the auth/phone-link work above
  // it (same reasoning as POST /api/orders), so it's fired alongside those
  // instead of waiting behind them — this route runs on every cart edit, so
  // that's a round trip shaved off of every keystroke's re-quote, not just one.
  const [user, actor, settings] = await Promise.all([getAuthUser(), getCounterActor(), getStoreSettings()]);
  const isStaff = actor !== null;
  // The admin client is made only when something needs it: the anonymous,
  // subtotal-only preview (the common case) touches no table at all.
  let adminClient: ReturnType<typeof createAdminSupabaseClient> | null = null;
  const admin = () => (adminClient ??= createAdminSupabaseClient());
  const linked = isStaff ? await findVerifiedCustomerByPhone(admin(), toStoredPhone(customer_phone)) : null;
  const userId = linked?.userId ?? (isStaff ? null : (user?.id ?? null));

  // Price the cart server-side when it was sent: the same menu read and the same
  // resolver POST /api/orders uses, so the preview cannot drift from the charge.
  let subtotalInr: number;
  let taxableInr: number;
  let resolvedLines: ResolvedLine[] | null = null;
  if (parsedItems) {
    const menuIds = [...new Set(parsedItems.map((i) => i.menu_item_id))];
    const { data: menuRows, error: menuError } = await admin()
      .from('menu_items')
      .select(MENU_ITEM_SELECT)
      .in('id', menuIds);
    if (menuError) return errorResponse(500, 'Failed to validate order items');
    const menuById = new Map(
      (menuRows ?? []).map((row) => [row.id, shapeMenuItem(row as unknown as MenuItemRow)]),
    );
    const resolved = resolveOrderLines(parsedItems, menuById, switchesFromSettings(settings));
    if (!resolved.ok) return errorResponse(400, resolved.error);
    resolvedLines = resolved.lines;
    subtotalInr = resolved.subtotalInr;
    taxableInr = resolved.taxableSubtotalInr;
    // The coupon is judged on what is actually in the cart, as at submit.
    itemIds = resolved.lines.map((l) => l.menu_item_id);
    cats = [
      ...new Set(
        resolved.lines.map((l) => menuById.get(l.menu_item_id)?.category).filter((c): c is string => Boolean(c)),
      ),
    ];
  } else {
    subtotalInr = clientSubtotal as number;
    // GST-exempt lines (2026-09-gst-exempt): the client says how much of the
    // subtotal is taxable. This is a preview only — the order route recomputes
    // it from the menu — so an absent or odd value just falls back to taxing
    // the whole subtotal (computeBill also clamps it to the subtotal).
    taxableInr =
      typeof taxable_subtotal_inr === 'number' && Number.isFinite(taxable_subtotal_inr)
        ? taxable_subtotal_inr
        : subtotalInr;
  }

  // HIOC Ritual preview (CP-D9/CP-D12): the pass is applied first. Only when the
  // feature is on, the cart was priced here, and there is an account whose cups
  // these are; otherwise `pass` stays null.
  let pass: PassPreview | null = null;
  let passCoveredInr = 0;
  let passCoveredTaxableInr = 0;
  if (flags.coffeePass && resolvedLines && userId) {
    const priced = await allocateOrderPass(admin(), {
      userId,
      lines: resolvedLines,
      keys: resolvedLines.map((_, i) => String(i)),
      requested: requestedPassDrinks,
    });
    const a = priced.allocation;
    passCoveredInr = a.covered_inr;
    passCoveredTaxableInr = a.covered_taxable_inr;
    pass = {
      requested: a.requested,
      applied: a.applied,
      discount_inr: a.covered_inr,
      eligible_units: a.eligible_units,
      available: a.available,
      max_usable: priced.maxUsable,
      shortfall: a.shortfall,
      message: passShortfallMessage(a),
      passes: priced.passes,
    };
  }
  // What a coupon and Beanies are computed on once the pass has been applied.
  const payableAfterPass = afterPass(subtotalInr, passCoveredInr);

  let couponResult: Awaited<ReturnType<typeof validateAndComputeCoupon>> | null = null;
  let couponDiscountInr = 0;
  if (typeof coupon_code === 'string' && coupon_code.trim().length > 0) {
    couponResult = await validateAndComputeCoupon(coupon_code.trim(), {
      subtotalInr: payableAfterPass,
      userId,
      itemIds,
      categories: cats,
    });
    if (couponResult.ok) {
      couponDiscountInr = Math.min(couponResult.discountInr, payableAfterPass);
    }
  }

  let balance: number | null = null;
  let pointsResult: Awaited<ReturnType<typeof quoteRedemption>> | null = null;
  let pointsDiscountInr = 0;
  if (userId) {
    balance = await getBalance(userId);
    if (typeof redeem_points === 'number' && redeem_points > 0) {
      const remaining = Math.max(0, payableAfterPass - couponDiscountInr);
      // `balance` was just fetched above for the response's own `balance`
      // field — hand it to quoteRedemption so it doesn't re-scan
      // loyalty_transactions for the same number a moment later.
      pointsResult = await quoteRedemption(userId, redeem_points, remaining, balance);
      if (pointsResult.ok) {
        pointsDiscountInr = pointsResult.discountInr;
      }
    }
  }

  // Exactly the create path's bill: pass, then coupon, then Beanies, GST on the
  // taxable base with the covered rupees out of it, and the dine-in packaging
  // rule (lib/orders/passPricing.ts holds the one copy).
  const bill = composeOrderBill({
    settings,
    subtotalInr,
    taxableSubtotalInr: taxableInr,
    couponDiscountInr,
    pointsDiscountInr,
    passCoveredInr,
    passCoveredTaxableInr,
    isDineIn,
  });

  return NextResponse.json({ bill, coupon: couponResult, points: pointsResult, balance, pass });
}
