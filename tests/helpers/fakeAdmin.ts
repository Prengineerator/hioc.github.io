// A small in-memory fake of the Supabase admin query builder, for tests that
// drive the REAL filter chains in lib/cash/** and the cash-day routes (rather
// than a per-call stub). Supports select / insert / update with .eq .neq .is
// .gt .gte .lt .lte .in .order .limit .maybeSingle .single and awaiting the
// chain directly. Same shape as the fake in tests/cashCheckpoints.test.ts.

export type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.col];
      switch (f.op) {
        case 'eq':
          return v === f.val;
        case 'neq':
          return v !== f.val;
        case 'is':
          return f.val === null ? v === null || v === undefined : v === f.val;
        case 'gt':
          return (v as string | number) > (f.val as string | number);
        case 'gte':
          return (v as string | number) >= (f.val as string | number);
        case 'lt':
          return (v as string | number) < (f.val as string | number);
        case 'lte':
          return (v as string | number) <= (f.val as string | number);
        case 'in':
          return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
        default:
          return true;
      }
    }),
  );
}

export interface FakeAdminOptions {
  /** Virtual clock for created_at, ticking one second per insert. */
  startMs: number;
  /** Column defaults applied to an inserted row after created_at is stamped (e.g. cash_days.opened_at). */
  defaults?: (table: string, row: Row) => Row;
}

export function makeFakeAdmin(tables: Record<string, Row[]>, opts: FakeAdminOptions) {
  let clockMs = opts.startMs;
  let idCounter = 0;
  return {
    /** Move the virtual clock forward (e.g. to put a payment between two checkpoints). */
    advance(ms: number) {
      clockMs += ms;
    },
    /** The virtual clock's current instant, as an ISO string. */
    now() {
      return new Date(clockMs).toISOString();
    },
    from(table: string) {
      const store = tables[table] ?? (tables[table] = []);
      const filters: Filter[] = [];
      let order: { col: string; asc: boolean } | null = null;
      let limitN: number | null = null;
      let op: 'select' | 'insert' | 'update' = 'select';
      let insertPayload: Row | Row[] | null = null;
      let updatePayload: Row | null = null;

      function exec(single: boolean): { data: unknown; error: null } {
        if (op === 'insert') {
          const toInsert = Array.isArray(insertPayload) ? insertPayload : [insertPayload as Row];
          const created = toInsert.map((r) => {
            clockMs += 1000;
            let row: Row = {
              id: `${table}-${++idCounter}`,
              created_at: new Date(clockMs).toISOString(),
              ...r,
            };
            if (opts.defaults) row = { ...opts.defaults(table, row), ...r, id: row.id, created_at: row.created_at };
            store.push(row);
            return row;
          });
          return single ? { data: created[0] ?? null, error: null } : { data: created, error: null };
        }
        if (op === 'update') {
          const matched = applyFilters(store, filters);
          for (const row of matched) Object.assign(row, updatePayload);
          return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
        }
        let rows = applyFilters(store, filters);
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, b) => {
            const av = a[col] as string | number;
            const bv = b[col] as string | number;
            if (av < bv) return asc ? -1 : 1;
            if (av > bv) return asc ? 1 : -1;
            return 0;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      }

      const chain = {
        select: () => chain,
        insert: (p: Row | Row[]) => {
          op = 'insert';
          insertPayload = p;
          return chain;
        },
        update: (p: Row) => {
          op = 'update';
          updatePayload = p;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          filters.push({ op: 'eq', col: c, val: v });
          return chain;
        },
        neq: (c: string, v: unknown) => {
          filters.push({ op: 'neq', col: c, val: v });
          return chain;
        },
        is: (c: string, v: unknown) => {
          filters.push({ op: 'is', col: c, val: v });
          return chain;
        },
        gt: (c: string, v: unknown) => {
          filters.push({ op: 'gt', col: c, val: v });
          return chain;
        },
        gte: (c: string, v: unknown) => {
          filters.push({ op: 'gte', col: c, val: v });
          return chain;
        },
        lt: (c: string, v: unknown) => {
          filters.push({ op: 'lt', col: c, val: v });
          return chain;
        },
        lte: (c: string, v: unknown) => {
          filters.push({ op: 'lte', col: c, val: v });
          return chain;
        },
        in: (c: string, v: unknown[]) => {
          filters.push({ op: 'in', col: c, val: v });
          return chain;
        },
        order: (c: string, o?: { ascending?: boolean }) => {
          order = { col: c, asc: o?.ascending !== false };
          return chain;
        },
        limit: (n: number) => {
          limitN = n;
          return chain;
        },
        maybeSingle: () => Promise.resolve(exec(true)),
        single: () => Promise.resolve(exec(true)),
        then: (resolve: (v: unknown) => void) => resolve(exec(false)),
      };
      return chain;
    },
  };
}
