import { beforeEach, describe, expect, it, vi } from 'vitest';

// Promotions → Offers (app/api/offers, lib/promotions/offerInput.ts): the owner
// creates an offer as its own record on a menu item; the item is never written.

import { parseOfferInput } from '@/lib/promotions/offerInput';

const ITEM = '11111111-1111-4111-8111-111111111111';
const OFFER = '55555555-5555-4555-8555-555555555555';

const state: {
  user: { id: string } | null;
  item: Record<string, unknown> | null;
  insertError: { code: string } | null;
  inserted?: Record<string, unknown>;
  updated?: Record<string, unknown>;
  existing: Record<string, unknown> | null;
  writesTo: string[];
} = { user: null, item: null, insertError: null, existing: null, writesTo: [] };

vi.mock('@/lib/api/auth', () => ({ getManagerUser: () => Promise.resolve(state.user) }));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: { write?: 'insert' | 'update' } = {};
      const row = () => ({ ...(state.inserted ?? {}), ...(state.updated ?? {}), id: OFFER, menu_items: { name: 'Instant Coffee' } });
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => Promise.resolve({ data: [], error: null }),
        insert: (p: Record<string, unknown>) => {
          ctx.write = 'insert';
          state.writesTo.push(table);
          state.inserted = p;
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          ctx.write = 'update';
          state.writesTo.push(table);
          state.updated = p;
          return chain;
        },
        single: () =>
          Promise.resolve(state.insertError ? { data: null, error: state.insertError } : { data: row(), error: null }),
        maybeSingle: () =>
          Promise.resolve(
            table === 'menu_items'
              ? { data: state.item, error: null }
              : ctx.write === 'update'
                ? { data: row(), error: null }
                : { data: state.existing, error: null },
          ),
      });
      return chain;
    },
  }),
}));

const { POST } = await import('@/app/api/offers/route');
const { PATCH } = await import('@/app/api/offers/[id]/route');

const post = (body: unknown) =>
  new Request('http://t/api/offers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (body: unknown) =>
  new Request(`http://t/api/offers/${OFFER}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const instantCoffeeOffer = { name: 'Instant Coffee offer', menu_item_id: ITEM, tier_prices: [299, 499, 599] };

beforeEach(() => {
  state.user = { id: 'owner-1' };
  state.item = { id: ITEM, sold_by_weight: false };
  state.insertError = null;
  state.inserted = undefined;
  state.updated = undefined;
  state.existing = { valid_from: null, valid_to: null };
  state.writesTo = [];
});

describe('parseOfferInput', () => {
  it('takes a name, an item and the tier prices; on by default, no window', () => {
    expect(parseOfferInput(instantCoffeeOffer, { partial: false })).toEqual({
      ...instantCoffeeOffer,
      active: true,
      valid_from: null,
      valid_to: null,
    });
  });

  it('refuses a missing name, item or prices, prices that get cheaper, and a window that ends first', () => {
    expect(parseOfferInput({ ...instantCoffeeOffer, name: ' ' }, { partial: false })).toMatch(/name/);
    expect(parseOfferInput({ ...instantCoffeeOffer, menu_item_id: 'x' }, { partial: false })).toMatch(/item/);
    expect(parseOfferInput({ ...instantCoffeeOffer, tier_prices: [499, 299] }, { partial: false })).toMatch(/never cost less/);
    expect(parseOfferInput({ ...instantCoffeeOffer, tier_prices: [0] }, { partial: false })).toMatch(/above ₹0/);
    expect(
      parseOfferInput(
        { ...instantCoffeeOffer, valid_from: '2026-11-02T00:00:00Z', valid_to: '2026-11-01T00:00:00Z' },
        { partial: false },
      ),
    ).toMatch(/end after it starts/);
  });

  it('an edit takes only what it names', () => {
    expect(parseOfferInput({ active: false }, { partial: true })).toEqual({ active: false });
  });
});

describe('POST /api/offers', () => {
  it('creates the offer as its own record and never writes the menu item', async () => {
    const res = await POST(post(instantCoffeeOffer));
    expect(res.status).toBe(201);
    expect(state.writesTo).toEqual(['menu_offers']);
    expect(state.inserted).toMatchObject({ ...instantCoffeeOffer, active: true });
    expect((await res.json()).offer).toMatchObject({ name: 'Instant Coffee offer', item_name: 'Instant Coffee' });
  });

  it('is for managers and the owner only', async () => {
    state.user = null;
    expect((await POST(post(instantCoffeeOffer))).status).toBe(401);
  });

  it('refuses an item sold by weight, and one that no longer exists', async () => {
    state.item = { id: ITEM, sold_by_weight: true };
    expect((await POST(post(instantCoffeeOffer))).status).toBe(400);
    state.item = null;
    expect((await POST(post(instantCoffeeOffer))).status).toBe(400);
    expect(state.writesTo).toEqual([]);
  });

  it('says why when the item already has a switched-on offer, or the database update is missing', async () => {
    state.insertError = { code: '23505' };
    const dup = await POST(post(instantCoffeeOffer));
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/already has an offer switched on/);
    state.insertError = { code: '42P01' };
    const missing = await POST(post(instantCoffeeOffer));
    expect(missing.status).toBe(409);
    expect((await missing.json()).error).toMatch(/2026-10-item-offers\.sql/);
  });
});

describe('PATCH /api/offers/[id]', () => {
  const params = { params: { id: OFFER } };

  it('switches an offer off', async () => {
    const res = await PATCH(patch({ active: false }), params);
    expect(res.status).toBe(200);
    expect(state.updated).toMatchObject({ active: false });
  });

  it('keeps an offer on its item, and checks the window against what is already saved', async () => {
    expect((await PATCH(patch({ menu_item_id: ITEM }), params)).status).toBe(400);
    state.existing = { valid_from: '2026-11-10T00:00:00Z', valid_to: null };
    expect((await PATCH(patch({ valid_to: '2026-11-05T00:00:00Z' }), params)).status).toBe(400);
    expect(state.updated).toBeUndefined();
  });
});
