import { describe, expect, it } from 'vitest';
import {
  FALLBACK_STORE_SETTINGS,
  computeBill,
  computeStoreOpenState,
  formatIstTime,
  generatePickupSlots,
} from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

// Store hours / slots / bill math (O5, C3, C4, C5). Deterministic — every test
// passes an explicit `now`. FALLBACK settings are 10:00–24:00 IST daily.
const base = FALLBACK_STORE_SETTINGS;
const withSettings = (o: Partial<StoreSettings>): StoreSettings => ({ ...base, ...o });

// A mid-day-IST instant: 06:30 UTC = 12:00 IST (Wed 2026-07-15).
const midday = new Date('2026-07-15T06:30:00Z');

describe('computeBill', () => {
  it('adds exclusive GST on top of the subtotal', () => {
    const b = computeBill(1000, withSettings({ gst_percent: 5, gst_inclusive: false }));
    expect(b.tax_inr).toBe(50);
    expect(b.total_inr).toBe(1050);
  });

  it('extracts inclusive GST so the total equals the subtotal', () => {
    const b = computeBill(1000, withSettings({ gst_percent: 5, gst_inclusive: true }));
    expect(b.total_inr).toBe(1000);
    expect(b.tax_inr).toBe(48); // 1000 - round(1000/1.05)
  });

  it('rounds tax to the nearest integer rupee', () => {
    const b = computeBill(199, withSettings({ gst_percent: 5, gst_inclusive: false }));
    expect(b.tax_inr).toBe(10); // round(9.95)
  });

  it('adds packaging and subtracts discount', () => {
    const b = computeBill(500, withSettings({ gst_percent: 0, packaging_charge_inr: 20 }), 30);
    expect(b.packaging_inr).toBe(20);
    expect(b.discount_inr).toBe(30);
    expect(b.total_inr).toBe(490); // 500 + 0 + 20 - 30
  });
});

// GST on the taxable value of the supply (CGST Act s.15): the discount on the
// bill is not taxed, packaging is.
describe('computeBill — GST on the taxable value', () => {
  const exclusive = withSettings({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0 });
  const inclusive = withSettings({ gst_percent: 5, gst_inclusive: true, packaging_charge_inr: 0 });

  it('takes the discount (coupon + Beanies) out before GST is added', () => {
    const b = computeBill(500, exclusive, 50);
    expect(b.tax_inr).toBe(23); // 5% of 450 = 22.5
    expect(b.total_inr).toBe(473); // 500 + 23 - 50
  });

  it('taxes packaging at the same rate', () => {
    const b = computeBill(500, { ...exclusive, packaging_charge_inr: 20 });
    expect(b.tax_inr).toBe(26); // 5% of 520
    expect(b.total_inr).toBe(546); // 500 + 26 + 20
  });

  it('taxes lines less the discount, plus packaging, together', () => {
    const b = computeBill(500, { ...exclusive, packaging_charge_inr: 20 }, 50);
    expect(b.tax_inr).toBe(24); // 5% of 450 + 20 = 23.5
    expect(b.total_inr).toBe(494); // 500 + 24 + 20 - 50
    expect(b.total_inr).toBe(b.subtotal_inr + b.tax_inr + b.packaging_inr - b.discount_inr);
  });

  it('extracts GST from the same value when prices include GST, leaving the total as it was', () => {
    const b = computeBill(500, { ...inclusive, packaging_charge_inr: 20 }, 50);
    expect(b.tax_inr).toBe(22); // 470 - 470/1.05 = 22.38
    expect(b.total_inr).toBe(470); // 500 + 20 - 50
  });

  it('rounds GST once on the whole taxable value, not per part', () => {
    // ₹30 of lines (1.5) and ₹10 of packaging (0.5) would round to 2 + 1 apart.
    expect(computeBill(30, { ...exclusive, packaging_charge_inr: 10 }).tax_inr).toBe(2); // 5% of 40
  });

  it('charges GST on nothing but packaging when the discount takes the whole order', () => {
    expect(computeBill(100, exclusive, 100).tax_inr).toBe(0);
    expect(computeBill(100, { ...exclusive, packaging_charge_inr: 20 }, 100).tax_inr).toBe(1); // 5% of 20
    // A discount over the subtotal (callers clamp it) still can't make the value negative.
    expect(computeBill(100, { ...exclusive, packaging_charge_inr: 20 }, 500).tax_inr).toBe(1);
  });
});

describe('computeStoreOpenState', () => {
  it('is open + accepting mid-day', () => {
    const s = computeStoreOpenState(base, midday);
    expect(s.isOpen).toBe(true);
    expect(s.acceptingOrders).toBe(true);
    expect(s.reason).toBe('open');
  });

  it('is closed outside opening hours', () => {
    const early = new Date('2026-07-14T21:30:00Z'); // 03:00 IST
    expect(computeStoreOpenState(base, early).reason).toBe('closed_hours');
  });

  it('reports a holiday when the IST date is in holidays', () => {
    const s = computeStoreOpenState(withSettings({ holidays: ['2026-07-15'] }), midday);
    expect(s.isOpen).toBe(false);
    expect(s.reason).toBe('holiday');
  });

  it('is open but not accepting when paused', () => {
    const s = computeStoreOpenState(withSettings({ accepting_orders: false }), midday);
    expect(s.isOpen).toBe(true);
    expect(s.acceptingOrders).toBe(false);
    expect(s.reason).toBe('paused');
  });

  it('honors force_closed and force_open overrides', () => {
    expect(computeStoreOpenState(withSettings({ store_open_override: 'force_closed' }), midday).reason).toBe('forced_closed');
    const early = new Date('2026-07-14T21:30:00Z');
    expect(computeStoreOpenState(withSettings({ store_open_override: 'force_open' }), early).isOpen).toBe(true);
  });

  it('stops accepting within the last-order cutoff before close', () => {
    const late = new Date('2026-07-15T18:15:00Z'); // 23:45 IST, inside the 30m-before-24:00 cutoff
    const s = computeStoreOpenState(base, late);
    expect(s.isOpen).toBe(true);
    expect(s.reason).toBe('after_cutoff');
  });

  it('force_open bypasses the last-order cutoff (owner override takes orders now)', () => {
    const late = new Date('2026-07-15T18:15:00Z'); // 23:45 IST, inside the cutoff window
    const s = computeStoreOpenState(withSettings({ store_open_override: 'force_open' }), late);
    expect(s.acceptingOrders).toBe(true);
    expect(s.reason).toBe('open');
  });
});

describe('generatePickupSlots', () => {
  it('returns [] when not accepting orders', () => {
    expect(generatePickupSlots(withSettings({ accepting_orders: false }), midday)).toEqual([]);
  });

  it('leads with an ASAP pseudo-slot then real slots', () => {
    const slots = generatePickupSlots(base, midday);
    expect(slots[0].isAsap).toBe(true);
    expect(slots[0].start).toBe('');
    expect(slots.length).toBeGreaterThan(1);
    expect(slots[1].isAsap).toBe(false);
    expect(slots[1].start).not.toBe('');
  });
});

describe('formatIstTime', () => {
  it('formats a UTC instant as IST wall-clock', () => {
    expect(formatIstTime(midday)).toBe('12:00 PM');
    expect(formatIstTime(new Date('2026-07-15T13:00:00Z'))).toBe('6:30 PM');
  });
});
