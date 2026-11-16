import { describe, expect, it } from 'vitest';
import { defaultPackage, validatePackage } from '@/lib/shop/catalog';
import { parseCancelReason, parseShippedInput, shopOrdersCsvTable } from '@/lib/shop/owner';
import {
  canCancel,
  canMarkDelivered,
  canMarkShipped,
  canSendToShiprocket,
  ownerTab,
  shiprocketBillCheck,
  shiprocketBillWarning,
  shopOrderRef,
  shopStatusFromShiprocket,
  shouldCancelInShiprocket,
  toPublicView,
  trackingUrl,
} from '@/lib/shop/status';
import { shopOrder } from './helpers/shopFixture';

describe('what the owner can do next', () => {
  it('sends only a paid order not yet in Shiprocket', () => {
    expect(canSendToShiprocket(shopOrder())).toBe(true);
    expect(canSendToShiprocket(shopOrder({ shiprocket_order_id: '123' }))).toBe(false);
    expect(canSendToShiprocket(shopOrder({ status: 'payment_pending' }))).toBe(false);
    expect(canSendToShiprocket(shopOrder({ status: 'cancelled' }))).toBe(false);
  });

  it('marks shipped from paid or in-Shiprocket, delivered from shipped', () => {
    expect(canMarkShipped(shopOrder())).toBe(true);
    expect(canMarkShipped(shopOrder({ status: 'sent_to_shiprocket' }))).toBe(true);
    expect(canMarkShipped(shopOrder({ status: 'shipped' }))).toBe(false);
    expect(canMarkDelivered(shopOrder({ status: 'shipped' }))).toBe(true);
    expect(canMarkDelivered(shopOrder({ status: 'paid' }))).toBe(false);
  });

  it('cancels (and refunds) any paid order, never an unpaid or cancelled one', () => {
    for (const s of ['paid', 'sent_to_shiprocket', 'shipped', 'delivered'] as const) expect(canCancel(shopOrder({ status: s }))).toBe(true);
    expect(canCancel(shopOrder({ status: 'payment_pending' }))).toBe(false);
    expect(canCancel(shopOrder({ status: 'cancelled' }))).toBe(false);
  });

  it('cancels in Shiprocket only before the courier has it', () => {
    expect(shouldCancelInShiprocket(shopOrder({ status: 'sent_to_shiprocket', shiprocket_order_id: '9' }))).toBe(true);
    expect(shouldCancelInShiprocket(shopOrder({ status: 'shipped', shiprocket_order_id: '9' }))).toBe(false);
    expect(shouldCancelInShiprocket(shopOrder({ status: 'sent_to_shiprocket' }))).toBe(false);
  });

  it('falls back to the To ship tab', () => {
    expect(ownerTab('delivered').key).toBe('delivered');
    expect(ownerTab('nonsense').key).toBe('to_ship');
    expect(ownerTab(undefined).statuses).toEqual(['paid']);
  });
});

describe('shopStatusFromShiprocket', () => {
  it('moves to shipped on an AWB or a status past pickup', () => {
    expect(shopStatusFromShiprocket('sent_to_shiprocket', 'NEW', 'AWB123')).toBe('shipped');
    expect(shopStatusFromShiprocket('sent_to_shiprocket', 'PICKUP SCHEDULED', null)).toBe('shipped');
    expect(shopStatusFromShiprocket('sent_to_shiprocket', 'In Transit', null)).toBe('shipped');
  });

  it('stays put while Shiprocket has done nothing yet', () => {
    expect(shopStatusFromShiprocket('sent_to_shiprocket', 'NEW', null)).toBeNull();
    expect(shopStatusFromShiprocket('sent_to_shiprocket', null, '')).toBeNull();
  });

  it('moves to delivered on DELIVERED, from either step', () => {
    expect(shopStatusFromShiprocket('shipped', 'DELIVERED', 'AWB1')).toBe('delivered');
    expect(shopStatusFromShiprocket('sent_to_shiprocket', 'Delivered', 'AWB1')).toBe('delivered');
  });

  it('never reads a return, a cancellation or a loss as progress', () => {
    expect(shopStatusFromShiprocket('shipped', 'RTO DELIVERED', 'AWB1')).toBeNull();
    expect(shopStatusFromShiprocket('shipped', 'RTO_INITIATED', 'AWB1')).toBeNull();
    expect(shopStatusFromShiprocket('sent_to_shiprocket', 'CANCELED', 'AWB1')).toBeNull();
    expect(shopStatusFromShiprocket('shipped', 'LOST', 'AWB1')).toBeNull();
  });

  it('only moves orders that are with Shiprocket', () => {
    expect(shopStatusFromShiprocket('paid', 'DELIVERED', 'AWB1')).toBeNull();
    expect(shopStatusFromShiprocket('cancelled', 'DELIVERED', 'AWB1')).toBeNull();
    expect(shopStatusFromShiprocket('delivered', 'DELIVERED', 'AWB1')).toBeNull();
  });
});

describe('the customer view', () => {
  it('leaves out the street, phone and email', () => {
    const view = toPublicView(shopOrder({ awb_code: 'AWB 7' }));
    const text = JSON.stringify(view);
    expect(text).not.toContain('Rose Villa');
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('riya@example.com');
    expect(view.ship_to).toEqual({ name: 'Riya Sharma', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' });
    expect(view.tracking_url).toBe('https://shiprocket.co/tracking/AWB%207');
  });

  it('has no tracking link without an AWB', () => {
    expect(trackingUrl(null)).toBeNull();
    expect(trackingUrl('  ')).toBeNull();
  });

  it('numbers orders HIOC-S1001', () => {
    expect(shopOrderRef(1001)).toBe('HIOC-S1001');
  });
});

describe('the parcel', () => {
  it('starts from a box per jar count', () => {
    // Measured: a real 3-jar order, 0.65 kg in a 7 × 3.5 × 5 inch box.
    expect(defaultPackage(3)).toEqual({ weight_kg: 0.65, length_cm: 18, breadth_cm: 9, height_cm: 13 });
    // Estimated from that box.
    expect(defaultPackage(1)).toEqual({ weight_kg: 0.27, length_cm: 9, breadth_cm: 9, height_cm: 13 });
    expect(defaultPackage(2)).toEqual({ weight_kg: 0.46, length_cm: 12, breadth_cm: 9, height_cm: 13 });
    expect(defaultPackage(0).weight_kg).toBe(0.27);
    expect(defaultPackage(4).weight_kg).toBe(0.84);
  });

  it('keeps the small boxes billed on dead weight, not volume', () => {
    for (const n of [1, 2, 3]) {
      const p = defaultPackage(n);
      expect((p.length_cm * p.breadth_cm * p.height_cm) / 5000).toBeLessThan(p.weight_kg);
    }
  });

  it('accepts the owner’s numbers (as text too) and refuses silly ones', () => {
    expect(validatePackage({ weight_kg: '0.75', length_cm: 20, breadth_cm: '12', height_cm: 10 })).toEqual({
      ok: true,
      pkg: { weight_kg: 0.75, length_cm: 20, breadth_cm: 12, height_cm: 10 },
    });
    expect(validatePackage({ weight_kg: 0, length_cm: 20, breadth_cm: 12, height_cm: 10 }).ok).toBe(false);
    expect(validatePackage({ weight_kg: 1, length_cm: 200, breadth_cm: 12, height_cm: 10 }).ok).toBe(false);
    expect(validatePackage({ weight_kg: 1, length_cm: 20, breadth_cm: '', height_cm: 10 }).ok).toBe(false);
    expect(validatePackage(null).ok).toBe(false);
  });
});

describe('owner inputs and the CSV', () => {
  it('needs an AWB to mark shipped; the courier is optional', () => {
    expect(parseShippedInput({ awb_code: ' 1234 5678 ', courier_name: '  Delhivery ' })).toEqual({
      ok: true,
      awb_code: '12345678',
      courier_name: 'Delhivery',
    });
    expect(parseShippedInput({ awb_code: '12' }).ok).toBe(false);
    expect(parseShippedInput({ awb_code: 'AWB<script>' }).ok).toBe(false);
    expect(parseShippedInput({ awb_code: 'AWB1234' })).toEqual({ ok: true, awb_code: 'AWB1234', courier_name: null });
  });

  it('keeps the cancel reason optional and short', () => {
    expect(parseCancelReason(undefined)).toEqual({ ok: true, reason: '' });
    expect(parseCancelReason('  out of   stock ')).toEqual({ ok: true, reason: 'out of stock' });
    expect(parseCancelReason(5).ok).toBe(false);
    expect(parseCancelReason('x'.repeat(201)).ok).toBe(false);
  });

  it('writes one row per order with the money and the shipping ids', () => {
    const table = shopOrdersCsvTable([shopOrder({ status: 'shipped', awb_code: 'AWB9', courier_name: 'Delhivery', shiprocket_order_id: '55' })]);
    expect(table.columns[0]).toBe('Order');
    const row = table.rows[0];
    expect(row[0]).toBe('HIOC-S1001');
    expect(row[1]).toBe('2026-11-12 14:05'); // paid_at in IST
    expect(row[2]).toBe('Shipped');
    expect(row).toContain('Signature Classic × 2');
    expect(row).toContain(847);
    expect(row).toContain('AWB9');
  });
});

describe("checking Shiprocket's bill against what the customer paid", () => {
  const sent = { shiprocket_order_id: '1733716182', total_inr: 749 };

  it('has nothing to check for an order not in Shiprocket', () => {
    expect(shiprocketBillCheck(shopOrder())).toBeNull();
    expect(shiprocketBillWarning(shopOrder({ shiprocket_total_inr: 301 }))).toBeNull();
  });

  it('is unchecked until Shiprocket’s total has been read back', () => {
    expect(shiprocketBillCheck(shopOrder({ ...sent, shiprocket_total_inr: null }))).toEqual({ state: 'unchecked' });
    expect(shiprocketBillWarning(shopOrder({ ...sent, shiprocket_total_inr: null }))).toBeNull();
  });

  it('matches when Shiprocket’s total is what was paid (paise aside)', () => {
    expect(shiprocketBillCheck(shopOrder({ ...sent, shiprocket_total_inr: 749 }))).toEqual({ state: 'matches', shiprocket: 749 });
    expect(shiprocketBillCheck(shopOrder({ ...sent, shiprocket_total_inr: 749.4 }))?.state).toBe('matches');
    expect(shiprocketBillWarning(shopOrder({ ...sent, shiprocket_total_inr: 749 }))).toBeNull();
  });

  it('flags a bill like HIOC-S1004’s on any other order: paid ₹749, Shiprocket’s bill ₹301', () => {
    const order = shopOrder({ ...sent, order_number: 1005, shiprocket_order_id: '1733999999', shiprocket_total_inr: 301 });
    expect(shiprocketBillCheck(order)).toEqual({ state: 'differs', shiprocket: 301, paid: 749 });
    const warning = shiprocketBillWarning(order);
    expect(warning).toContain('₹301');
    expect(warning).toContain('₹749');
  });

  it('treats HIOC-S1004 at exactly ₹301 as the accepted exception: a note, no warning', () => {
    const s1004 = shopOrder({ ...sent, order_number: 1004, shiprocket_total_inr: 301 });
    const check = shiprocketBillCheck(s1004);
    expect(check).toMatchObject({ state: 'exception', shiprocket: 301, paid: 749 });
    expect(check?.state === 'exception' && check.note).toMatch(/Accepted/);
    expect(shiprocketBillWarning(s1004)).toBeNull();
  });

  it('flags HIOC-S1004 again if its bill changes, and never extends the exception to another order', () => {
    expect(shiprocketBillCheck(shopOrder({ ...sent, order_number: 1004, shiprocket_total_inr: 599 }))?.state).toBe('differs');
    // Same number, a different Shiprocket order (e.g. sent again): flagged.
    expect(shiprocketBillCheck(shopOrder({ ...sent, order_number: 1004, shiprocket_order_id: '1800000000', shiprocket_total_inr: 301 }))?.state).toBe('differs');
    // Matching again is just a match.
    expect(shiprocketBillCheck(shopOrder({ ...sent, order_number: 1004, shiprocket_total_inr: 749 }))?.state).toBe('matches');
  });

  it('flags a bill that left out the shipping (2 jars on the offer: ₹599 + ₹49)', () => {
    const order = shopOrder({ shiprocket_order_id: '9', subtotal_inr: 798, discount_inr: 199, shipping_inr: 49, total_inr: 648, shiprocket_total_inr: 599 });
    expect(shiprocketBillCheck(order)).toEqual({ state: 'differs', shiprocket: 599, paid: 648 });
  });
});
