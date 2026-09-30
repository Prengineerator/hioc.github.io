import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { actorRoleFor, getCounterActor } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { hasPermission } from '@/lib/permissions';
import { createCounterCustomer, findVerifiedCustomerByPhone, toStoredPhone } from '@/lib/loyalty/customerLink';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  readIdempotencyKey,
  releaseIdempotencyKey,
} from '@/lib/orders/idempotency';
import { coffeePassDisabled, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { createPassSaleOrder } from '@/lib/passes/sale';
import { loadPlanById } from '@/lib/passes/server';
import { getStaffSurface } from '@/lib/staff/surface';
import { canTakeOrders } from '@/lib/staff/surfaceRules';
import { getStoreSettings } from '@/lib/store/settings';

export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 60;
const NO_PERMISSION = `You don't have permission to sell ${PASS_PROGRAM_NAME}.`;
const NOT_A_COUNTER_MESSAGE = `Sell ${PASS_PROGRAM_NAME} from the counter`;
const NO_ACCOUNT_MESSAGE = "Couldn't open an account for this number — check it and try again.";

// POST /api/passes/sell — a staffer sells a HIOC Ritual at the counter.
// Header: Idempotency-Key (required). Body: { plan_id, customer_phone, customer_name }.
// Responds 201 { order, customer: { name, created } }.
//
// It creates the SALE ORDER only (order_kind 'coffee_pass', channel 'staff_pos',
// status 'accepted', payment 'unpaid', created_by the staffer), and returns it for
// the payment panel, exactly as a counter order is created unpaid and then settled
// (PATCH /api/orders/[id]/payment). The pass is issued by the database the moment
// that payment lands (CP-D6): cash, UPI, card or a split, all the same. So an
// unpaid sale holds no pass, and a sale nobody pays for simply stays on the
// holder's "unpaid" list (GET /api/passes/holder).
//
// WHO GETS THE PASS (CP-D4). The account is derived HERE from the phone the
// staffer typed, never from a body field: the VERIFIED account holding that number
// (findVerifiedCustomerByPhone), else a new one opened for it (createCounterCustomer,
// POS-ACC), exactly as a counter order does. If neither is possible the route
// REFUSES (409): a pass with no account is a paid-for pass that can never be
// issued or spent, and the counter must find that out before taking the money.
// `customer.name` is the account's name (so the staffer can confirm it is the right
// person) and `created` says the account was opened by this sale.
//
// GATES, in order: the flag (404); a counter actor (401); the `pass_sell`
// permission (403); where the staff screen is running: the same rule as taking an
// order (canTakeOrders: the POS, or the staff website when the owner switched web
// ordering on), else 403 "Sell HIOC Ritual from the counter".
//
// IDEMPOTENCY (POS4-2), exactly as POST /api/orders. On flaky wifi the response can
// be lost and the staffer taps Sell again: a replay of the same key returns the
// FIRST sale (201, `replayed: true`), never a second order; the same key arriving
// while the first is still being made is a 409. The key is claimed only after every
// validation, so a refused request does not burn it, and released again if the sale
// cannot be created, so the retry is not rejected as a duplicate of nothing.
//
// PIN-3: gated by getCounterActor() (a session, else an enrolled device's PIN
// operator); hasPermission takes the role it already knows.
export async function POST(request: Request) {
  const off = coffeePassDisabled();
  if (off) return off;

  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  if (!(await hasPermission(actor.user, 'pass_sell', actor.role))) {
    return errorResponse(403, NO_PERMISSION);
  }

  const settings = await getStoreSettings();
  if (!canTakeOrders(await getStaffSurface(), settings.staff_web_ordering)) {
    return errorResponse(403, NOT_A_COUNTER_MESSAGE);
  }

  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return errorResponse(400, 'An Idempotency-Key header (8 to 200 characters) is required.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  if (!isUuid(body.plan_id)) return errorResponse(400, 'plan_id must be a plan id');
  const phone = toStoredPhone(body.customer_phone);
  if (!phone) return errorResponse(400, 'customer_phone must be a valid 10-digit Indian mobile number');
  const name = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    return errorResponse(400, `customer_name must be 1 to ${MAX_NAME_LENGTH} characters`);
  }

  const admin = createAdminSupabaseClient();
  const plan = await loadPlanById(admin, body.plan_id);
  if (!plan || !plan.is_active) return errorResponse(404, `That ${PASS_PROGRAM_NAME} plan isn't available.`);

  const claim = await claimIdempotencyKey(admin, idempotencyKey, actor.user.id);
  if (claim.state === 'replay') {
    // The first request DID succeed; only its response was lost. Hand back its sale.
    const { data: prior } = await admin
      .from('orders')
      .select('*, order_items(*, order_item_addons(*))')
      .eq('id', claim.orderId)
      .single();
    if (prior) {
      const order = toOrderResponse(prior as OrderRowWithItems);
      return NextResponse.json(
        { order, customer: { name: order.customer_name, created: false }, replayed: true },
        { status: 201 },
      );
    }
  } else if (claim.state === 'in_flight') {
    return errorResponse(409, 'This sale is already being made — please wait a moment.');
  }
  // 'unavailable' (migration not applied) falls through without a guard, as in
  // POST /api/orders; only a state of 'claimed' is ours to complete or release.
  const claimed = claim.state === 'claimed';
  const release = async () => {
    if (claimed) await releaseIdempotencyKey(admin, idempotencyKey);
  };

  let account = await findVerifiedCustomerByPhone(admin, phone);
  let created = false;
  if (!account) {
    const opened = await createCounterCustomer(admin, phone, { name, staffUserId: actor.user.id });
    if (opened) {
      account = { userId: opened.userId, name: opened.name };
      created = opened.created;
    }
  }
  if (!account) {
    await release();
    return errorResponse(409, NO_ACCOUNT_MESSAGE);
  }

  const sale = await createPassSaleOrder(admin, {
    plan,
    channel: 'staff_pos',
    status: 'accepted',
    paymentStatus: 'unpaid',
    paymentMethod: null,
    customerName: name,
    customerPhone: phone,
    userId: null,
    customerUserId: account.userId,
    createdBy: actor.user.id,
    actorRole: actorRoleFor(actor.role),
    settings,
  });
  if (!sale.ok) {
    await release();
    return errorResponse(500, sale.missingSchema ? `Could not create the sale — ${PASS_MIGRATION_HINT}` : sale.message);
  }

  if (claimed) await completeIdempotencyKey(admin, idempotencyKey, sale.order.id);

  return NextResponse.json(
    { order: toOrderResponse(sale.order), customer: { name: account.name || name, created } },
    { status: 201 },
  );
}
