import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { loadUsedSpendOffers, recordSpendRedemption } from '@/lib/orders/offersServer';
import { isLiveRedemption, RELEASING_ORDER_STATUSES, RELEASING_ORDER_STATUSES_FILTER } from '@/lib/promotions/redemptionLiveness';
import type { OrderStatus } from '@/lib/types';

// When a coupon or spend-offer redemption still counts against a limit
// (lib/promotions/redemptionLiveness.ts) — one rule for the coupon counts and
// the spend offer's once per customer — and the once-per-number race: two
// orders for the same number placed at the same moment both passed the
// "had it?" read, and both got the offer.

describe('a live redemption', () => {
  it('is any order but a cancelled or rejected one', () => {
    const all: OrderStatus[] = ['placed', 'received', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled'];
    for (const s of all) expect(isLiveRedemption(s), s).toBe(s !== 'cancelled' && s !== 'rejected');
    expect(RELEASING_ORDER_STATUSES).toEqual(['cancelled', 'rejected']);
  });

  it('counts when the order cannot be read: a limit is never lifted on a guess', () => {
    expect(isLiveRedemption(null)).toBe(true);
    expect(isLiveRedemption(undefined)).toBe(true);
  });

  it('is the same list the coupon counts send to PostgREST (and try_redeem_coupon repeats in SQL)', () => {
    expect(RELEASING_ORDER_STATUSES_FILTER).toBe('("cancelled","rejected")');
  });
});

const PHONE = '+919876543210';
const OFFER = 'spend-1';
let tables: Record<string, Row[]>;
let admin: ReturnType<typeof makeFakeAdmin>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  tables = { spend_offer_redemptions: [] };
  admin = makeFakeAdmin(tables, { startMs: Date.parse('2026-11-12T10:00:00Z') });
});

/** The fake can't embed: give each row its order's status the way `orders(status)` would. */
function withOrderStatus(statuses: Record<string, string>) {
  for (const r of tables.spend_offer_redemptions) r.orders = { status: statuses[r.order_id as string] ?? 'received' };
}

describe('loadUsedSpendOffers', () => {
  it('counts a live redemption and not a released one', async () => {
    tables.spend_offer_redemptions.push(
      { id: 'r1', spend_offer_id: OFFER, phone: PHONE, order_id: 'o1', orders: { status: 'cancelled' } },
      { id: 'r2', spend_offer_id: 'spend-2', phone: PHONE, order_id: 'o2', orders: [{ status: 'completed' }] },
    );
    const used = await loadUsedSpendOffers(admin as never, [OFFER, 'spend-2'], PHONE);
    expect([...used]).toEqual(['spend-2']);
  });
});

describe('recordSpendRedemption', () => {
  it('records the first', async () => {
    expect(await recordSpendRedemption(admin as never, { offerId: OFFER, phone: PHONE, orderId: 'o1' })).toBe('recorded');
  });

  it('tells the later of two simultaneous orders that the number already had it', async () => {
    const results = await Promise.all([
      recordSpendRedemption(admin as never, { offerId: OFFER, phone: PHONE, orderId: 'o1' }),
      recordSpendRedemption(admin as never, { offerId: OFFER, phone: PHONE, orderId: 'o2' }),
    ]);
    expect(results).toEqual(['recorded', 'taken']);
  });

  it('lets the number have it again once its earlier order was cancelled', async () => {
    tables.spend_offer_redemptions.push({ id: 'old', spend_offer_id: OFFER, phone: PHONE, order_id: 'o0', created_at: '2026-11-01T00:00:00Z' });
    withOrderStatus({ o0: 'cancelled' });
    expect(await recordSpendRedemption(admin as never, { offerId: OFFER, phone: PHONE, orderId: 'o1' })).toBe('recorded');
  });

  it('says taken when a live earlier order holds it', async () => {
    tables.spend_offer_redemptions.push({ id: 'old', spend_offer_id: OFFER, phone: PHONE, order_id: 'o0', created_at: '2026-11-01T00:00:00Z' });
    withOrderStatus({ o0: 'completed' });
    expect(await recordSpendRedemption(admin as never, { offerId: OFFER, phone: PHONE, orderId: 'o1' })).toBe('taken');
  });
});
