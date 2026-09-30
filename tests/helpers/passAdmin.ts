// An in-memory fake of the Supabase admin client for the HIOC Ritual route tests
// (tests/coffeePass*Routes.test.ts). It is a little more than tests/helpers/
// fakeAdmin.ts: the pass routes also delete, use `.or()` / `.not()` / `.range()`,
// embed related rows (`order_items(...)`, `orders(...)`), project columns (so a
// route that returned a raw row would leak columns in a test), and call rpc.
//
// It evaluates real filter chains against plain arrays, so the routes' queries are
// exercised rather than stubbed one by one. `calls` records every operation for
// the assertions that are about WHAT was written (e.g. the order row a sale made).

export type Row = Record<string, unknown>;
export type DbError = { code?: string; message: string } | null;

type Filter = { op: string; col: string; val: unknown };

export interface Call {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  payload?: unknown;
  filters: Filter[];
}

export interface FakeHooks {
  /** Fail an insert/update/delete/select on a table: return the error to answer with. */
  fail?: (call: Call) => DbError;
  rpc?: (name: string, args: Row) => { data: unknown; error: DbError };
  /** Column defaults for an inserted row (what the database would fill in, e.g. orders.order_number). */
  defaults?: (table: string, row: Row) => Row;
}

// Splits on commas that are not inside parentheses or double quotes.
function splitTop(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim());
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

function listOf(raw: string): string[] {
  return splitTop(raw.replace(/^\(/, '').replace(/\)$/, '')).map(unquote);
}

// One `.or()` clause: `col.eq.value` or `col.in.(a,b)`.
function orClauseMatches(row: Row, clause: string): boolean {
  const first = clause.indexOf('.');
  const second = clause.indexOf('.', first + 1);
  const col = clause.slice(0, first);
  const op = clause.slice(first + 1, second);
  const raw = clause.slice(second + 1);
  const v = row[col];
  if (op === 'eq') return String(v) === unquote(raw);
  if (op === 'in') return listOf(raw).includes(String(v));
  throw new Error(`passAdmin: unsupported .or() operator ${op}`);
}

function matches(row: Row, f: Filter): boolean {
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
    case 'not-in':
      return !listOf(String(f.val)).includes(String(v));
    case 'or':
      return splitTop(String(f.val)).some((c) => orClauseMatches(row, c));
    default:
      throw new Error(`passAdmin: unsupported filter ${f.op}`);
  }
}

export function makePassAdmin(tables: Record<string, Row[]>, hooks: FakeHooks = {}) {
  const calls: Call[] = [];
  const rpcCalls: { name: string; args: Row }[] = [];
  const seq: Record<string, number> = {};
  const store = (t: string) => tables[t] ?? (tables[t] = []);

  // The embeds the pass routes select: children of orders by order_id, the order of a redemption, and
  // the menu item's sizes and add-on groups (the drink a Ritual is bought for).
  function embed(table: string, row: Row, select: string): Row {
    const out: Row = { ...row };
    for (const token of splitTop(select)) {
      const m = /^(\w+)\(([\s\S]*)\)$/.exec(token);
      if (!m) continue;
      const [, name, inner] = m;
      if (name === 'order_items' || name === 'order_payments') {
        out[name] = store(name)
          .filter((r) => r.order_id === row.id)
          .map((r) => embed(name, r, inner));
      } else if (name === 'order_item_addons') {
        out[name] = store(name).filter((r) => r.order_item_id === row.id);
      } else if (name === 'menu_item_variants') {
        // The menu select the order pricing uses (lib/orders/lines.ts MENU_ITEM_SELECT).
        out[name] = store(name).filter((r) => r.menu_item_id === row.id);
      } else if (name === 'menu_item_addon_groups') {
        out[name] = store(name)
          .filter((r) => r.menu_item_id === row.id)
          .map((r) => embed(name, r, inner));
      } else if (name === 'addon_groups') {
        const group = store('addon_groups').find((r) => r.id === row.addon_group_id);
        out[name] = group ? { ...group, options: store('addon_options').filter((o) => o.addon_group_id === group.id) } : null;
      } else if (name === 'orders') {
        const parent = store('orders').find((r) => r.id === row.order_id);
        out[name] = parent ? project(parent, inner) : null;
      } else {
        throw new Error(`passAdmin: unsupported embed ${name} on ${table}`);
      }
    }
    return out;
  }

  function project(row: Row, select: string): Row {
    const tokens = splitTop(select);
    if (tokens.length === 0 || tokens.includes('*')) return { ...row };
    const out: Row = {};
    for (const t of tokens) if (!t.includes('(')) out[t] = row[t];
    return out;
  }

  function shape(table: string, row: Row, select: string): Row {
    const projected = project(row, select);
    const embedded = embed(table, row, select);
    for (const token of splitTop(select)) {
      const m = /^(\w+)\(/.exec(token);
      if (m) projected[m[1]] = embedded[m[1]];
    }
    return projected;
  }

  return {
    calls,
    rpcCalls,
    tables,
    rpc(name: string, args: Row) {
      rpcCalls.push({ name, args });
      return Promise.resolve(hooks.rpc ? hooks.rpc(name, args) : { data: null, error: null });
    },
    from(table: string) {
      const filters: Filter[] = [];
      let op: Call['op'] = 'select';
      let payload: unknown;
      let select = '*';
      let orderBy: { col: string; asc: boolean }[] = [];
      let limitN: number | null = null;
      let rangeN: [number, number] | null = null;

      function exec(single: boolean): { data: unknown; error: DbError } {
        const call: Call = { table, op, payload, filters: [...filters] };
        calls.push(call);
        const failure = hooks.fail?.(call) ?? null;
        if (failure) return { data: null, error: failure };

        if (op === 'insert') {
          const rows = (Array.isArray(payload) ? payload : [payload]) as Row[];
          const created = rows.map((r) => {
            const base: Row = { id: `${table}-${(seq[table] = (seq[table] ?? 0) + 1)}`, created_at: '2026-10-05T04:30:00.000Z', ...r };
            const row: Row = { ...(hooks.defaults ? hooks.defaults(table, base) : {}), ...base };
            store(table).push(row);
            return row;
          });
          const shaped = created.map((r) => shape(table, r, select));
          return { data: single ? (shaped[0] ?? null) : shaped, error: null };
        }
        let rows = store(table).filter((r) => filters.every((f) => matches(r, f)));
        if (op === 'update') {
          for (const r of rows) Object.assign(r, payload as Row);
          const shaped = rows.map((r) => shape(table, r, select));
          return { data: single ? (shaped[0] ?? null) : shaped, error: null };
        }
        if (op === 'delete') {
          tables[table] = store(table).filter((r) => !rows.includes(r));
          return { data: null, error: null };
        }
        for (const { col, asc } of [...orderBy].reverse()) {
          rows = [...rows].sort((a, b) => {
            const av = a[col] as string | number;
            const bv = b[col] as string | number;
            return av < bv ? (asc ? -1 : 1) : av > bv ? (asc ? 1 : -1) : 0;
          });
        }
        if (rangeN) rows = rows.slice(rangeN[0], rangeN[1] + 1);
        if (limitN != null) rows = rows.slice(0, limitN);
        const shaped = rows.map((r) => shape(table, r, select));
        return { data: single ? (shaped[0] ?? null) : shaped, error: null };
      }

      const chain = {
        select: (columns?: string) => {
          select = columns ?? '*';
          return chain;
        },
        insert: (p: unknown) => {
          op = 'insert';
          payload = p;
          return chain;
        },
        update: (p: unknown) => {
          op = 'update';
          payload = p;
          return chain;
        },
        delete: () => {
          op = 'delete';
          return chain;
        },
        eq: (col: string, val: unknown) => (filters.push({ op: 'eq', col, val }), chain),
        neq: (col: string, val: unknown) => (filters.push({ op: 'neq', col, val }), chain),
        is: (col: string, val: unknown) => (filters.push({ op: 'is', col, val }), chain),
        gt: (col: string, val: unknown) => (filters.push({ op: 'gt', col, val }), chain),
        gte: (col: string, val: unknown) => (filters.push({ op: 'gte', col, val }), chain),
        lt: (col: string, val: unknown) => (filters.push({ op: 'lt', col, val }), chain),
        lte: (col: string, val: unknown) => (filters.push({ op: 'lte', col, val }), chain),
        in: (col: string, val: unknown[]) => (filters.push({ op: 'in', col, val }), chain),
        not: (col: string, operator: string, val: unknown) => {
          if (operator !== 'in') throw new Error(`passAdmin: unsupported .not() operator ${operator}`);
          filters.push({ op: 'not-in', col, val });
          return chain;
        },
        or: (expr: string) => (filters.push({ op: 'or', col: '', val: expr }), chain),
        order: (col: string, o?: { ascending?: boolean }) => (orderBy.push({ col, asc: o?.ascending !== false }), chain),
        limit: (n: number) => ((limitN = n), chain),
        range: (a: number, b: number) => ((rangeN = [a, b]), chain),
        maybeSingle: () => Promise.resolve(exec(true)),
        single: () => Promise.resolve(exec(true)),
        then: (resolve: (v: unknown) => void) => resolve(exec(false)),
      };
      return chain;
    },
  };
}
