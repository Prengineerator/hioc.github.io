import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IDEMPOTENCY_CLAIM_TTL_MS,
  IDEMPOTENCY_KEY_TRANSITIONS,
  idempotencyKeyState,
  releaseIdempotencyKey,
} from '@/lib/orders/idempotency';

// An idempotency key's life (lib/orders/idempotency.ts): free → claimed →
// completed | released, and the fix — a claim whose request died before it
// completed used to answer "already being placed" for ever.

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('the key states', () => {
  it('reads each state from the row', () => {
    expect(idempotencyKeyState(null, NOW)).toBe('free');
    expect(idempotencyKeyState({ order_id: 'o1', created_at: ago(1000) }, NOW)).toBe('completed');
    expect(idempotencyKeyState({ order_id: 'o1', created_at: ago(IDEMPOTENCY_CLAIM_TTL_MS * 10) }, NOW)).toBe('completed');
    expect(idempotencyKeyState({ order_id: null, created_at: ago(5000) }, NOW)).toBe('claimed');
    expect(idempotencyKeyState({ order_id: null, created_at: ago(IDEMPOTENCY_CLAIM_TTL_MS) }, NOW)).toBe('stale');
    // Unknown age counts as live: never risk a duplicate order on a guess.
    expect(idempotencyKeyState({ order_id: null }, NOW)).toBe('claimed');
  });

  it('outlives the longest a create can run (the platform default ceiling, 300 s)', () => {
    expect(IDEMPOTENCY_CLAIM_TTL_MS).toBeGreaterThan(300_000);
  });

  it('has completed as its end', () => {
    expect(IDEMPOTENCY_KEY_TRANSITIONS.some((t) => t.from === 'completed')).toBe(false);
  });
});

// The table, with its primary key on `key`.
let tables: Record<string, Row[]>;
let fake: ReturnType<typeof makeFakeAdmin>;
const admin = {
  from(table: string) {
    const chain = fake.from(table);
    return {
      ...chain,
      insert(row: Row) {
        if (tables.idempotency_keys.some((r) => r.key === row.key)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
        tables.idempotency_keys.push({ order_id: null, created_at: new Date().toISOString(), ...row });
        return Promise.resolve({ error: null });
      },
    };
  },
} as never;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  tables = { idempotency_keys: [] };
  fake = makeFakeAdmin(tables, { startMs: NOW });
  return () => vi.useRealTimers();
});

describe('claim / complete / release', () => {
  it('claims, then a replay gets the order, and completing twice keeps the first', async () => {
    expect(await claimIdempotencyKey(admin, 'pos-key-1', 'staff-1')).toEqual({ state: 'claimed' });
    expect(await claimIdempotencyKey(admin, 'pos-key-1', 'staff-1')).toEqual({ state: 'in_flight' });
    await completeIdempotencyKey(admin, 'pos-key-1', 'order-1');
    await completeIdempotencyKey(admin, 'pos-key-1', 'order-2');
    expect(await claimIdempotencyKey(admin, 'pos-key-1', 'staff-1')).toEqual({ state: 'replay', orderId: 'order-1' });
  });

  it('a released key can be claimed again', async () => {
    await claimIdempotencyKey(admin, 'pos-key-2', null);
    await releaseIdempotencyKey(admin, 'pos-key-2');
    expect(await claimIdempotencyKey(admin, 'pos-key-2', null)).toEqual({ state: 'claimed' });
  });
});

describe('a claim whose request died', () => {
  it('is "in flight" while it could still be alive', async () => {
    tables.idempotency_keys.push({ key: 'pos-dead', order_id: null, created_at: ago(IDEMPOTENCY_CLAIM_TTL_MS - 1000) });
    expect(await claimIdempotencyKey(admin, 'pos-dead', 'staff-1')).toEqual({ state: 'in_flight' });
  });

  it('is taken over once stale, instead of answering 409 for ever', async () => {
    tables.idempotency_keys.push({ key: 'pos-dead', order_id: null, created_at: ago(IDEMPOTENCY_CLAIM_TTL_MS + 1000) });
    expect(await claimIdempotencyKey(admin, 'pos-dead', 'staff-2')).toEqual({ state: 'claimed' });
    // The new holder has the full window; a second retry now waits for it.
    expect(tables.idempotency_keys[0]).toMatchObject({ created_at: new Date(NOW).toISOString(), created_by: 'staff-2' });
    expect(await claimIdempotencyKey(admin, 'pos-dead', 'staff-3')).toEqual({ state: 'in_flight' });
  });

  it('is never taken over once it has an order', async () => {
    tables.idempotency_keys.push({ key: 'pos-old', order_id: 'order-9', created_at: ago(IDEMPOTENCY_CLAIM_TTL_MS * 3) });
    expect(await claimIdempotencyKey(admin, 'pos-old', 'staff-1')).toEqual({ state: 'replay', orderId: 'order-9' });
  });

  it('of two retries racing for a stale claim, only one gets it', async () => {
    tables.idempotency_keys.push({ key: 'pos-dead', order_id: null, created_at: ago(IDEMPOTENCY_CLAIM_TTL_MS + 1000) });
    const results = await Promise.all([claimIdempotencyKey(admin, 'pos-dead', 'a'), claimIdempotencyKey(admin, 'pos-dead', 'b')]);
    expect(results.filter((r) => r.state === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.state === 'in_flight')).toHaveLength(1);
  });
});
