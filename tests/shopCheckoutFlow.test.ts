import { describe, expect, it } from 'vitest';
import {
  attemptFingerprint,
  buildCartLines,
  canAdvance,
  checkDelivery,
  couponBlockedMessage,
  initialStep,
  isCouponBlocked,
  lineKey,
  nextStep,
  pickDisplayQuote,
  prevStep,
  primaryActionLabel,
  shouldRotateKey,
  type DeliverySelection,
} from '@/lib/shop/checkoutFlow';
import type { ShopProduct } from '@/lib/shop/types';

const goodForm = {
  customer_name: 'Asha Rao',
  phone: '9876543210',
  email: 'asha@example.com',
  address_line1: '12 MG Road',
  address_line2: '',
  landmark: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const formDelivery = (form: Record<string, unknown> = goodForm): DeliverySelection => ({ mode: 'form', addressId: null, email: '', form });
const savedDelivery = (addressId: string | null = 'a1', email = 'asha@example.com'): DeliverySelection => ({
  mode: 'saved', addressId, email, form: {},
});

describe('canAdvance', () => {
  it('Choose needs at least one item', () => {
    expect(canAdvance({ step: 'choose', itemCount: 0, delivery: formDelivery() })).toMatchObject({ ok: false, focus: 'products' });
    expect(canAdvance({ step: 'choose', itemCount: 1, delivery: formDelivery({}) })).toEqual({ ok: true });
  });
  it('Deliver to needs a valid draft and names the field to focus', () => {
    expect(canAdvance({ step: 'deliver', itemCount: 1, delivery: formDelivery() })).toEqual({ ok: true });
    const r = canAdvance({ step: 'deliver', itemCount: 1, delivery: formDelivery({ ...goodForm, pincode: '12' }) });
    expect(r).toMatchObject({ ok: false, focus: 'pincode' });
    expect(canAdvance({ step: 'deliver', itemCount: 1, delivery: formDelivery({ ...goodForm, customer_name: '' }) })).toMatchObject({
      ok: false,
      focus: 'customer_name',
    });
  });
  it('Deliver to with a saved address needs a selection and a receipt email', () => {
    expect(canAdvance({ step: 'deliver', itemCount: 1, delivery: savedDelivery() })).toEqual({ ok: true });
    expect(canAdvance({ step: 'deliver', itemCount: 1, delivery: savedDelivery(null) })).toMatchObject({ ok: false, focus: 'address' });
    expect(canAdvance({ step: 'deliver', itemCount: 1, delivery: savedDelivery('a1', 'nope') })).toMatchObject({ ok: false, focus: 'email' });
  });
  it('Pay needs both the cart and the address', () => {
    expect(canAdvance({ step: 'pay', itemCount: 0, delivery: formDelivery() })).toMatchObject({ ok: false });
    expect(canAdvance({ step: 'pay', itemCount: 2, delivery: formDelivery({}) })).toMatchObject({ ok: false });
    expect(canAdvance({ step: 'pay', itemCount: 2, delivery: savedDelivery() })).toEqual({ ok: true });
  });
});

describe('checkDelivery', () => {
  it('returns the normalised address for a form, and the id for a saved address', () => {
    const f = checkDelivery(formDelivery());
    expect(f).toMatchObject({ ok: true, mode: 'form' });
    if (f.ok && f.mode === 'form') expect(f.address.phone).toBe('+919876543210');
    expect(checkDelivery(savedDelivery('a9', ' Asha@Example.com '))).toEqual({
      ok: true, mode: 'saved', addressId: 'a9', email: 'asha@example.com',
    });
  });
});

describe('nextStep / prevStep', () => {
  it('Choose goes to Deliver to, or past it with a saved address selected', () => {
    expect(nextStep({ step: 'choose', delivery: formDelivery() })).toBe('deliver');
    expect(nextStep({ step: 'choose', delivery: savedDelivery() })).toBe('pay');
    expect(nextStep({ step: 'choose', delivery: savedDelivery(null) })).toBe('deliver');
    // a saved address that still needs a receipt email stops at Deliver to
    expect(nextStep({ step: 'choose', delivery: savedDelivery('a1', '') })).toBe('deliver');
    expect(nextStep({ step: 'deliver', delivery: formDelivery() })).toBe('pay');
    expect(nextStep({ step: 'pay', delivery: formDelivery() })).toBe('pay');
  });
  it('Back from Pay skips a skipped Deliver to', () => {
    expect(prevStep({ step: 'pay', delivery: savedDelivery() })).toBe('choose');
    expect(prevStep({ step: 'pay', delivery: formDelivery() })).toBe('deliver');
    expect(prevStep({ step: 'deliver', delivery: formDelivery() })).toBe('choose');
    expect(prevStep({ step: 'choose', delivery: formDelivery() })).toBe('choose');
  });
});

describe('initialStep', () => {
  const stored = (step: 'choose' | 'deliver' | 'pay') => ({ items: [{ product_id: 'classic', quantity: 1 }], step });
  it('opens on Choose with nothing stored', () => {
    expect(initialStep({ stored: null, query: null, hasDefaultAddress: false })).toBe('choose');
    expect(initialStep({ stored: null, query: 'pay', hasDefaultAddress: true })).toBe('choose');
    expect(initialStep({ stored: { items: [], step: 'pay' }, query: 'pay', hasDefaultAddress: true })).toBe('choose');
  });
  it('resumes a reorder on Pay', () => {
    expect(initialStep({ stored: stored('pay'), query: 'pay', hasDefaultAddress: false })).toBe('pay');
    expect(initialStep({ stored: stored('choose'), query: 'pay', hasDefaultAddress: true })).toBe('pay');
  });
  it('skips Deliver to for a customer with a default address', () => {
    expect(initialStep({ stored: stored('deliver'), query: null, hasDefaultAddress: true })).toBe('pay');
    expect(initialStep({ stored: stored('deliver'), query: null, hasDefaultAddress: false })).toBe('deliver');
  });
  it('a guest coming back from the sign-in round trip lands on Deliver to; a Choose cart stays on Choose', () => {
    expect(initialStep({ stored: stored('pay'), query: null, hasDefaultAddress: false })).toBe('deliver');
    expect(initialStep({ stored: stored('choose'), query: null, hasDefaultAddress: true })).toBe('choose');
    expect(initialStep({ stored: stored('choose'), query: 'other', hasDefaultAddress: false })).toBe('choose');
  });
});

describe('primaryActionLabel', () => {
  it('says what the one primary button does', () => {
    expect(primaryActionLabel('choose', 399)).toBe('Continue');
    expect(primaryActionLabel('deliver', 399)).toBe('Continue to pay');
    expect(primaryActionLabel('pay', 1197)).toBe('Pay ₹1,197');
    expect(primaryActionLabel('pay', 1234567)).toBe('Pay ₹12,34,567');
    expect(primaryActionLabel('pay', null)).toBe('Pay');
    expect(primaryActionLabel('pay', 0)).toBe('Pay');
  });
});

describe('shouldRotateKey', () => {
  const fp = attemptFingerprint({
    items: [{ product_id: 'classic', quantity: 2 }], address: null, address_id: 'a1', coupon_code: null, use_beanies: true, save_address_label: null,
  });
  it('takes a key for the first attempt', () => {
    expect(shouldRotateKey(null, fp, null)).toBe(true);
    expect(shouldRotateKey(undefined, fp, null)).toBe(true);
  });
  it('keeps the key for plain retries, including a 409 that only showed a new total', () => {
    expect(shouldRotateKey(fp, fp, null)).toBe(false);
    expect(shouldRotateKey(fp, fp, 'network')).toBe(false);
    expect(shouldRotateKey(fp, fp, 'price_changed')).toBe(false);
    expect(shouldRotateKey(fp, fp, 'idempotency_in_progress')).toBe(false);
  });
  it('rotates when the cart, address, code or Beanies choice changed', () => {
    const base = { items: [{ product_id: 'classic', quantity: 2 }], address: null, address_id: 'a1', coupon_code: null, use_beanies: true, save_address_label: null };
    expect(shouldRotateKey(fp, attemptFingerprint({ ...base, items: [{ product_id: 'classic', quantity: 3 }] }), null)).toBe(true);
    expect(shouldRotateKey(fp, attemptFingerprint({ ...base, address_id: 'a2' }), null)).toBe(true);
    expect(shouldRotateKey(fp, attemptFingerprint({ ...base, coupon_code: 'WELCOME' }), null)).toBe(true);
    expect(shouldRotateKey(fp, attemptFingerprint({ ...base, use_beanies: false }), null)).toBe(true);
    expect(shouldRotateKey(fp, attemptFingerprint(base, { lat: 1, lng: 2 }), null)).toBe(true);
  });
  it('rotates after the server refuses the key', () => {
    expect(shouldRotateKey(fp, fp, 'idempotency_mismatch')).toBe(true);
    expect(shouldRotateKey(fp, fp, 'idempotency_expired')).toBe(true);
  });
  it('does not care how the cart lines were ordered or how the code was cased', () => {
    const a = attemptFingerprint({ items: [{ product_id: 'a', quantity: 1 }, { product_id: 'b', quantity: 1 }], address: null, address_id: 'x', coupon_code: 'Save', use_beanies: true, save_address_label: null });
    const b = attemptFingerprint({ items: [{ product_id: 'b', quantity: 1 }, { product_id: 'a', quantity: 1 }], address: null, address_id: 'x', coupon_code: 'save', use_beanies: true, save_address_label: null });
    expect(shouldRotateKey(a, b, null)).toBe(false);
  });
});

describe('buildCartLines', () => {
  const p = (over: Partial<ShopProduct>): ShopProduct => ({
    id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1,
    line: 'instant', display_name: '', pack_grams: 50, ship_weight_kg: 0.3, listed: true, requires_grind: false, description: '', ...over,
  });
  const products = [p({}), p({ id: 'hb-500', name: 'Home Blend 500', sku: 'HIOC-HB-500G', price_inr: 650, line: 'home_blend', pack_grams: 500, requires_grind: true })];
  it('builds one line per cart item, each with its own grind, and skips unknown products', () => {
    const lines = buildCartLines(products, [
      { product_id: 'classic', quantity: 2 },
      { product_id: 'hb-500', quantity: 1, grind: 'filter' },
      { product_id: 'hb-500', quantity: 1, grind: 'moka' },
      { product_id: 'gone', quantity: 1 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ quantity: 2, line_total_inr: 798, grind: null });
    expect(lines[1]).toMatchObject({ sku: 'HIOC-HB-500G-FLT', grind_label: 'Pour-over / Filter', line_total_inr: 650 });
    expect(new Set(lines.map(lineKey)).size).toBe(3);
  });
});

describe('pickDisplayQuote (Pay keeps the last server figure while refreshing)', () => {
  const local = { id: 'local' };
  const server = { id: 'server' };
  const base = { quote: local, fromServer: false, lastServerQuote: server, loading: true };
  it('keeps the last server quote on Pay while a refresh is pending', () => {
    expect(pickDisplayQuote({ step: 'pay', ...base })).toBe(server);
  });
  it('uses the local quote on Choose, before any server figure, or when not loading', () => {
    expect(pickDisplayQuote({ step: 'choose', ...base })).toBe(local);
    expect(pickDisplayQuote({ step: 'pay', ...base, lastServerQuote: null })).toBe(local);
    expect(pickDisplayQuote({ step: 'pay', ...base, loading: false })).toBe(local);
  });
  it('uses the current server quote as is', () => {
    expect(pickDisplayQuote({ step: 'pay', quote: server, fromServer: true, lastServerQuote: server, loading: false })).toBe(server);
  });
});

describe('isCouponBlocked / couponBlockedMessage', () => {
  it('blocks Pay only for an applied code the server refused', () => {
    expect(isCouponBlocked({ appliedCode: 'X', couponError: 'Expired.', fromServer: true })).toBe(true);
    expect(isCouponBlocked({ appliedCode: null, couponError: 'Expired.', fromServer: true })).toBe(false);
    expect(isCouponBlocked({ appliedCode: 'X', couponError: null, fromServer: true })).toBe(false);
    expect(isCouponBlocked({ appliedCode: 'X', couponError: 'Expired.', fromServer: false })).toBe(false);
  });
  it('words the reason and the total to pay', () => {
    expect(couponBlockedMessage('This code has expired.', 450)).toBe("This code can't be used: This code has expired. Remove it to pay ₹450");
  });
});
