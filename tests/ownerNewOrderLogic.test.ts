import { describe, expect, it } from 'vitest';
import {
  attemptFingerprintOf,
  cleanPhoneInput,
  formFieldFor,
  nextAttemptKey,
  ownerCartLines,
  parseDiscountInput,
  needsLinkRetry,
  paymentLineOf,
  readLinkPending,
  readProductsAnswer,
  readRetryAnswer,
  paymentLinkMessage,
  quoteBillRows,
  readCancelAnswer,
  readCreateFailure,
  sellableProducts,
  setInstantQuantity,
  spendKey,
  unitsOfProduct,
  whatsappShareUrl,
  type OwnerQuote,
} from '@/lib/shop/ownerNewOrder';
import { ownerTab } from '@/lib/shop/status';
import type { ShopProduct } from '@/lib/shop/types';

const product = (o: Partial<ShopProduct>): ShopProduct => ({
  id: 'hazelnut', name: 'Hazelnut', sku: 'H', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1,
  line: 'instant', display_name: '', pack_grams: 0, ship_weight_kg: 0.1, listed: true, requires_grind: false, description: '', ...o,
});
const blend = product({ id: 'hb-250', name: 'Home Blend', display_name: 'Home Blend', line: 'home_blend', pack_grams: 250, price_inr: 525, requires_grind: true });

const quote: OwnerQuote = {
  subtotal_inr: 1449, offer_discount_inr: 0, offer_name: null, coupon_discount_inr: 0, coupon_code: null,
  owner_discount_inr: 100, shipping_inr: 0, total_inr: 1349, intro_offer_applied: false, notes: [],
};

describe('cart lines', () => {
  it('names jars and Home Blend packs with their grind, and drops unknown products', () => {
    const lines = ownerCartLines([product({}), blend], [
      { product_id: 'hazelnut', quantity: 2 },
      { product_id: 'hb-250', quantity: 1, grind: 'filter' },
      { product_id: 'gone', quantity: 1 },
    ]);
    expect(lines.map((l) => l.title)).toEqual(['Hazelnut', 'Home Blend 250 g · Filter']);
    expect(lines.map((l) => l.line_total_inr)).toEqual([798, 525]);
  });
  it('sets, changes and removes a jar quantity, within the 12-unit limit', () => {
    let items = setInstantQuantity([], 'hazelnut', 2);
    expect(items).toEqual([{ product_id: 'hazelnut', quantity: 2 }]);
    items = setInstantQuantity(items, 'hazelnut', 3);
    expect(unitsOfProduct(items, 'hazelnut')).toBe(3);
    expect(setInstantQuantity(items, 'hazelnut', 99)).toEqual([{ product_id: 'hazelnut', quantity: 12 }]);
    expect(setInstantQuantity(items, 'hazelnut', 0)).toEqual([]);
  });
  it('offers only listed, in-stock products', () => {
    const ids = sellableProducts([product({}), product({ id: 'a', in_stock: false }), product({ id: 'b', listed: false })]).map((p) => p.id);
    expect(ids).toEqual(['hazelnut']);
  });
});

describe('inputs', () => {
  it('cleans the phone box, including a pasted +91 number', () => {
    expect(cleanPhoneInput('98765 43210')).toBe('9876543210');
    expect(cleanPhoneInput('+91 98765 43210')).toBe('9876543210');
    expect(cleanPhoneInput('98a')).toBe('98');
  });
  it('reads the discount box as whole rupees', () => {
    expect(parseDiscountInput('')).toBe(0);
    expect(parseDiscountInput(' 100 ')).toBe(100);
    expect(parseDiscountInput('1.5')).toBeNull();
    expect(parseDiscountInput('-5')).toBeNull();
  });
});

describe('idempotency key lifecycle', () => {
  let n = 0;
  const make = () => `key-${++n}`;
  it('takes a key for a first attempt and keeps it across a plain retry', () => {
    const first = nextAttemptKey(null, 'A', null, make);
    expect(nextAttemptKey(first, 'A', null, make)).toBe(first);
    // a 409 that only showed a new total does not burn the key
    expect(nextAttemptKey(first, 'A', 'price_changed', make)).toBe(first);
  });
  it('renews it when the form changed, or the server burnt the key', () => {
    const first = nextAttemptKey(null, 'A', null, make);
    expect(nextAttemptKey(first, 'B', null, make).key).not.toBe(first.key);
    expect(nextAttemptKey(first, 'A', 'idempotency_mismatch', make).key).not.toBe(first.key);
    expect(nextAttemptKey(first, 'A', 'idempotency_expired', make).key).not.toBe(first.key);
  });
  it('renews it after a success, even for the identical form', () => {
    const first = nextAttemptKey(null, 'A', null, make);
    expect(nextAttemptKey(spendKey(first), 'A', null, make).key).not.toBe(first.key);
  });
  it('fingerprints the same order the same way whatever the item order', () => {
    const base = { address: { a: 1 }, couponCode: ' save ', ownerDiscountInr: 0, ownerDiscountReason: 'ignored', payment: { kind: 'link' } };
    const x = attemptFingerprintOf({ ...base, items: [{ product_id: 'a', quantity: 1 }, { product_id: 'b', quantity: 2 }] });
    const y = attemptFingerprintOf({ ...base, couponCode: 'SAVE', ownerDiscountReason: '', items: [{ product_id: 'b', quantity: 2 }, { product_id: 'a', quantity: 1 }] });
    expect(x).toBe(y);
    expect(attemptFingerprintOf({ ...base, items: [{ product_id: 'a', quantity: 2 }] })).not.toBe(x);
  });
});

describe('WhatsApp', () => {
  it('opens wa.me with the order number, total and link in the text', () => {
    const o = { orderRef: 'S1042', totalInr: 1349, url: 'https://rzp.io/i/abc' };
    const url = whatsappShareUrl(o);
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    const text = decodeURIComponent(url.slice('https://wa.me/?text='.length));
    expect(text).toBe(paymentLinkMessage(o));
    expect(text).toContain('S1042');
    expect(text).toContain('₹1,349');
    expect(text).toContain('https://rzp.io/i/abc');
  });
});

describe('bill rows', () => {
  it('shows only the discounts that apply, and free shipping', () => {
    expect(quoteBillRows(quote).map((r) => [r.key, r.value])).toEqual([
      ['subtotal', '₹1,449'], ['owner', '−₹100'], ['shipping', 'Free'], ['total', '₹1,349'],
    ]);
  });
  it('names the offer and the coupon', () => {
    const rows = quoteBillRows({ ...quote, owner_discount_inr: 0, offer_discount_inr: 199, offer_name: '2 jars for ₹599', coupon_discount_inr: 50, coupon_code: 'HI50', shipping_inr: 49, total_inr: 599 });
    expect(rows.map((r) => r.label)).toEqual(['Items', '2 jars for ₹599', 'Coupon HI50', 'Shipping', 'Total']);
    expect(rows.find((r) => r.key === 'shipping')?.value).toBe('₹49');
  });
});

describe('reading the server', () => {
  it('a price change carries the new quote', () => {
    const f = readCreateFailure(409, { code: 'price_changed', error: 'x', quote });
    expect(f.kind).toBe('price_changed');
    expect(f.kind === 'price_changed' && f.quote.total_inr).toBe(1349);
  });
  it('a 400 with a field points at it; without one it is a general error', () => {
    expect(readCreateFailure(400, { error: 'Enter the 6-digit pincode', field: 'pincode' })).toEqual({ kind: 'field', field: 'pincode', message: 'Enter the 6-digit pincode' });
    expect(readCreateFailure(400, { error: 'bad' }).kind).toBe('other');
  });
  it('502 says nothing was saved', () => {
    const f = readCreateFailure(502, { error: 'x' });
    expect(f.kind).toBe('link_failed');
    expect(f.message).toMatch(/nothing was saved/i);
  });
  it('tells the two 503s apart', () => {
    expect(readCreateFailure(503, { error: "Owner-entered orders aren't set up yet — apply supabase/2026-11-shop-owner-orders.sql first" }).kind).toBe('setup_migration');
    expect(readCreateFailure(503, { error: "The shop isn't open yet — apply supabase/2026-11-instant-coffee-shop.sql first" }).kind).toBe('setup_migration');
    expect(readCreateFailure(503, { error: "Payment links aren't available right now. Record it as already paid, or try again later." }).kind).toBe('setup_razorpay');
  });
  it('treats burnt and in-progress keys differently', () => {
    expect(readCreateFailure(409, { code: 'idempotency_mismatch' }).kind).toBe('key_burnt');
    expect(readCreateFailure(409, { code: 'idempotency_in_progress' }).kind).toBe('other');
  });
  it('maps route fields to form fields', () => {
    expect(formFieldFor('owner_discount_inr')).toBe('owner-discount');
    expect(formFieldFor('pincode')).toBe('pincode');
  });
});

describe('cancel answers', () => {
  it('reminds the owner to refund a paid offline order by hand', () => {
    const n = readCancelAnswer(200, { refund_by_hand: true, order: { refunded_inr: 1750 } }, 1750);
    expect(n.tone).toBe('warn');
    expect(n.text).toContain('Send ₹1,750 back to the customer yourself (UPI/cash/bank). The site never held this money.');
  });
  it('409 refreshes and says the order changed; 502 says nothing changed', () => {
    const c = readCancelAnswer(409, { error: 'The customer has just paid this link' }, 500);
    expect(c.refresh).toBe(true);
    expect(c.text).toContain('just paid');
    const r = readCancelAnswer(502, {}, 500);
    expect(r.refresh).toBe(false);
    expect(r.text).toMatch(/nothing was changed/i);
  });
});

describe('payment line and tab', () => {
  it('words the payment on an order card', () => {
    expect(paymentLineOf({ payment_channel: 'offline', offline_method: 'upi_direct', payment_reference: 'UPI 4321' })).toBe('Paid by UPI to café · ref UPI 4321');
    expect(paymentLineOf({ payment_channel: 'offline', offline_method: 'cash', payment_reference: 'note' })).toBe('Cash · ref note');
    expect(paymentLineOf({ payment_channel: 'offline', offline_method: 'bank_transfer', payment_reference: 'N1' })).toBe('Bank transfer · ref N1');
    expect(paymentLineOf({ payment_channel: 'payment_link', offline_method: null, payment_reference: null })).toBe('Payment link');
    expect(paymentLineOf({ payment_channel: 'checkout', offline_method: null, payment_reference: null })).toBeNull();
  });
  it('has an Awaiting payment tab for unpaid link orders', () => {
    const t = ownerTab('awaiting_payment');
    expect(t.statuses).toEqual(['payment_pending']);
    expect('channel' in t && t.channel).toBe('payment_link');
  });
});

describe('link not confirmed', () => {
  it('reads the 202 and nothing else', () => {
    expect(readLinkPending(202, { order_id: 'o1', order_number: 1042, link_pending: true, message: 'm' })).toEqual({ order_id: 'o1', order_number: 1042, message: 'm' });
    expect(readLinkPending(201, { order_id: 'o1', order_number: 1042 })).toBeNull();
    expect(readLinkPending(202, { order_id: 'o1' })).toBeNull();
  });
  it('shows Retry link only for an awaiting link order with no url', () => {
    const base = { status: 'payment_pending', payment_channel: 'payment_link', payment_link_url: null };
    expect(needsLinkRetry(base)).toBe(true);
    expect(needsLinkRetry({ ...base, payment_link_url: 'https://rzp.io/i/x' })).toBe(false);
    expect(needsLinkRetry({ ...base, status: 'paid' })).toBe(false);
    expect(needsLinkRetry({ ...base, payment_channel: 'checkout' })).toBe(false);
  });
  it('reads each retry outcome', () => {
    expect(readRetryAnswer(200, { ok: true, payment_link_url: 'https://rzp.io/i/x', payment_link_expires_at: '2026-11-21T10:30:00Z' })).toEqual({ kind: 'link', url: 'https://rzp.io/i/x', expiresAt: '2026-11-21T10:30:00Z' });
    expect(readRetryAnswer(200, { ok: true, payment_link_url: 'https://rzp.io/i/x', status: 'paid' }).kind).toBe('paid');
    expect(readRetryAnswer(502, {}).kind).toBe('unconfirmed');
    expect(readRetryAnswer(409, { error: 'gone' })).toEqual({ kind: 'gone', message: 'gone' });
    expect(readRetryAnswer(500, {}).kind).toBe('error');
  });
  it('reads the products answer', () => {
    expect(readProductsAnswer(200, { products: [] })).toEqual({ kind: 'ok', products: [] });
    expect(readProductsAnswer(503, { error: 'The shop isn\'t open yet — apply supabase/x.sql first' }).kind).toBe('setup');
    expect(readProductsAnswer(503, { error: 'Could not load the products just now — please try again.' }).kind).toBe('error');
    expect(readProductsAnswer(401, {}).kind).toBe('error');
  });
});
