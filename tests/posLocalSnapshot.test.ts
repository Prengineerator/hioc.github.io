import { describe, expect, it } from 'vitest';
import { parseSnapshot, readSnapshot, snapshotAgeLabel, snapshotStorageKey, writeSnapshot } from '@/lib/pos/localSnapshot';
import { toTablesBoardSnapshot } from '@/lib/pos/posSnapshots';
import type { OrderWithItems } from '@/lib/staff/tableOccupancy';

// POS screens draw what this machine last saw, then refresh. A kept answer
// must be the right shape and recent, and the copy that outlives a reload must
// not carry customer details.

const now = 1_800_000_000_000;
const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number');

describe('parseSnapshot', () => {
  it('returns a recent, well-formed snapshot', () => {
    const raw = JSON.stringify({ savedAt: now - 1000, data: [1, 2] });
    expect(parseSnapshot(raw, now, 60_000, isNumbers)).toEqual({ savedAt: now - 1000, data: [1, 2] });
  });

  it('refuses junk, the wrong shape, stale and future-dated copies', () => {
    expect(parseSnapshot(null, now, 60_000, isNumbers)).toBeNull();
    expect(parseSnapshot('{x', now, 60_000, isNumbers)).toBeNull();
    expect(parseSnapshot(JSON.stringify({ savedAt: now, data: ['a'] }), now, 60_000, isNumbers)).toBeNull();
    expect(parseSnapshot(JSON.stringify({ savedAt: now - 60_001, data: [1] }), now, 60_000, isNumbers)).toBeNull();
    expect(parseSnapshot(JSON.stringify({ savedAt: now + 1, data: [1] }), now, 60_000, isNumbers)).toBeNull();
  });
});

describe('memory snapshots', () => {
  it('reads back what was written, within its age', () => {
    const opts = { store: 'memory' as const, maxAgeMs: 60_000, validate: isNumbers };
    writeSnapshot('test-mem', [7], opts, now);
    expect(readSnapshot('test-mem', opts, now + 1000)?.data).toEqual([7]);
    expect(readSnapshot('test-mem', opts, now + 60_001)).toBeNull();
  });
});

describe('snapshotStorageKey', () => {
  it('carries the build, so a deploy never reads an old shape', () => {
    expect(snapshotStorageKey('tables', 'abc123')).toBe('hioc.pos.snap.abc123.tables');
  });
});

describe('snapshotAgeLabel', () => {
  it('reads naturally', () => {
    expect(snapshotAgeLabel(now - 10_000, now)).toBe('just now');
    expect(snapshotAgeLabel(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(snapshotAgeLabel(now - 2 * 60 * 60_000, now)).toBe('2 h ago');
  });
});

describe('toTablesBoardSnapshot', () => {
  const base = {
    id: 'o1',
    order_type: 'dine_in',
    status: 'preparing',
    table_id: 't1',
    customer_name: 'Asha',
    customer_phone: '9876543210',
    customer_email: 'a@example.com',
    notes: 'no sugar',
    items: [],
  } as unknown as OrderWithItems;

  it('keeps only open dine-in orders and blanks the customer details', () => {
    const takeaway = { ...base, id: 'o2', order_type: 'takeaway', table_id: null } as unknown as OrderWithItems;
    const done = { ...base, id: 'o3', status: 'completed' } as unknown as OrderWithItems;
    const kept = toTablesBoardSnapshot([base, takeaway, done]);
    expect(kept.map((o) => o.id)).toEqual(['o1']);
    expect(kept[0]).toMatchObject({ customer_name: '', customer_phone: '', customer_email: null, notes: '' });
    expect(kept[0].table_id).toBe('t1');
  });
});
