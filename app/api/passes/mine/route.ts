import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { unauthorized } from '@/lib/api/http';
import { coffeePassDisabled } from '@/lib/passes/api';
import { PASS_SALE_SUMMARY_SELECT, toPassSaleSummaries } from '@/lib/passes/sale';
import { loadPassRedemptionHistory, loadPassSummaries } from '@/lib/passes/server';

export const dynamic = 'force-dynamic';

/** How far back a purchase still counts as "payment processing" on the page. */
const PENDING_WINDOW_MS = 60 * 60 * 1000;
const PENDING_LIMIT = 5;
/** Past passes shown after the active ones (spec §7: "the last 10 others"). */
const PAST_PASSES = 10;

// GET /api/passes/mine — the signed-in customer's own HIOC Ritual passes.
//
//   passes         every active pass (soonest-expiring first: the order cups are
//                  spent in) plus the last 10 others (used up, expired, refunded),
//                  each with its balance and its history: the orders it was spent
//                  on, newest first, with `reversed` marking cups that came back.
//   phone_verified profiles.phone_verified. A pass can be USED at the counter only
//                  by a verified number (the counter finds the account by it), so
//                  the page says "Verify your number in Profile to use your Ritual
//                  at the counter" when this is false.
//   pending        this customer's pass purchases opened in the last hour that are
//                  still waiting on the gateway (order 'placed', payment_pending),
//                  so the page can say "payment processing" instead of showing
//                  nothing during the seconds between paying and the webhook.
//
// The account is the session's, never a parameter: there is no way to ask for
// someone else's passes here. Read through the admin client because the pass
// tables are service-role only.
export async function GET() {
  const off = coffeePassDisabled();
  if (off) return off;

  const user = await getAuthUser();
  if (!user) return unauthorized();

  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString();
  const [passes, profile, pending] = await Promise.all([
    loadPassSummaries(admin, user.id, { includeInactive: true, inactiveLimit: PAST_PASSES }),
    admin.from('profiles').select('phone_verified').eq('id', user.id).maybeSingle(),
    admin
      .from('orders')
      .select(PASS_SALE_SUMMARY_SELECT)
      .eq('order_kind', 'coffee_pass')
      .eq('user_id', user.id)
      .eq('status', 'placed')
      .eq('payment_status', 'payment_pending')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(PENDING_LIMIT),
  ]);

  // Both of these only decorate the page: a failed read is logged and the pass
  // list still goes out (no "processing" note, an unverified-number note at worst).
  if (profile.error) console.error('GET /api/passes/mine: profile read failed', profile.error);
  if (pending.error) console.error('GET /api/passes/mine: pending purchases read failed', pending.error);

  const history = await loadPassRedemptionHistory(
    admin,
    passes.map((p) => p.id),
  );

  return NextResponse.json({
    passes: passes.map((p) => ({ ...p, history: history[p.id] ?? [] })),
    phone_verified: Boolean((profile.data as { phone_verified?: boolean } | null)?.phone_verified),
    pending: toPassSaleSummaries(pending.data),
  });
}
