// An in-memory stand-in for the Supabase admin client, for the menu routes
// (tests/menuChangeRequests.test.ts). Unlike tests/helpers/fakeAdmin.ts it also
// does delete and the embedded selects the menu code uses (menu_item_variants,
// menu_item_addon_groups -> addon_groups -> options), mimics the foreign keys
// that matter here (deleting an item removes its sizes and add-on links and sets
// menu_change_requests.menu_item_id to null) and can raise a unique violation or
// an injected error, so the real validate / write / rollback / claim code runs.

export type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'neq' | 'is' | 'in'; col: string; val: unknown };
type DbError = { code?: string; message: string };
type Op = 'select' | 'insert' | 'update' | 'delete';

export interface FakeMenuAdminOptions {
  /** Columns that must stay unique per table (a clash is Postgres 23505). */
  unique?: Record<string, string[]>;
  /** Return an error to make a statement fail. */
  fail?: (table: string, op: Op, payload: unknown) => DbError | null;
  /** Column defaults applied to an inserted row. */
  defaults?: (table: string, row: Row) => Row;
}

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col];
    switch (f.op) {
      case 'eq':
        return v === f.val;
      case 'neq':
        return v !== f.val;
      case 'is':
        return f.val === null ? v === null || v === undefined : v === f.val;
      case 'in':
        return Array.isArray(f.val) && f.val.includes(v);
    }
  });
}

export function makeFakeMenuAdmin(tables: Record<string, Row[]>, opts: FakeMenuAdminOptions = {}) {
  let idCounter = 1000;

  function embed(table: string, row: Row, columns: string): Row {
    // An add-on group read with its options (`*, options:addon_options(*)`).
    if (table === 'addon_groups' && columns.includes('addon_options')) {
      return { ...row, options: (tables.addon_options ?? []).filter((o) => o.addon_group_id === row.id).map((o) => ({ ...o })) };
    }
    if (table !== 'menu_items') return { ...row };
    const out: Row = { ...row };
    if (columns.includes('menu_item_variants')) {
      out.menu_item_variants = (tables.menu_item_variants ?? []).filter((v) => v.menu_item_id === row.id).map((v) => ({ ...v }));
    }
    if (columns.includes('menu_item_addon_groups')) {
      out.menu_item_addon_groups = (tables.menu_item_addon_groups ?? [])
        .filter((l) => l.menu_item_id === row.id)
        .map((l) => {
          const link: Row = { ...l };
          if (columns.includes('addon_groups(')) {
            const group = (tables.addon_groups ?? []).find((g) => g.id === l.addon_group_id);
            link.addon_groups = group
              ? { ...group, options: (tables.addon_options ?? []).filter((o) => o.addon_group_id === group.id) }
              : null;
          }
          return link;
        });
    }
    return out;
  }

  function clash(table: string, candidate: Row, ignore: Row | null): boolean {
    return (opts.unique?.[table] ?? []).some((col) =>
      candidate[col] != null &&
      (tables[table] ?? []).some((r) => r !== ignore && r[col] === candidate[col]),
    );
  }

  return {
    from(table: string) {
      const store = tables[table] ?? (tables[table] = []);
      const filters: Filter[] = [];
      let op: Op = 'select';
      let payload: Row | Row[] | null = null;
      let columns = '*';
      let order: { col: string; asc: boolean } | null = null;
      let limitN: number | null = null;

      function exec(single: boolean): { data: unknown; error: DbError | null } {
        const injected = opts.fail?.(table, op, payload);
        if (injected) return { data: null, error: injected };
        const pick = (rows: Row[]) => (single ? (rows[0] ?? null) : rows);

        if (op === 'insert') {
          const created: Row[] = [];
          for (const r of Array.isArray(payload) ? payload : [payload as Row]) {
            let row: Row = { id: uuid(++idCounter), ...r };
            if (opts.defaults) row = { ...opts.defaults(table, row), ...r, id: row.id };
            if (clash(table, row, null)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
            store.push(row);
            created.push({ ...row });
          }
          return { data: pick(created), error: null };
        }

        const matched = store.filter((r) => matches(r, filters));

        if (op === 'update') {
          for (const row of matched) {
            const next = { ...row, ...(payload as Row) };
            if (clash(table, next, row)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          }
          for (const row of matched) Object.assign(row, payload);
          return { data: pick(matched.map((r) => ({ ...r }))), error: null };
        }

        if (op === 'delete') {
          for (const row of matched) {
            store.splice(store.indexOf(row), 1);
            if (table === 'menu_items') {
              for (const child of ['menu_item_variants', 'menu_item_addon_groups']) {
                tables[child] = (tables[child] ?? []).filter((c) => c.menu_item_id !== row.id);
              }
              for (const req of tables.menu_change_requests ?? []) {
                if (req.menu_item_id === row.id) req.menu_item_id = null;
              }
            }
          }
          return { data: pick(matched.map((r) => ({ ...r }))), error: null };
        }

        let rows = matched;
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
        return { data: pick(rows.map((r) => embed(table, r, columns))), error: null };
      }

      const chain = {
        select: (cols?: string) => {
          columns = cols ?? '*';
          return chain;
        },
        insert: (p: Row | Row[]) => {
          op = 'insert';
          payload = p;
          return chain;
        },
        update: (p: Row) => {
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
        in: (col: string, val: unknown[]) => (filters.push({ op: 'in', col, val }), chain),
        order: (col: string, o?: { ascending?: boolean }) => {
          order = { col, asc: o?.ascending !== false };
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
