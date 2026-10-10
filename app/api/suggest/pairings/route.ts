import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { pairingsFor } from '@/lib/suggest/pairings';
import { validatePairingRequest } from '@/lib/suggest/pairingsValidate';
import { loadCoOrderStats, loadMenuAndTraits, loadPopularity30d } from '@/lib/suggest/serverData';
import { PAIRING_LIMITS } from '@/lib/suggest/types';
import type { PairingResponse } from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

export const dynamic = 'force-dynamic';
// No model call, but a cold co-order cache reads up to 5000 orders (a few pages of
// 1000) on top of the menu and popularity loads; that is the only slow path, and
// it is paid once per 10 minutes per instance.
export const maxDuration = 15;

const RATE_LIMIT_WINDOW_SECS = 600;

// POST /api/suggest/pairings — the checkout's "Pairs well with your order" rail
// (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.2). Public, like the cart it reads.
// Body: { itemIds: string[] } (PairingRequest). Answers { picks, items }
// (PairingResponse): up to three ranked picks and their menu rows, shaped like
// /api/menu items, so the page can add one or open the customise modal without a
// second fetch.
//
// Deterministic and cheap — no model call. And the checkout must never see this
// fail: past validation and the rate limit, ANY failure answers 200 with no picks
// (and a log), so the rail simply doesn't render.
export async function POST(request: Request) {
  if (!flags.checkoutPairings) {
    return errorResponse(404, 'Not found');
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }
  const parsed = validatePairingRequest(body);
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }

  const empty: PairingResponse = { picks: [], items: [] };
  try {
    const ip = clientIp(request);
    if (!(await rateLimitOk(`suggest-pairings:${ip}`, PAIRING_LIMITS.ipRequestsPer10Min, RATE_LIMIT_WINDOW_SECS))) {
      return errorResponse(429, 'Too many requests');
    }

    if (parsed.itemIds.length === 0) return NextResponse.json(empty);

    const admin = createAdminSupabaseClient();
    const [{ items: menu, traitsById }, popularity, coOrders] = await Promise.all([
      loadMenuAndTraits(admin),
      loadPopularity30d(admin),
      loadCoOrderStats(admin),
    ]);

    const picks = pairingsFor({
      cartItemIds: parsed.itemIds,
      menu,
      traitsById,
      coOrders,
      popularity,
      now: new Date(),
    });

    // The menu rows of the picks, in pick order.
    const menuById = new Map<string, MenuItem>(menu.map((item) => [item.id, item]));
    const items = picks.flatMap((pick) => {
      const item = menuById.get(pick.menuItemId);
      return item ? [item] : [];
    });

    const response: PairingResponse = { picks, items };
    return NextResponse.json(response);
  } catch (err) {
    console.error('suggest pairings route: failed — answering with no picks', err);
    return NextResponse.json(empty);
  }
}
