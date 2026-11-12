import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The staff submit flows (POS / settle / order detail / cash forms), made
// explicit: the one-submit-at-a-time machine, the order detail's single state,
// what the detail offers (from the order + payment machines), the retry
// contract's client half (expected_version / 409 stale_version), "only the
// newest list counts", and the toast timer. Pure modules, plus the detail
// server-rendered (there is no DOM in this suite).

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/staff',
}));

import {
  INITIAL_SUBMIT_STATE,
  SUBMIT_PHASES,
  SUBMIT_TRANSITIONS,
  canSubmit,
  submitMessage,
  submitReducer,
  type SubmitEvent,
  type SubmitState,
} from '@/components/staff/submitMachine';
import {
  ACTION_RULES,
  DETAIL_ACTIONS,
  DETAIL_PANELS,
  cancelOffer,
  counterActor,
  detailReducer,
  initialDetailState,
  outcomeEvent,
  paymentOffers,
  readyStep,
  type DetailState,
} from '@/components/staff/orderDetailState';
import {
  ORDER_CHANGED_MESSAGE,
  isStaleVersion,
  sendOrderWrite,
  withExpectedVersion,
} from '@/components/staff/orderWrite';
import { createLatestRequest } from '@/components/staff/latestRequest';
import { createToastTimer } from '@/components/staff/toastTimer';
import { OrderDetailModal } from '@/components/staff/OrderDetailModal';
import { GATEWAY_LIVE_MESSAGE } from '@/lib/orders/paymentStateMachine';
import { OPEN_STATUSES, TERMINAL_STATUSES, TRANSITIONS, isOpenOrder } from '@/lib/orders/stateMachine';
import { OPEN_DINE_IN_STATUSES } from '@/lib/staff/tableOccupancy';
import { SETTLE_EDIT_STATUSES } from '@/lib/orders/settleEdit';
import type { Order, OrderItem, OrderStatus, PaymentStatus } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

// ---------------------------------------------------------------------------
// The submit machine.
// ---------------------------------------------------------------------------
describe('submit machine', () => {
  const states: Record<(typeof SUBMIT_PHASES)[number], SubmitState> = {
    idle: { phase: 'idle' },
    submitting: { phase: 'submitting' },
    done: { phase: 'done' },
    error: { phase: 'error', message: 'nope' },
    stale: { phase: 'stale', message: 'moved' },
    gone: { phase: 'gone', message: 'settled elsewhere' },
  };
  const events: SubmitEvent[] = [
    { type: 'submit' },
    { type: 'succeeded' },
    { type: 'failed', message: 'f' },
    { type: 'stale', message: 's' },
    { type: 'gone', message: 'g' },
    { type: 'edit' },
    { type: 'reset' },
  ];

  it('follows the table exactly, and refuses (same object) everything it does not list', () => {
    for (const phase of SUBMIT_PHASES) {
      for (const event of events) {
        const from = states[phase];
        const next = submitReducer(from, event);
        const to = SUBMIT_TRANSITIONS[phase][event.type];
        if (!to || (to === 'idle' && phase === 'idle')) expect(next).toBe(from);
        else expect(next.phase).toBe(to);
      }
    }
  });

  it('is the one in-flight guard: a second submit while submitting is refused', () => {
    const first = submitReducer(INITIAL_SUBMIT_STATE, { type: 'submit' });
    expect(first.phase).toBe('submitting');
    expect(canSubmit(first)).toBe(false);
    expect(submitReducer(first, { type: 'submit' })).toBe(first);
  });

  it('a finished dialog cannot send again while it closes (done only resets)', () => {
    const done = submitReducer(states.submitting, { type: 'succeeded' });
    expect(done.phase).toBe('done');
    expect(canSubmit(done)).toBe(false);
    expect(submitReducer(done, { type: 'reset' }).phase).toBe('idle');
  });

  it('a bill gone elsewhere never interrupts the request in flight — its answer decides', () => {
    const inFlight = states.submitting;
    expect(submitReducer(inFlight, { type: 'gone', message: 'x' })).toBe(inFlight);
    const failed = submitReducer(inFlight, { type: 'failed', message: 'net' });
    // …and once it has failed, the bill being gone is honoured (no retry over it).
    const gone = submitReducer(failed, { type: 'gone', message: 'settled elsewhere' });
    expect(gone.phase).toBe('gone');
    expect(canSubmit(gone)).toBe(false);
    expect(submitMessage(gone)).toBe('settled elsewhere');
  });

  it('stale is a message, and a deliberate retry from it is allowed', () => {
    const stale = submitReducer(states.submitting, { type: 'stale', message: ORDER_CHANGED_MESSAGE });
    expect(submitMessage(stale)).toBe(ORDER_CHANGED_MESSAGE);
    expect(canSubmit(stale)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The order detail's machine.
// ---------------------------------------------------------------------------
describe('order detail machine', () => {
  const view = initialDetailState(undefined, 'accepted');
  const start = (s: DetailState, action: (typeof DETAIL_ACTIONS)[number]) =>
    detailReducer(s, { type: 'start', action });

  it('starts on Reject only for a New order asked to', () => {
    expect(initialDetailState('reject', 'received').panel).toBe('reject');
    expect(initialDetailState('reject', 'accepted').panel).toBe('view');
    expect(initialDetailState(undefined, 'received').panel).toBe('view');
  });

  it('an action starts only from its own panel(s), with nothing in flight', () => {
    for (const panel of DETAIL_PANELS) {
      const s: DetailState = { ...view, panel };
      for (const action of DETAIL_ACTIONS) {
        const next = start(s, action);
        if (ACTION_RULES[action].from.includes(panel)) expect(next.inFlight).toBe(action);
        else expect(next).toBe(s);
      }
    }
  });

  it('ONE request at a time: a second settle (or anything else) is refused while one is out', () => {
    const settling = start(view, 'settle');
    expect(settling.inFlight).toBe('settle');
    for (const action of DETAIL_ACTIONS) expect(start(settling, action)).toBe(settling);
    // …and no panel opens under it, and Back is refused.
    expect(detailReducer(settling, { type: 'open', panel: 'refund' })).toBe(settling);
    const refunding = start({ ...view, panel: 'refund' }, 'refund');
    expect(detailReducer(refunding, { type: 'back' })).toBe(refunding);
  });

  it('panels open only from the plain view; void needs a line, appRef a method', () => {
    expect(detailReducer(view, { type: 'open', panel: 'void' })).toBe(view);
    expect(detailReducer(view, { type: 'open', panel: 'void', itemId: 'l1' })).toMatchObject({ panel: 'void', voidItemId: 'l1' });
    expect(detailReducer(view, { type: 'open', panel: 'appRef' })).toBe(view);
    expect(detailReducer(view, { type: 'open', panel: 'appRef', method: 'zomato_district' })).toMatchObject({
      panel: 'appRef',
      appMethod: 'zomato_district',
    });
    const refund = detailReducer(view, { type: 'open', panel: 'refund' });
    expect(detailReducer(refund, { type: 'open', panel: 'comp' })).toBe(refund);
  });

  it('success lands on the view; failure stays on the panel; stale goes back to look again', () => {
    const voiding = start(detailReducer(view, { type: 'open', panel: 'void', itemId: 'l1' }), 'void');
    expect(detailReducer(voiding, { type: 'succeeded' })).toMatchObject({ panel: 'view', inFlight: null, voidItemId: null });
    expect(detailReducer(voiding, { type: 'failed' })).toMatchObject({ panel: 'void', inFlight: null, voidItemId: 'l1' });
    expect(detailReducer(voiding, { type: 'stale' })).toMatchObject({ panel: 'view', inFlight: null });
    // An answer with nothing in flight is ignored.
    expect(detailReducer(view, { type: 'succeeded' })).toBe(view);
  });

  it('a refused dining-app settle keeps the panel with why; retyping clears it', () => {
    const app = start(detailReducer(view, { type: 'open', panel: 'appRef', method: 'swiggy_dineout' }), 'app_settle');
    const failed = detailReducer(app, { type: 'failed', error: 'Not recorded' });
    expect(failed).toMatchObject({ panel: 'appRef', inFlight: null, appError: 'Not recorded' });
    expect(detailReducer(failed, { type: 'edit' }).appError).toBeNull();
  });

  it('maps a parent outcome to an event (nothing said = done, as before)', () => {
    expect(outcomeEvent(undefined)).toEqual({ type: 'succeeded' });
    expect(outcomeEvent('done')).toEqual({ type: 'succeeded' });
    expect(outcomeEvent(true)).toEqual({ type: 'succeeded' });
    expect(outcomeEvent('failed')).toEqual({ type: 'failed' });
    expect(outcomeEvent(false)).toEqual({ type: 'failed' });
    expect(outcomeEvent('stale')).toEqual({ type: 'stale' });
  });
});

// ---------------------------------------------------------------------------
// What the detail offers — from the order and payment machines.
// ---------------------------------------------------------------------------
function line(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'item-1',
    order_id: 'order-1',
    menu_item_id: 'menu-1',
    variant_id: null,
    name_snapshot: 'Cappuccino',
    variant_label_snapshot: 'L',
    price_inr_snapshot: 120,
    quantity: 1,
    line_total_inr: 120,
    special_instructions: '',
    addons: [],
    voided: false,
    void_reason: '',
    voided_by: null,
    voided_at: null,
    ...overrides,
  };
}

function order(overrides: Partial<OrderWithItems> = {}): OrderWithItems {
  return {
    id: 'order-1',
    order_number: 1042,
    customer_name: 'Aisha Khan',
    customer_phone: '+919000000000',
    customer_email: null,
    pickup_time: '',
    status: 'accepted',
    subtotal_inr: 120,
    total_inr: 120,
    notes: '',
    created_at: '2026-09-29T10:00:00.000Z',
    updated_at: '2026-09-29T10:00:00.000Z',
    order_type: 'takeaway',
    payment_status: 'unpaid',
    payment_method: null,
    version: 3,
    items: [line()],
    ...overrides,
  } as OrderWithItems;
}

describe('counterActor', () => {
  it('maps a manager to the owner’s order powers, and nobody to plain staff', () => {
    expect(counterActor('owner')).toBe('owner');
    expect(counterActor('manager')).toBe('owner');
    expect(counterActor('staff')).toBe('staff');
    expect(counterActor(null)).toBe('staff');
    expect(counterActor(undefined)).toBe('staff');
  });
});

describe('cancelOffer', () => {
  it('Preparing: a manager/owner is offered Cancel, plain staff is not (the server 403s them)', () => {
    expect(cancelOffer(order({ status: 'preparing' }), 'staff')).toBeNull();
    expect(cancelOffer(order({ status: 'preparing' }), 'owner')).toEqual({
      label: 'Cancel order',
      confirm: 'Cancel this order?',
    });
  });

  it('Accepted: anyone at the counter, with the board’s confirmation', () => {
    expect(cancelOffer(order({ status: 'accepted' }), 'staff')?.confirm).toBe('Cancel this order?');
  });

  it('never on a New (rejected instead), Ready (completed/comped here) or finished order', () => {
    for (const status of ['received', 'ready', 'completed', 'cancelled', 'rejected', 'placed'] as OrderStatus[]) {
      expect(cancelOffer(order({ status }), 'owner')).toBeNull();
    }
  });

  it('a HIOC Ritual sale: Cancel sale while unpaid, never once paid', () => {
    const sale = order({ order_kind: 'coffee_pass', status: 'accepted' });
    expect(cancelOffer(sale, 'staff')?.label).toBe('Cancel sale');
    expect(cancelOffer({ ...sale, payment_status: 'paid', payment_method: 'cash' }, 'owner')).toBeNull();
  });
});

describe('paymentOffers', () => {
  it('an unpaid live order: settle (one tap and the full step)', () => {
    expect(paymentOffers(order())).toMatchObject({ quickSettle: true, split: true, changePayment: false, refund: false });
  });

  it('waiting on an online payment: no settle, and the machine says why', () => {
    const o = paymentOffers(order({ payment_status: 'payment_pending' }));
    expect(o.quickSettle).toBe(false);
    expect(o.split).toBe(false);
    expect(o.settleRefusal).toBe(GATEWAY_LIVE_MESSAGE);
  });

  it('a cancelled unpaid order: nothing to settle (the Cash/UPI row used to show)', () => {
    const o = paymentOffers(order({ status: 'cancelled' }));
    expect(o.quickSettle).toBe(false);
    expect(o.settleRefusal).toBeNull();
  });

  it('refunds: no settle on a refunded bill; refund only while something is left', () => {
    expect(paymentOffers(order({ payment_status: 'refunded' as PaymentStatus }))).toMatchObject({
      quickSettle: false,
      refund: false,
      changePayment: false,
    });
    expect(paymentOffers(order({ payment_status: 'partially_refunded' as PaymentStatus })).refund).toBe(true);
  });

  it('a paid counter bill can be re-recorded and refunded; a gateway one only refunded', () => {
    expect(paymentOffers(order({ payment_status: 'paid', payment_method: 'cash' }))).toMatchObject({
      changePayment: true,
      refund: true,
    });
    expect(paymentOffers(order({ payment_status: 'paid', payment_method: 'online' }))).toMatchObject({
      changePayment: false,
      refund: true,
    });
  });

  it('comp: a Ready order not yet paid, not one waiting on the gateway', () => {
    expect(paymentOffers(order({ status: 'ready' })).comp).toBe(true);
    expect(paymentOffers(order({ status: 'preparing' })).comp).toBe(false);
    expect(paymentOffers(order({ status: 'ready', payment_status: 'payment_pending' })).comp).toBe(false);
    expect(paymentOffers(order({ status: 'ready', payment_status: 'paid', payment_method: 'cash' })).comp).toBe(false);
  });
});

describe('readyStep', () => {
  const ready = (o: Partial<OrderWithItems>) => readyStep(order({ status: 'ready', ...o }), 'staff');

  it('follows the ready → completed guard', () => {
    expect(ready({})).toBe('settle');
    expect(ready({ payment_status: 'paid', payment_method: 'cash' })).toBe('complete');
    expect(ready({ payment_status: 'paid', payment_method: 'cash', balance_due_inr: 130 })).toBe('collect_balance');
    expect(ready({ payment_status: 'paid', payment_method: 'cash', balance_due_inr: -40 })).toBe('complete');
    // Paid, then refunded: the money was collected — complete it, don't offer Cash/UPI.
    expect(ready({ payment_status: 'refunded' as PaymentStatus })).toBe('complete');
    expect(ready({ payment_status: 'partially_refunded' as PaymentStatus })).toBe('complete');
    expect(ready({ payment_status: 'payment_pending' })).toBe('waiting');
  });
});

describe('open orders: one list, from the order machine', () => {
  it('accepted, preparing, ready — live, never terminal, each with a way out', () => {
    expect([...OPEN_STATUSES]).toEqual(['accepted', 'preparing', 'ready']);
    for (const s of OPEN_STATUSES) {
      expect(TERMINAL_STATUSES).not.toContain(s);
      expect(TRANSITIONS.some((t) => t.from === s)).toBe(true);
    }
    expect(isOpenOrder('received')).toBe(false);
    expect(isOpenOrder('completed')).toBe(false);
    expect(isOpenOrder('ready')).toBe(true);
  });

  it('the tables board and the settle edit use the same list', () => {
    expect(OPEN_DINE_IN_STATUSES).toBe(OPEN_STATUSES);
    expect(SETTLE_EDIT_STATUSES).toBe(OPEN_STATUSES);
  });
});

// ---------------------------------------------------------------------------
// The order detail, rendered.
// ---------------------------------------------------------------------------
describe('the order detail', () => {
  const noop = () => {};
  const detail = (o: OrderWithItems, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(OrderDetailModal, {
        order: o,
        onClose: noop,
        onPrint: noop,
        onTransition: noop,
        onPayment: () => Promise.resolve(true),
        onRefund: noop,
        onOpenPayment: noop,
        ...props,
      }),
    );

  it('does not offer plain staff a Cancel on a Preparing order (the server refuses it)', () => {
    const html = detail(order({ status: 'preparing' }));
    expect(html).not.toContain('Cancel order');
    expect(html).toContain('Mark Ready');
  });

  it('offers Cancel on an Accepted order', () => {
    expect(detail(order({ status: 'accepted' }))).toContain('Cancel order');
  });

  it('no Cash / UPI / Card on an order waiting on the gateway — the reason instead', () => {
    const html = detail(order({ payment_status: 'payment_pending' }));
    expect(html).not.toMatch(/>Cash</);
    expect(html).not.toContain('Split or cash with change');
    expect(html).toContain('waiting on an online payment');
  });

  it('a refunded Ready takeaway goes to the pickup check, not "Collect payment"', () => {
    const html = detail(order({ status: 'ready', payment_status: 'refunded' as PaymentStatus, payment_method: 'cash' }));
    expect(html).toContain('Verify pickup code');
    expect(html).not.toContain('Collect payment');
  });

  it('the parent’s status change in flight disables the transition buttons', () => {
    const html = detail(order({ status: 'preparing' }), { busy: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Mark Ready<\/button>/);
  });
});

// ---------------------------------------------------------------------------
// The retry contract, client half.
// ---------------------------------------------------------------------------
describe('withExpectedVersion / isStaleVersion', () => {
  it('adds the version only when it is a whole number ≥ 0', () => {
    expect(withExpectedVersion({ op: 'add' }, 4)).toEqual({ op: 'add', expected_version: 4 });
    expect(withExpectedVersion({ op: 'add' }, 0)).toEqual({ op: 'add', expected_version: 0 });
    for (const v of [undefined, null, -1, 1.5, Number.NaN]) {
      expect(withExpectedVersion({ op: 'add' }, v as number)).toEqual({ op: 'add' });
    }
  });

  it('only the version guard’s 409 is stale', () => {
    expect(isStaleVersion(409, { code: 'stale_version' })).toBe(true);
    expect(isStaleVersion(409, { error: 'Order is paid' })).toBe(false);
    expect(isStaleVersion(400, { code: 'stale_version' })).toBe(false);
    expect(isStaleVersion(409, null)).toBe(false);
  });
});

describe('sendOrderWrite', () => {
  type Answer = { status: number; body?: unknown; throws?: boolean; badJson?: boolean };
  const fakeFetch = (answer: Answer) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (answer.throws) throw new TypeError('Failed to fetch');
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: () => (answer.badJson ? Promise.reject(new Error('x')) : Promise.resolve(answer.body)),
      };
    };
    return { calls, impl };
  };

  it('POSTs the body (version included) once, and hands back the answer', async () => {
    const f = fakeFetch({ status: 200, body: { order: { id: 'o1', version: 5 } } });
    const r = await sendOrderWrite('/api/orders/o1/amend', withExpectedVersion({ op: 'add' }, 4), 'fallback', f.impl);
    expect(r).toEqual({ kind: 'ok', data: { order: { id: 'o1', version: 5 } } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init?.method).toBe('POST');
    expect(JSON.parse(f.calls[0].init?.body as string)).toEqual({ op: 'add', expected_version: 4 });
  });

  it('a 409 stale_version is "the order changed" — never retried', async () => {
    const f = fakeFetch({ status: 409, body: { error: 'server words', code: 'stale_version', version: 6 } });
    const r = await sendOrderWrite('/x', {}, 'fallback', f.impl);
    expect(r).toEqual({ kind: 'stale', message: ORDER_CHANGED_MESSAGE, version: 6 });
    expect(f.calls).toHaveLength(1);
  });

  it('any other refusal carries the server’s message, or the fallback', async () => {
    expect(await sendOrderWrite('/x', {}, 'fallback', fakeFetch({ status: 409, body: { error: 'Order is paid' } }).impl)).toEqual({
      kind: 'error',
      status: 409,
      message: 'Order is paid',
    });
    expect(await sendOrderWrite('/x', {}, 'fallback', fakeFetch({ status: 403, badJson: true }).impl)).toEqual({
      kind: 'error',
      status: 403,
      message: 'fallback',
    });
  });

  it('no answer at all is a network failure (the change may have landed)', async () => {
    const f = fakeFetch({ status: 0, throws: true });
    const r = await sendOrderWrite('/x', {}, 'fallback', f.impl);
    expect(r.kind).toBe('network');
    expect(f.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Only the newest list counts.
// ---------------------------------------------------------------------------
describe('latestRequest', () => {
  it('a fetch started before a write is ignored when it answers after it (no resurrected bill)', () => {
    const latest = createLatestRequest();
    const pollStartedBeforeSettle = latest.begin();
    latest.invalidate(); // the settle landed
    const refetchAfterSettle = latest.begin();
    expect(refetchAfterSettle()).toBe(true);
    expect(pollStartedBeforeSettle()).toBe(false);
  });

  it('of two overlapping fetches only the newer one applies', () => {
    const latest = createLatestRequest();
    const a = latest.begin();
    const b = latest.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The toast timer.
// ---------------------------------------------------------------------------
describe('toast timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a new toast replaces the pending one (the old timer no longer clears it early)', () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const t = createToastTimer((m) => shown.push(m));
    t.show('first', 3500);
    vi.advanceTimersByTime(3000);
    t.show('second', 3500);
    vi.advanceTimersByTime(1000); // the first toast's timer would have fired here
    expect(shown).toEqual(['first', 'second']);
    vi.advanceTimersByTime(2500);
    expect(shown).toEqual(['first', 'second', '']);
  });

  it('dispose (unmount) cancels the pending clear, and nothing is scheduled after it', () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const t = createToastTimer((m) => shown.push(m));
    t.show('bye', 3500);
    t.dispose();
    t.show('late answer', 3500);
    vi.advanceTimersByTime(10_000);
    expect(shown).toEqual(['bye']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
