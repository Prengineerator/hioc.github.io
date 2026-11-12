// A stand-in for createAdminSupabaseClient() covering exactly the queries the
// notification engine (lib/notifications/engine.ts) makes against
// `notifications` — read one row by (order_id, event, channel), insert, a
// compare-and-set UPDATE (.eq / .in / .is filters, then .select), and upsert.
//
// It keeps the contract the engine tests were written against: every
// (order, event, channel) row STARTS as `state.existing` (the old mocks
// answered every read with it), and every write is recorded in
// `state.upserts` as the row it describes — key columns plus what was
// written — so `state.upserts.find((r) => r.channel === 'whatsapp' && …)`
// still reads naturally whether the engine inserted, updated or upserted.
//
// Unlike those mocks it is stateful within a test: a write changes what the
// next read of that key returns, and an UPDATE only lands when its filters
// match the stored row (so a compare-and-set that lost is visible as one). An
// INSERT over an existing key answers 23505, like the table's unique index.

export type Row = Record<string, unknown>;

export interface NotificationsLogState {
  existing: Row | null;
  upserts: Row[];
  /**
   * Runs immediately BEFORE the next write (insert/update/upsert) executes, with the row it
   * targets, then clears itself: how a test says "another caller's write lands right here".
   * Returning an error makes that write fail with it instead.
   */
  beforeNextWrite?: ((op: string, row: Row | null) => void | { code: string; message: string }) | null;
}

const KEY_COLS = ['order_id', 'event', 'channel'] as const;

// One store per test: keyed by the `upserts` array, which every beforeEach replaces.
const stores = new WeakMap<Row[], Map<string, Row | null>>();

function storeFor(state: NotificationsLogState): Map<string, Row | null> {
  let s = stores.get(state.upserts);
  if (!s) {
    s = new Map();
    stores.set(state.upserts, s);
  }
  return s;
}

const keyOf = (r: Row) => KEY_COLS.map((c) => String(r[c] ?? '')).join('|');

export function notificationsLogClient(state: NotificationsLogState) {
  const read = (key: string): Row | null => {
    const store = storeFor(state);
    if (!store.has(key)) store.set(key, state.existing ? { ...state.existing } : null);
    return store.get(key) ?? null;
  };
  const write = (key: string, row: Row | null) => storeFor(state).set(key, row);

  return {
    from: () => {
      let op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
      let payload: Row = {};
      const eqs: Row = {};
      const ins: Record<string, unknown[]> = {};

      const filterKey = () => keyOf(op === 'insert' || op === 'upsert' ? payload : eqs);

      function settle(): { data: unknown; error: { code: string; message: string } | null } {
        const key = filterKey();
        if (op === 'select') return { data: read(key), error: null };
        const hook = state.beforeNextWrite;
        if (hook) {
          state.beforeNextWrite = null;
          // A returned error is what this write answers (a DB fault, a foreign-key refusal).
          const injected = hook(op, read(key));
          if (injected) return { data: null, error: injected };
        }
        if (op === 'insert') {
          if (read(key)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          const row = { id: `n-${key}`, ...payload };
          write(key, row);
          state.upserts.push({ ...payload });
          return { data: { id: row.id }, error: null };
        }
        if (op === 'upsert') {
          write(key, { ...(read(key) ?? {}), ...payload });
          state.upserts.push({ ...payload });
          return { data: null, error: null };
        }
        // update
        const current = read(key);
        const matches =
          current !== null &&
          Object.entries(eqs).every(([c, v]) => (KEY_COLS as readonly string[]).includes(c) || (current[c] ?? null) === v) &&
          Object.entries(ins).every(([c, vs]) => vs.includes(current[c]));
        if (!matches) return { data: [], error: null };
        write(key, { ...current, ...payload });
        const keyCols = Object.fromEntries(KEY_COLS.map((c) => [c, eqs[c]]));
        state.upserts.push({ ...keyCols, ...payload });
        return { data: [{ id: current.id ?? `n-${key}` }], error: null };
      }

      const chain: Record<string, unknown> = {
        select: () => chain,
        insert: (row: Row) => ((op = 'insert'), (payload = row), chain),
        update: (patch: Row) => ((op = 'update'), (payload = patch), chain),
        upsert: (row: Row) => ((op = 'upsert'), (payload = row), chain),
        eq: (c: string, v: unknown) => ((eqs[c] = v), chain),
        is: (c: string, v: unknown) => ((eqs[c] = v), chain),
        in: (c: string, vs: unknown[]) => ((ins[c] = vs), chain),
        maybeSingle: () => chain,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(settle()).then(resolve, reject),
      };
      return chain;
    },
  };
}

/** The current stored row for a key (after the engine's writes). */
export function storedRow(state: NotificationsLogState, key: { order_id: string; event: string; channel: string }): Row | null {
  return storeFor(state).get(keyOf(key)) ?? null;
}

/** Writes a row straight into the store (another caller's write), keyed by its order_id/event/channel. */
export function putRow(state: NotificationsLogState, row: Row): void {
  storeFor(state).set(keyOf(row), { ...row });
}
