import { describe, expect, it } from 'vitest';
import {
  afterEarlierShopCheck,
  nextShopOrderPoll,
  pendingAfterOutcome,
  shopCheckoutBody,
  shopPayStep,
  shopPendingKey,
  type PendingShopPayment,
} from '@/components/shop/shopCheckout';

// Paying on /shop (components/shop/shopCheckout.ts) and the order page's wait
// for the payment (ShopOrderStatus).

const items = [{ product_id: 'p1', quantity: 2 }];
const address = {
  customer_name: 'Asha',
  phone: '9876543210',
  email: 'a@example.com',
  address_line1: '12 MG Road',
  address_line2: '',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};
const body = shopCheckoutBody(items, address, null, 598);
const key = shopPendingKey(body);
const payment = { gateway: 'razorpay', gatewayOrderId: 'order_1', amountInr: 598, keyId: 'k' };
const pending: PendingShopPayment = { key, orderId: 'o1', payment, mayBePaid: false };

describe('which step a Pay tap takes', () => {
  it('no open checkout: create one', () => {
    expect(shopPayStep(null, key)).toBe('create');
  });

  it('same cart, address and pin after a closed window: reopen the same checkout (no second order)', () => {
    expect(shopPayStep(pending, key)).toBe('reopen');
  });

  it('anything changed: a new checkout', () => {
    const other = shopPendingKey(shopCheckoutBody([{ product_id: 'p1', quantity: 3 }], address, null, 747));
    expect(shopPayStep(pending, other)).toBe('create');
  });

  it('after a success that could not be verified, ask first — whatever the cart says now', () => {
    const maybe = { ...pending, mayBePaid: true };
    expect(shopPayStep(maybe, key)).toBe('check_earlier');
    expect(shopPayStep(maybe, 'something else')).toBe('check_earlier');
  });
});

describe('the key is built from what is sent', () => {
  it('a raw form that differs (spacing, case) is a different key, as it is a different body', () => {
    const spaced = shopPendingKey(shopCheckoutBody(items, { ...address, city: ' pune ' }, null, 598));
    expect(spaced).not.toBe(key);
  });

  it('the pin is part of it', () => {
    const pinned = shopPendingKey(shopCheckoutBody(items, address, { lat: 18.5, lng: 73.8, source: 'gps' }, 598));
    expect(pinned).not.toBe(key);
  });
});

describe('after the window closed', () => {
  it('"unverified" marks the checkout as possibly paid', () => {
    expect(pendingAfterOutcome(pending, { kind: 'unverified', message: 'x' }).mayBePaid).toBe(true);
  });

  it('a dismissed window or one that never opened leaves it reopenable', () => {
    expect(pendingAfterOutcome(pending, { kind: 'dismissed' })).toBe(pending);
    expect(pendingAfterOutcome(pending, { kind: 'unavailable', message: 'x' })).toBe(pending);
  });
});

describe('the check before paying again', () => {
  it('paid (or any later state) → its order page, nothing more is taken', () => {
    for (const status of ['paid', 'sent_to_shiprocket', 'shipped', 'delivered', 'cancelled']) {
      expect(afterEarlierShopCheck({ kind: 'status', status }), status).toBe('go_to_order');
    }
  });

  it('still payment_pending after the server asked Razorpay → paying again is safe', () => {
    expect(afterEarlierShopCheck({ kind: 'status', status: 'payment_pending' })).toBe('carry_on');
  });

  it('gone → forget it; no answer → do not take money on a guess', () => {
    expect(afterEarlierShopCheck({ kind: 'not_found' })).toBe('forget');
    expect(afterEarlierShopCheck({ kind: 'error' })).toBe('blocked');
  });
});

describe('the order page poll', () => {
  const FOR = 180_000;

  it('a 404 stops at once (it used to count as "waiting" for three minutes)', () => {
    expect(nextShopOrderPoll({ kind: 'not_found' }, 0, FOR)).toBe('stop');
  });

  it('payment_pending keeps polling until the window ends, then gives up', () => {
    expect(nextShopOrderPoll({ kind: 'order', status: 'payment_pending' }, 1000, FOR)).toBe('poll');
    expect(nextShopOrderPoll({ kind: 'order', status: 'payment_pending' }, FOR + 1, FOR)).toBe('gave_up');
  });

  it('a confirmed order stops; a failed read is retried', () => {
    expect(nextShopOrderPoll({ kind: 'order', status: 'paid' }, 0, FOR)).toBe('stop');
    expect(nextShopOrderPoll({ kind: 'error' }, 0, FOR)).toBe('poll');
  });
});
