import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  readIdempotencyKey,
  releaseIdempotencyKey,
} from '@/lib/orders/idempotency';

// POS4-2 — replay-safe order creation. The scenario: POST /api/orders succeeds
// server-side but the response never reaches the tablet; the staffer taps again.
// Without this, the customer gets a second order — and on the POS settle path,
// a second charge.

const state: {
  insertError: { code?: string } | null;
  existingOrderId: string | null;
  updates: Record<string, unknown>[];
  deleted: boolean;
} = { insertError: null, existingOrderId: null, updates: [], deleted: false };

const admin = {
  from: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      insert: () => Promise.resolve({ error: state.insertError }),
      select: () => chain,
      update: (p: Record<string, unknown>) => {
        state.updates.push(p);
        return chain;
      },
      delete: () => {
        state.deleted = true;
        return chain;
      },
      eq: () => chain,
      is: () => Promise.resolve({ error: null }),
      maybeSingle: () => Promise.resolve({ data: { order_id: state.existingOrderId }, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ error: null }),
    });
    return chain;
  },
} as never;

beforeEach(() => {
  state.insertError = null;
  state.existingOrderId = null;
  state.updates = [];
  state.deleted = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function req(key?: string) {
  return new Request('http://t/api/orders', {
    method: 'POST',
    headers: key === undefined ? {} : { 'Idempotency-Key': key },
  });
}

describe('readIdempotencyKey', () => {
  it('reads a plausible key', () => {
    expect(readIdempotencyKey(req('pos-8f14e45f-ceea-4e0a'))).toBe('pos-8f14e45f-ceea-4e0a');
  });

  it('is null when the header is absent', () => {
    expect(readIdempotencyKey(req())).toBeNull();
  });

  it('rejects a too-short or too-long key', () => {
    // Bounded so a broken client can't write unbounded rows.
    expect(readIdempotencyKey(req('abc'))).toBeNull();
    expect(readIdempotencyKey(req('x'.repeat(201)))).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(readIdempotencyKey(req('  pos-abcdefgh  '))).toBe('pos-abcdefgh');
  });
});

describe('claimIdempotencyKey', () => {
  it('claims an unused key', async () => {
    expect(await claimIdempotencyKey(admin, 'pos-new-key', 'staff-1')).toEqual({ state: 'claimed' });
  });

  it('reports a REPLAY when the key already produced an order', async () => {
    state.insertError = { code: '23505' };
    state.existingOrderId = 'order-1';

    expect(await claimIdempotencyKey(admin, 'pos-used', 'staff-1')).toEqual({
      state: 'replay',
      orderId: 'order-1',
    });
  });

  it('reports IN-FLIGHT when the key is claimed but has no order yet', async () => {
    // Two identical submits racing: the second must not create a duplicate.
    state.insertError = { code: '23505' };
    state.existingOrderId = null;

    expect(await claimIdempotencyKey(admin, 'pos-racing', 'staff-1')).toEqual({ state: 'in_flight' });
  });

  it('fails OPEN when the table is missing, rather than refusing the order', async () => {
    // Losing replay protection is bad; refusing a paying customer because a
    // bookkeeping table was not migrated is worse.
    state.insertError = { code: '42P01' }; // undefined_table

    expect(await claimIdempotencyKey(admin, 'pos-no-table', null)).toEqual({ state: 'unavailable' });
  });
});

describe('complete / release', () => {
  it('points the claim at the created order', async () => {
    await completeIdempotencyKey(admin, 'pos-k', 'order-9');
    expect(state.updates[0]).toEqual({ order_id: 'order-9' });
  });

  it('releases an unfulfilled claim so a genuine retry is not blocked', async () => {
    await releaseIdempotencyKey(admin, 'pos-k');
    expect(state.deleted).toBe(true);
  });
});
