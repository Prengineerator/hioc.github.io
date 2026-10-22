import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import type { getCounterActor } from '@/lib/api/auth';
import { isPaymentMethod, PAYMENT_METHODS } from '@/lib/api/constants';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { sendBillNotification } from '@/lib/notifications/engine';
import {
  dominantMethod,
  isAppPaymentMethod,
  parseSettleAdjustment,
  shortNeedsManager,
  STAFF_SETTLE_SHORT_LIMIT_INR,
  validateParts,
  type PaymentPart,
} from '@/lib/orders/payments';
import { runAfterResponse } from '@/lib/api/background';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, PaymentMethod, PaymentStatus } from '@/lib/types';

// Recording how a counter order was paid (STF-041, POS4-1 splits, settle
// adjustments, BILL-1's bill at settle), shared by the two routes that do it:
// PATCH /api/orders/[id]/payment, which settles an order that already exists,
// and POST /api/orders, which can settle the order it has just created in the
// same request (the POS's "Collect now"), one function call instead of two.
// One copy of the rules, so the two can't drift into accepting different money.

export type CounterActor = NonNullable<Awaited<ReturnType<typeof getCounterActor>>>;

// What this route may SET. 'refunded' and 'partially_refunded' are deliberately
// not here: only the refund route produces them (it moves the money, checks the
// `refund` permission and voids a HIOC Ritual pass first), and the coffee-pass
// trigger returns every cup on an order the moment it reads 'refunded' — so a
// bare status flip from here would hand back cups for money that never left.
const PAYMENT_STATUSES: readonly PaymentStatus[] = ['unpaid', 'payment_pending', 'paid'];
const REFUND_STATUSES: readonly string[] = ['refunded', 'partially_refunded'];

export interface SettledBody {
  order: Order & {
    settle_discount_inr: number;
    tip_inr: number;
    settle_reason: string | null;
    payments: { method: string; amount_inr: number; reference?: string }[];
  };
  change_due_inr: number;
}

export type SettleOutcome = { ok: true; body: SettledBody } | { ok: false; status: number; error: string };

/**
 * POST /api/orders' `settlement` answer: how the counter's own settle went,
 * when it sent one with the order. `null` when there was nothing to settle (a
 * ₹0 bill is created paid).
 */
export type CounterSettlement =
  | ({ ok: true } & SettledBody)
  | { ok: false; status: number; error: string }
  | null;

function fail(status: number, error: string): SettleOutcome {
  return { ok: false, status, error };
}

/**
 * Settle one order. `body` is the PATCH body shape (see the payment route):
 * `{ payment_method, payment_status?, reference? }` or `{ parts, adjustment? }`.
 * Never throws for a bad request; answers `{ ok: false, status, error }` with
 * the exact status and message the route has always returned.
 */
export async function settleOrderPayment(
  actor: CounterActor,
  orderId: string,
  body: Record<string, unknown>,
): Promise<SettleOutcome> {
  const user = actor.user;
  const id = orderId;

  // Refuse a refund state before anything else, for every order: it is a policy
  // line, not a validation of this order. No screen sends one (the refund panel
  // calls /refund), so this only ever stops a hand-made request from a counter
  // actor who holds no refund permission.
  if (typeof body.payment_status === 'string' && REFUND_STATUSES.includes(body.payment_status)) {
    return fail(400, 'Refunds go through the refund screen.');
  }

  const isSplit = body.parts !== undefined;
  if (!isSplit && !isPaymentMethod(body.payment_method)) {
    return fail(400, `payment_method is required and must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }

  let paymentStatus: PaymentStatus = 'paid';
  if (body.payment_status !== undefined) {
    if (
      typeof body.payment_status !== 'string' ||
      !(PAYMENT_STATUSES as readonly string[]).includes(body.payment_status)
    ) {
      return fail(400, `payment_status must be one of: ${PAYMENT_STATUSES.join(', ')}`);
    }
    paymentStatus = body.payment_status as PaymentStatus;
  }

  const admin = createAdminSupabaseClient();

  // Don't let a manual "mark payment" clobber a gateway-verified online payment
  // (M6) — those are reconciled against Razorpay and may only change via the
  // refund flow. Guard against overwriting an online paid/refunded record.
  // `total_inr` comes along because a split must be validated against the
  // SERVER's total, never a total the client tells us.
  // select('*') rather than a column list: the settle-adjustment columns
  // (2026-09-settle-adjustments.sql) must not make a plain settle fail on a
  // database that hasn't had that migration applied yet.
  const { data: existing } = await admin
    .from('orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!existing) return fail(404, 'Not found');
  if (
    existing.payment_method === 'online' &&
    ['paid', 'refunded', 'partially_refunded'].includes(existing.payment_status as string)
  ) {
    return fail(
      409,
      'This order was paid online — its payment is managed by the gateway and can only change via a refund.',
    );
  }

  // The SALE of a HIOC Ritual pass is what issued the pass the moment it turned
  // 'paid' (a database trigger does it, CP-D6). Moving it off 'paid' from here
  // would leave a live pass behind an order that says the customer never paid
  // for it, so the way back is the refund, which voids the pass first (CP-D15).
  // Re-recording HOW it was paid while it stays paid (cash → UPI, a corrected
  // split) is an ordinary re-settle and is fine. `order_kind` is absent before
  // 2026-10-coffee-pass.sql (existing is select('*')), which reads as a menu
  // order, so this is inert there.
  if (
    existing.order_kind === 'coffee_pass' &&
    existing.payment_status === 'paid' &&
    paymentStatus !== 'paid'
  ) {
    return fail(
      409,
      `A ${PASS_PROGRAM_NAME} has been issued for this sale — refund it instead.`,
    );
  }

  // Changing how a bill was paid (cash → UPI…) is a re-settle and allowed —
  // but not once money has gone back: the refund was taken off a specific
  // tender, and re-recording the tenders would detach it from what it refunded
  // (and flip a refunded order back to 'paid').
  if (['refunded', 'partially_refunded'].includes(existing.payment_status as string)) {
    return fail(409, 'This order has a refund, so how it was paid can no longer be changed.');
  }

  // POS4-1: validate the split against the authoritative total before touching
  // anything. The parts must sum exactly — a gap would surface later as an
  // unexplained cash-drawer variance nobody can reconstruct.
  let parts: PaymentPart[] | null = null;
  let changeInr = 0;
  const orderTotal = (existing.total_inr as number | null) ?? (existing.subtotal_inr as number);

  // Short = settlement discount, extra = tip. Both are only meaningful with
  // parts: a single-method settle is the whole bill, so there is no amount to
  // differ from. The reason is mandatory (parseSettleAdjustment) so a write-off
  // is never silent.
  const adjustment = parseSettleAdjustment(body.adjustment, orderTotal);
  if (!adjustment.ok) return fail(400, adjustment.error);
  const adjusted = adjustment.shortInr > 0 || adjustment.tipInr > 0;
  if (adjusted && !isSplit) {
    return fail(400, 'A short or tip settlement must send the amounts received as `parts`.');
  }
  // The pass is issued in FULL the moment the sale turns 'paid' (a trigger, CP-D6),
  // at the price the line charged. Taking less money for it would leave a full
  // pass behind a discounted sale, and neither a staffer's ₹50 nor a manager's
  // any-amount override changes that: the sale is paid in full or cancelled. A
  // tip is extra money, so it stays allowed. `order_kind` is absent before
  // 2026-10-coffee-pass.sql (existing is select('*')), which reads as a menu order.
  if (existing.order_kind === 'coffee_pass' && adjustment.shortInr > 0) {
    return fail(
      409,
      `A ${PASS_PROGRAM_NAME} can't be settled short — take the full amount or cancel the sale.`,
    );
  }
  // A big shortfall is a discount decision, not a counter one. Enforced on the
  // server: hiding the option in the UI is not a control.
  if (shortNeedsManager(adjustment.shortInr) && actor.role !== 'manager' && actor.role !== 'owner') {
    return fail(
      403,
      `A shortfall above ₹${STAFF_SETTLE_SHORT_LIMIT_INR} needs a manager or the owner to approve it.`,
    );
  }

  // A single-method dining-app settle is stored as one tender for the whole
  // bill, because the tender row is where its booking ID lives.
  const appSingle = !isSplit && isAppPaymentMethod(body.payment_method as string);
  if (isSplit || appSingle) {
    const rawParts = isSplit
      ? body.parts
      : [{ method: body.payment_method, amount_inr: orderTotal, reference: body.reference }];
    const validated = validateParts(rawParts, orderTotal, adjustment);
    if (!validated.ok) return fail(400, validated.error);
    parts = validated.parts;
    changeInr = validated.changeInr;
  }

  // The same booking settled on two bills is either a typo or the platform's
  // money being claimed twice — refuse it before anything is written. A dead
  // order (cancelled, rejected, fully refunded) doesn't hold its ID: that
  // booking can legitimately be billed again.
  const referenced = (parts ?? []).filter((p) => p.reference);
  if (referenced.length > 0) {
    const { data: sameRef, error: refError } = await admin
      .from('order_payments')
      .select('order_id, method, reference')
      .in(
        'reference',
        referenced.map((p) => p.reference as string),
      )
      .neq('order_id', id);
    if (refError) {
      console.error('booking ID check failed — is supabase/2026-10-aggregator-payments.sql applied?', refError);
      return fail(500, 'Could not check the booking ID. Try again.');
    }
    const clashes = ((sameRef ?? []) as { order_id: string; method: string; reference: string }[]).filter((r) =>
      referenced.some((p) => p.method === r.method && p.reference === r.reference),
    );
    if (clashes.length > 0) {
      const { data: others } = await admin
        .from('orders')
        .select('id, order_number, status, payment_status')
        .in(
          'id',
          clashes.map((c) => c.order_id),
        );
      const live = ((others ?? []) as { id: string; order_number: number; status: string; payment_status: string }[]).find(
        (o) => !['cancelled', 'rejected'].includes(o.status) && o.payment_status !== 'refunded',
      );
      if (live) {
        const clash = clashes.find((c) => c.order_id === live.id)!;
        return fail(
          409,
          `${PAYMENT_METHOD_LABEL[clash.method] ?? clash.method} ID ${clash.reference} is already recorded on order ` +
            `${formatOrderNumber(live.order_number)}. Check the ID in the app.`,
        );
      }
    }
  }

  const methodToStore = parts ? dominantMethod(parts) : (body.payment_method as PaymentMethod);

  // A re-settle without an adjustment resets any earlier one — but only writes
  // the columns when there is something to write or clear, so plain settles
  // keep working before the migration is applied.
  const hadAdjustment =
    ((existing.settle_discount_inr as number | undefined) ?? 0) > 0 ||
    ((existing.tip_inr as number | undefined) ?? 0) > 0 ||
    ((existing.settle_reason as string | undefined) ?? '') !== '';
  const adjustmentColumns =
    adjusted || hadAdjustment
      ? {
          settle_discount_inr: adjustment.shortInr,
          tip_inr: adjustment.tipInr,
          settle_reason: adjustment.reason,
        }
      : {};

  const { data, error } = await admin
    .from('orders')
    .update({ payment_method: methodToStore, payment_status: paymentStatus, ...adjustmentColumns })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    return fail(500, 'Failed to record payment');
  }
  if (!data) {
    return fail(404, 'Not found');
  }

  // POS4-1: persist the parts. Written AFTER the order update so a failed
  // settle leaves no orphan parts. Replaces any prior parts for this order so a
  // re-settle (staff correcting how it was paid) doesn't double-count cash.
  // A single-method re-settle clears them too: otherwise a bill first split
  // cash + UPI and then changed to "all UPI" would keep its old cash part, and
  // the drawer would still expect that cash.
  if (!parts && paymentStatus === 'paid') {
    await admin.from('order_payments').delete().eq('order_id', id);
  }
  if (parts) {
    await admin.from('order_payments').delete().eq('order_id', id);
    const { error: partsError } = await admin.from('order_payments').insert(
      parts.map((p) => ({
        order_id: id,
        method: p.method,
        amount_inr: p.amount_inr,
        tendered_inr: p.tendered_inr ?? null,
        // Only sent when there is one, so a settle with no dining-app tender
        // never depends on the column existing.
        ...(p.reference ? { reference: p.reference } : {}),
        created_by: user.id,
      })),
    );
    if (partsError) {
      // The order reads as paid but the drawer breakdown is missing — that's a
      // cash-reconciliation problem, so say so loudly rather than swallow it.
      console.error(
        `order_payments insert FAILED for order ${id} — the cash day will fall back to the ` +
          `whole total on '${methodToStore}'. Is supabase/2026-08-split-payments.sql applied?`,
        partsError,
      );
    }
  }

  // BILL-1: deliver the bill the moment the money is taken. The POS "Collect now"
  // step settles through THIS route and never transitions status, so before this
  // a counter order got NO bill at all until someone separately marked it
  // completed in the queue — which on a busy counter never happens. The bill for
  // a settled order belongs here, not only on the completed transition.
  //
  // Exactly-once is the engine's job: its per-(order, event, channel) idempotency
  // makes the later completed-transition send a no-op, so the customer can't get
  // two. Only a genuinely settled order bills — 'payment_pending' (an online
  // order awaiting the gateway) must not.
  //
  // Reloaded with its lines so the bill's item count ({{4}}) is accurate; `data`
  // above is a plain select('*') and carries no items. Best-effort and fully
  // wrapped: a slow or failing provider must never fail settlement — the printed
  // bill remains the guaranteed copy.
  //
  // Perf: this can involve an email provider AND a WhatsApp provider round trip
  // (plus the reload query above it), and none of it can change this response —
  // the payment is already fully recorded by this point. It used to be awaited
  // here, which meant the counter's "settled, change due ₹X" confirmation sat
  // behind however long Meta/the email provider took to answer. Backgrounded via
  // runAfterResponse exactly like the create route's own bill send, with the
  // same never-throws contract (still logged on failure, never surfaced to the
  // counter or the caller).
  if (paymentStatus === 'paid') {
    runAfterResponse(
      (async () => {
        const { data: full } = await admin
          .from('orders')
          .select('*, order_items(*, order_item_addons(*))')
          .eq('id', id)
          .single();
        await sendBillNotification(full ? toOrderResponse(full as OrderRowWithItems) : (data as Order));
      })().catch((billError) => {
        console.error('settle bill notification failed', billError);
      }),
    );
  }

  // `change_due_inr` lets the POS show "give ₹120 back" without recomputing it.
  // The tenders as recorded, so the caller can show "Cash ₹300 + UPI ₹180"
  // straight away (a single-method settle has none — payment_method says it).
  const payments = (parts ?? []).map((p) => ({
    method: p.method,
    amount_inr: p.amount_inr,
    ...(p.reference ? { reference: p.reference } : {}),
  }));
  return {
    ok: true,
    body: {
      order: {
        ...(data as Order),
        settle_discount_inr: adjustment.shortInr,
        tip_inr: adjustment.tipInr,
        settle_reason: adjustment.reason,
        payments,
      },
      change_due_inr: changeInr,
    },
  };
}
