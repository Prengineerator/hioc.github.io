// One order's Beanies, as a state machine (FND-4). Pure: no server-only
// import, so a screen can ask the same question the ledger does.
//
// An order touches the ledger at most three times, each once:
//
//   none ──redeem (at checkout)──▶ redeemed ──earn (completed + paid)──▶ earned
//     └──────────────earn (completed + paid)────────────────────────────▶ earned
//   redeemed / earned ──reverse (cancelled, rejected, fully refunded)──▶ reversed
//
// 'reversed' is the end: the reverse row nets out everything the order earned
// and spent, so a later earn on the same order (completed after a full refund,
// say) would hand out Beanies that nothing can ever take back. The state is
// never stored: it is read from the order's own ledger rows (loyalty_
// transactions with that order_id), so it cannot drift from them.
//
// 'adjust' and 'expire' rows are about the customer, not the order, and play
// no part here.

/** The ledger row types that belong to an order's lifecycle. */
export const ORDER_LEDGER_TYPES = ['redeem', 'earn', 'reverse'] as const;
export type OrderLedgerType = (typeof ORDER_LEDGER_TYPES)[number];

export const ORDER_LOYALTY_STATES = ['none', 'redeemed', 'earned', 'reversed'] as const;
export type OrderLoyaltyState = (typeof ORDER_LOYALTY_STATES)[number];

export const ORDER_LOYALTY_TERMINAL: readonly OrderLoyaltyState[] = ['reversed'];

/** A ledger operation on an order: the row type it writes. */
export type OrderLedgerOp = OrderLedgerType;

export interface OrderLedgerTransition {
  op: OrderLedgerOp;
  from: OrderLoyaltyState;
  to: OrderLoyaltyState;
}

/** Every move that writes a row. Anything else writes nothing. */
export const ORDER_LEDGER_TRANSITIONS: readonly OrderLedgerTransition[] = [
  { op: 'redeem', from: 'none', to: 'redeemed' },
  { op: 'earn', from: 'none', to: 'earned' },
  { op: 'earn', from: 'redeemed', to: 'earned' },
  { op: 'reverse', from: 'redeemed', to: 'reversed' },
  { op: 'reverse', from: 'earned', to: 'reversed' },
];

/** A row as the ledger reads it back for one order. */
export interface OrderLedgerRow {
  type: string;
  points: number;
}

/** Where the order stands, from its rows: the furthest step it has a row for. */
export function orderLoyaltyState(rows: readonly OrderLedgerRow[]): OrderLoyaltyState {
  const has = (type: OrderLedgerType) => rows.some((r) => r.type === type);
  if (has('reverse')) return 'reversed';
  if (has('earn')) return 'earned';
  if (has('redeem')) return 'redeemed';
  return 'none';
}

export type OrderLedgerCheck =
  | { ok: true; from: OrderLoyaltyState; to: OrderLoyaltyState }
  | {
      ok: false;
      from: OrderLoyaltyState;
      /**
       * already   this op's row exists: the call is a repeat, and writing again would double it
       * reversed  the order's Beanies were reversed: nothing more is earned or spent on it
       * nothing   reverse on an order that never earned or spent: there is nothing to take back
       * late      redeem after the order earned: a redemption happens at checkout only
       */
      code: 'already' | 'reversed' | 'nothing' | 'late';
      message: string;
    };

/** Whether `op` may write its row for an order whose rows are `rows`. */
export function canOrderLedgerOp(op: OrderLedgerOp, rows: readonly OrderLedgerRow[]): OrderLedgerCheck {
  const from = orderLoyaltyState(rows);
  const move = ORDER_LEDGER_TRANSITIONS.find((t) => t.op === op && t.from === from);
  if (move) return { ok: true, from, to: move.to };
  if (rows.some((r) => r.type === op)) {
    return { ok: false, from, code: 'already', message: `This order already has its ${op} row.` };
  }
  if (from === 'reversed') {
    return { ok: false, from, code: 'reversed', message: `This order's Beanies were reversed; it cannot ${op} again.` };
  }
  if (op === 'reverse') return { ok: false, from, code: 'nothing', message: 'This order neither earned nor spent Beanies.' };
  return { ok: false, from, code: 'late', message: 'Beanies are redeemed at checkout, before the order earns.' };
}

/** What a reverse row takes back: everything the order earned and spent, net. */
export function pointsToReverse(rows: readonly OrderLedgerRow[]): number {
  return rows.filter((r) => r.type === 'earn' || r.type === 'redeem').reduce((sum, r) => sum + r.points, 0);
}

/**
 * Of several rows of one op on one order (two requests both passed the "not
 * yet" check), the one that stands: the earliest, ties broken by id. Every
 * caller sees the same answer, so each later one removes its own row.
 */
export function standingRow<T extends { id: string; created_at?: string | null }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!best) {
      best = r;
      continue;
    }
    const a = r.created_at ?? '';
    const b = best.created_at ?? '';
    if (a < b || (a === b && r.id < best.id)) best = r;
  }
  return best;
}
