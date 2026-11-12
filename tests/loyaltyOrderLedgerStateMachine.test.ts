import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import {
  canOrderLedgerOp,
  ORDER_LEDGER_TRANSITIONS,
  ORDER_LOYALTY_STATES,
  orderLoyaltyState,
  pointsToReverse,
  standingRow,
  type OrderLedgerOp,
  type OrderLedgerRow,
} from '@/lib/loyalty/orderLedger';

// One order's Beanies (lib/loyalty/orderLedger.ts): redeem at checkout, earn
// on completion, reverse on cancel/refund — each once, and nothing after a
// reverse. Then the ledger writers (lib/loyalty/ledger.ts) on an in-memory
// database: the two bugs were an earn written after a reverse (it could never
// be taken back) and two concurrent reverses both landing.

const redeem: OrderLedgerRow = { type: 'redeem', points: -50 };
const earn: OrderLedgerRow = { type: 'earn', points: 120 };
const reverse: OrderLedgerRow = { type: 'reverse', points: -70 };

describe('the per-order lifecycle', () => {
  it('reads the state from the rows', () => {
    expect(orderLoyaltyState([])).toBe('none');
    expect(orderLoyaltyState([redeem])).toBe('redeemed');
    expect(orderLoyaltyState([redeem, earn])).toBe('earned');
    expect(orderLoyaltyState([earn])).toBe('earned');
    expect(orderLoyaltyState([redeem, earn, reverse])).toBe('reversed');
    expect(orderLoyaltyState([{ type: 'adjust', points: 10 }])).toBe('none');
  });

  it('allows exactly the table', () => {
    const fixtures: Record<string, OrderLedgerRow[]> = {
      none: [],
      redeemed: [redeem],
      earned: [earn],
      reversed: [redeem, reverse],
    };
    const ops: OrderLedgerOp[] = ['redeem', 'earn', 'reverse'];
    for (const state of ORDER_LOYALTY_STATES) {
      for (const op of ops) {
        const legal = ORDER_LEDGER_TRANSITIONS.find((t) => t.op === op && t.from === state);
        expect(canOrderLedgerOp(op, fixtures[state]).ok, `${op} from ${state}`).toBe(Boolean(legal));
      }
    }
  });

  it('never earns after a reverse (the order refunded, then completed)', () => {
    expect(canOrderLedgerOp('earn', [redeem, reverse])).toMatchObject({ ok: false, code: 'reversed' });
  });

  it('says why a repeat writes nothing', () => {
    expect(canOrderLedgerOp('earn', [earn])).toMatchObject({ ok: false, code: 'already' });
    expect(canOrderLedgerOp('reverse', [earn, reverse])).toMatchObject({ ok: false, code: 'already' });
    expect(canOrderLedgerOp('reverse', [])).toMatchObject({ ok: false, code: 'nothing' });
    expect(canOrderLedgerOp('redeem', [earn])).toMatchObject({ ok: false, code: 'late' });
  });

  it('reverses the net of what was earned and spent', () => {
    expect(pointsToReverse([redeem, earn])).toBe(70);
    expect(pointsToReverse([redeem, earn, { type: 'adjust', points: 999 }])).toBe(70);
  });

  it('picks the same standing row for every caller', () => {
    const rows = [
      { id: 'b', created_at: '2026-11-12T10:00:01Z' },
      { id: 'a', created_at: '2026-11-12T10:00:01Z' },
      { id: 'c', created_at: '2026-11-12T10:00:02Z' },
    ];
    expect(standingRow(rows)?.id).toBe('a');
    expect(standingRow([...rows].reverse())?.id).toBe('a');
    expect(standingRow([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The writers
// ---------------------------------------------------------------------------

const ORDER = 'order-1';
const state: {
  tables: Record<string, Row[]>;
  fake: ReturnType<typeof makeFakeAdmin>;
  uniqueIndex: boolean;
  inserts: number;
} = { tables: {}, fake: makeFakeAdmin({}, { startMs: 0 }), uniqueIndex: false, inserts: 0 };

const admin = {
  from(table: string) {
    if (table === 'loyalty_accounts') return { upsert: () => Promise.resolve({ error: null }) };
    const chain = state.fake.from(table);
    if (table !== 'loyalty_transactions') return chain;
    return {
      ...chain,
      insert(row: Row) {
        state.inserts++;
        // The migration's unique index: one row of each type per order.
        if (state.uniqueIndex && state.tables.loyalty_transactions.some((r) => r.order_id === row.order_id && r.type === row.type)) {
          return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
        }
        return chain.insert(row);
      },
    };
  },
};

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => admin }));

const { earnForOrder, redeemForOrder, reverseForOrder } = await import('@/lib/loyalty/ledger');

const ledger = () => state.tables.loyalty_transactions.filter((r) => r.order_id === ORDER);
const ofType = (type: string) => ledger().filter((r) => r.type === type);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.tables = {
    orders: [
      {
        id: ORDER,
        user_id: 'cust-1',
        customer_user_id: null,
        status: 'completed',
        payment_status: 'paid',
        total_inr: 1200,
        subtotal_inr: 1200,
        order_number: 42,
        offer_name: null,
        offer_discount_inr: 0,
      },
    ],
    loyalty_config: [{ is_singleton: true, points_per_inr: 0.1, inr_per_point: 1, min_redeem_points: 20, max_redeem_pct: 50, points_expiry_days: 0 }],
    loyalty_transactions: [],
  };
  state.fake = makeFakeAdmin(state.tables, { startMs: Date.parse('2026-11-12T10:00:00Z') });
  state.uniqueIndex = false;
  state.inserts = 0;
});

describe('earnForOrder', () => {
  it('earns once', async () => {
    await earnForOrder(ORDER);
    await earnForOrder(ORDER);
    expect(ofType('earn')).toHaveLength(1);
    expect(ofType('earn')[0]).toMatchObject({ user_id: 'cust-1', points: 120 });
  });

  it('does not earn on an order whose Beanies were reversed', async () => {
    // Redeemed at checkout, fully refunded while open (reversed), then comped and completed.
    state.tables.loyalty_transactions.push(
      { id: 't1', user_id: 'cust-1', order_id: ORDER, type: 'redeem', points: -50, created_at: '2026-11-12T09:00:00Z' },
      { id: 't2', user_id: 'cust-1', order_id: ORDER, type: 'reverse', points: 50, created_at: '2026-11-12T09:10:00Z' },
    );
    await earnForOrder(ORDER);
    expect(ofType('earn')).toHaveLength(0);
  });

  it('two concurrent earns leave one row', async () => {
    await Promise.all([earnForOrder(ORDER), earnForOrder(ORDER)]);
    expect(ofType('earn')).toHaveLength(1);
  });
});

describe('reverseForOrder', () => {
  beforeEach(() => {
    state.tables.loyalty_transactions.push(
      { id: 't1', user_id: 'cust-1', order_id: ORDER, type: 'redeem', points: -50, created_at: '2026-11-12T09:00:00Z' },
      { id: 't2', user_id: 'cust-1', order_id: ORDER, type: 'earn', points: 120, created_at: '2026-11-12T09:30:00Z' },
    );
  });

  it('reverses the net once', async () => {
    await reverseForOrder(ORDER);
    await reverseForOrder(ORDER);
    expect(ofType('reverse')).toHaveLength(1);
    expect(ofType('reverse')[0].points).toBe(-70);
  });

  it('a refund and a cancel at the same moment reverse once (no index: the later row removes itself)', async () => {
    await Promise.all([reverseForOrder(ORDER), reverseForOrder(ORDER)]);
    expect(state.inserts).toBe(2); // both passed the "not reversed yet" read
    expect(ofType('reverse')).toHaveLength(1);
  });

  it('with the unique index, the second insert is "already reversed", not an error', async () => {
    state.uniqueIndex = true;
    await Promise.all([reverseForOrder(ORDER), reverseForOrder(ORDER)]);
    expect(ofType('reverse')).toHaveLength(1);
  });

  it('writes nothing for an order that neither earned nor spent', async () => {
    state.tables.loyalty_transactions.length = 0;
    await reverseForOrder(ORDER);
    expect(ledger()).toHaveLength(0);
  });
});

describe('redeemForOrder', () => {
  it('redeems once, and never on an order that already earned', async () => {
    await redeemForOrder(ORDER, 40, 40);
    await redeemForOrder(ORDER, 40, 40);
    expect(ofType('redeem')).toHaveLength(1);

    state.tables.loyalty_transactions.length = 0;
    state.tables.loyalty_transactions.push({ id: 'e', user_id: 'cust-1', order_id: ORDER, type: 'earn', points: 120, created_at: '2026-11-12T09:00:00Z' });
    await redeemForOrder(ORDER, 40, 40);
    expect(ofType('redeem')).toHaveLength(0);
  });
});
