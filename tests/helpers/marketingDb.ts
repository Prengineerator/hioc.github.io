// An in-memory stand-in for the Supabase admin client, rich enough to run the REAL
// marketing engine (repo / consent / audience / planner / sender / attribution /
// campaigns) end to end without a network. Unlike tests/helpers/fakeAdmin.ts (select /
// insert / update only) it also supports upsert, delete, range paging, count, `not`, json
// paths (`projection->>learned_at`), one-level `!inner` embeds (order_items → orders),
// unique constraints (23505), missing tables (42P01) / columns (42703, PGRST204) and rpc
// (claim_marketing_recipients, marketing_add_observed). Deleting a campaign cascades to its
// recipients, as the foreign key does. failNext / beforeNext inject a failure, or another
// writer's change, at an exact operation.
//
// It is NOT a query planner: it implements exactly the operators the engine uses, and it
// throws on an operator it does not know, so a new query shows up as a loud test failure
// rather than a silently-ignored filter.

export type Row = Record<string, unknown>;

interface PgError {
  code: string;
  message: string;
}

type Filter = (row: Row) => boolean;

export interface FakeDbOptions {
  tables?: Record<string, Row[]>;
  /** Tables that "do not exist": every operation answers 42P01. */
  missing?: string[];
  /** Columns that "do not exist" per table: a select/filter naming one answers 42703, a write PGRST204. */
  missingColumns?: Record<string, string[]>;
  /** Unique constraints, as column lists per table. A violation answers 23505. */
  unique?: Record<string, string[][]>;
  /** Virtual clock, ms since epoch. Inserts stamp created_at from it. */
  startMs?: number;
}

export interface FakeDb {
  client: { from(table: string): unknown; rpc(name: string, args?: Row): Promise<{ data: unknown; error: PgError | null }> };
  tables: Record<string, Row[]>;
  /** Every write, in order: "insert marketing_recipients" etc. */
  log: string[];
  /** Move the virtual clock. */
  advance(ms: number): void;
  now(): number;
  /** Mark a table missing / present at runtime. */
  setMissing(table: string, missing: boolean): void;
  /** Inject an error for the NEXT matching operation, e.g. failNext('update marketing_recipients'); `skip` lets that many matching operations through first. */
  failNext(op: string, error?: PgError, skip?: number): void;
  /**
   * Run `fn` immediately BEFORE the next matching operation executes ('update marketing_playbooks',
   * 'rpc marketing_add_observed', …), once. It is how a test says "another run's write lands right
   * here": between a read-modify-write's read and its write, or just ahead of an atomic increment.
   */
  beforeNext(op: string, fn: () => void): void;
}

const PATH_SPLIT = /->>?/;

/** Reads `col`, `json->>key`, or an embedded `related.col` from a row. */
function readPath(row: Row, path: string): unknown {
  if (path.includes('->')) {
    const [col, key] = path.split(PATH_SPLIT);
    const v = row[col];
    return v && typeof v === 'object' ? (v as Row)[key] : undefined;
  }
  if (path.includes('.')) {
    const [rel, col] = path.split('.');
    const v = row[rel];
    return v && typeof v === 'object' ? (v as Row)[col] : undefined;
  }
  return row[path];
}

const isNil = (v: unknown) => v === null || v === undefined;

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** '("a","b")' or '(a,b)' → ['a','b']. */
function parseInList(raw: string): string[] {
  return raw
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s !== '');
}

export function makeMarketingDb(opts: FakeDbOptions = {}): FakeDb {
  const tables: Record<string, Row[]> = { ...(opts.tables ?? {}) };
  const missing = new Set(opts.missing ?? []);
  const log: string[] = [];
  const failures: { op: string; error: PgError; skip: number }[] = [];
  const hooks: { op: string; fn: () => void }[] = [];
  /** Fires (and removes) the first hook registered for `op`. */
  const runHook = (op: string) => {
    const i = hooks.findIndex((h) => h.op === op);
    if (i >= 0) hooks.splice(i, 1)[0].fn();
  };
  let clockMs = opts.startMs ?? Date.parse('2026-10-05T06:00:00.000Z');
  let idCounter = 0;

  const store = (table: string) => tables[table] ?? (tables[table] = []);
  const missingColumn = (table: string, cols: string[]): string | null => {
    const gone = opts.missingColumns?.[table] ?? [];
    return cols.find((c) => gone.includes(c.split(/->|\./)[0])) ?? null;
  };

  /** Would `row` (not yet stored, or a patched copy of `except`) clash with another stored row? */
  function violatesUniqueExcept(table: string, row: Row, except?: Row): boolean {
    for (const cols of opts.unique?.[table] ?? []) {
      // A NULL in a unique column never conflicts (Postgres semantics).
      if (cols.some((c) => isNil(row[c]))) continue;
      const clash = store(table).some((r) => r !== except && cols.every((c) => r[c] === row[c]));
      if (clash) return true;
    }
    return false;
  }
  const violatesUnique = (table: string, row: Row) => violatesUniqueExcept(table, row);

  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let returning = false;
    let payload: Row[] = [];
    let patch: Row = {};
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let countMode: 'exact' | null = null;
    let head = false;
    let selectCols = '*';
    const filters: Filter[] = [];
    const filterCols: string[] = [];
    const orders: { col: string; asc: boolean }[] = [];
    let limitN: number | null = null;
    let rangeFrom = 0;
    let rangeTo: number | null = null;
    let single: 'single' | 'maybe' | null = null;

    const addFilter = (col: string, fn: Filter) => {
      filterCols.push(col);
      filters.push(fn);
    };

    /** Rows with their `!inner` embed attached (only order_items → orders is needed). */
    const view = (): Row[] => {
      const embed = /(\w+)!inner\(/.exec(selectCols);
      let rows = store(table);
      if (embed) {
        const rel = embed[1];
        const fk = `${rel.replace(/s$/, '')}_id`;
        rows = rows
          .map((r) => {
            const parent = store(rel).find((p) => p.id === r[fk]);
            if (!parent) return null;
            const joined: Row = { ...r, [rel]: parent };
            // Remember the stored row, so an update/delete through the join hits the real one.
            Object.defineProperty(joined, '__orig', { value: r, enumerable: false });
            return joined;
          })
          .filter((r): r is Row => r !== null);
      }
      return rows;
    };

    const failureFor = (): PgError | null => {
      const key = `${op} ${table}`;
      const i = failures.findIndex((f) => f.op === key);
      if (i >= 0) {
        if (failures[i].skip > 0) {
          failures[i].skip -= 1;
        } else {
          return failures.splice(i, 1)[0].error;
        }
      }
      if (missing.has(table)) return { code: '42P01', message: `relation "public.${table}" does not exist` };
      return null;
    };

    function exec(): { data: unknown; error: PgError | null; count?: number | null } {
      runHook(`${op} ${table}`);
      const injected = failureFor();
      if (injected) return { data: null, error: injected };

      if (op === 'select' || returning || op === 'update' || op === 'delete') {
        const bad = missingColumn(table, filterCols);
        if (bad) return { data: null, error: { code: '42703', message: `column ${table}.${bad} does not exist` } };
      }

      if (op === 'select') {
        let rows = view().filter((r) => filters.every((f) => f(r)));
        for (const o of [...orders].reverse()) {
          rows = [...rows].sort((a, b) => (o.asc ? 1 : -1) * compare(readPath(a, o.col), readPath(b, o.col)));
        }
        const total = rows.length;
        if (rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
        if (limitN !== null) rows = rows.slice(0, limitN);
        if (head) return { data: null, error: null, count: total };
        const out = rows.map((r) => ({ ...r }));
        if (single === 'single') {
          return out.length === 1
            ? { data: out[0], error: null, count: countMode ? total : null }
            : { data: null, error: { code: 'PGRST116', message: 'expected one row' } };
        }
        if (single === 'maybe') return { data: out[0] ?? null, error: null };
        return { data: out, error: null, count: countMode ? total : null };
      }

      if (op === 'insert' || op === 'upsert') {
        const bad = payload.flatMap((r) => Object.keys(r)).find((c) => missingColumn(table, [c]));
        if (bad) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${table}' in the schema cache` } };
        const created: Row[] = [];
        for (const raw of payload) {
          clockMs += 1;
          let target: Row | undefined;
          if (op === 'upsert') {
            const conflictCols = (upsertOpts.onConflict ?? 'id').split(',').map((c) => c.trim());
            target = store(table).find((r) => conflictCols.every((c) => r[c] === raw[c]));
          }
          if (target) {
            if (!upsertOpts.ignoreDuplicates) Object.assign(target, raw);
            created.push(target);
            continue;
          }
          const row: Row = { id: `${table}-${++idCounter}`, created_at: new Date(clockMs).toISOString(), ...raw };
          if (violatesUnique(table, row)) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } };
          }
          store(table).push(row);
          created.push(row);
        }
        if (!returning) return { data: null, error: null };
        const out = created.map((r) => ({ ...r }));
        return single ? { data: out[0] ?? null, error: null } : { data: out, error: null };
      }

      if (op === 'update') {
        const bad = Object.keys(patch).find((c) => missingColumn(table, [c]));
        if (bad) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${table}' in the schema cache` } };
        const matched = view().filter((r) => filters.every((f) => f(r)));
        // Apply to the STORED row (view() clones it for an embed).
        const targets = matched.map((m) => ((m as { __orig?: Row }).__orig ?? m) as Row);
        for (const t of targets) {
          const next = { ...t, ...patch };
          if (violatesUniqueExcept(table, next, t)) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } };
          }
        }
        for (const t of targets) Object.assign(t, patch);
        if (!returning) return { data: null, error: null };
        const out = targets.map((r) => ({ ...r }));
        return single ? { data: out[0] ?? null, error: null } : { data: out, error: null };
      }

      // delete
      const doomed = new Set(view().filter((r) => filters.every((f) => f(r))).map((r) => (r as { __orig?: Row }).__orig ?? r));
      const before = store(table).length;
      tables[table] = store(table).filter((r) => !doomed.has(r));
      const removed = before - tables[table].length;
      // marketing_recipients.campaign_id is `on delete cascade`: a campaign takes its recipients with it.
      if (table === 'marketing_campaigns' && removed > 0) {
        const gone = new Set([...doomed].map((c) => c.id));
        tables.marketing_recipients = store('marketing_recipients').filter((r) => !gone.has(r.campaign_id));
      }
      return { data: returning ? [] : null, error: null, count: removed };
    }

    const chain: Record<string, unknown> = {};
    const settle = () => {
      const label = op === 'select' ? null : `${op} ${table}`;
      const res = exec();
      if (label && !res.error) log.push(label);
      return res;
    };
    Object.assign(chain, {
      select: (cols = '*', o?: { count?: 'exact'; head?: boolean }) => {
        selectCols = cols;
        if (op !== 'select') returning = true;
        if (o?.count) countMode = 'exact';
        if (o?.head) head = true;
        return chain;
      },
      insert: (rows: Row | Row[]) => {
        op = 'insert';
        payload = Array.isArray(rows) ? rows : [rows];
        return chain;
      },
      upsert: (rows: Row | Row[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) => {
        op = 'upsert';
        payload = Array.isArray(rows) ? rows : [rows];
        upsertOpts = o;
        return chain;
      },
      update: (p: Row) => {
        op = 'update';
        patch = p;
        return chain;
      },
      delete: () => {
        op = 'delete';
        return chain;
      },
      eq: (c: string, v: unknown) => (addFilter(c, (r) => readPath(r, c) === v), chain),
      neq: (c: string, v: unknown) => (addFilter(c, (r) => readPath(r, c) !== v), chain),
      gt: (c: string, v: unknown) => (addFilter(c, (r) => !isNil(readPath(r, c)) && compare(readPath(r, c), v) > 0), chain),
      gte: (c: string, v: unknown) => (addFilter(c, (r) => !isNil(readPath(r, c)) && compare(readPath(r, c), v) >= 0), chain),
      lt: (c: string, v: unknown) => (addFilter(c, (r) => !isNil(readPath(r, c)) && compare(readPath(r, c), v) < 0), chain),
      lte: (c: string, v: unknown) => (addFilter(c, (r) => !isNil(readPath(r, c)) && compare(readPath(r, c), v) <= 0), chain),
      // Case-insensitive match; '%' and '_' are the SQL wildcards, everything else is literal.
      ilike: (c: string, pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
        addFilter(c, (r) => typeof readPath(r, c) === 'string' && re.test(readPath(r, c) as string));
        return chain;
      },
      is: (c: string, v: null | boolean) => (addFilter(c, (r) => (v === null ? isNil(readPath(r, c)) : readPath(r, c) === v)), chain),
      in: (c: string, vals: unknown[]) => (addFilter(c, (r) => vals.includes(readPath(r, c))), chain),
      not: (c: string, operator: string, v: unknown) => {
        if (operator === 'is') addFilter(c, (r) => (v === null ? !isNil(readPath(r, c)) : readPath(r, c) !== v));
        else if (operator === 'in') {
          const list = parseInList(String(v));
          addFilter(c, (r) => !list.includes(String(readPath(r, c))));
        } else throw new Error(`fake db: .not(${c}, ${operator}) is not supported`);
        return chain;
      },
      order: (c: string, o: { ascending?: boolean } = {}) => (orders.push({ col: c, asc: o.ascending !== false }), chain),
      limit: (n: number) => ((limitN = n), chain),
      range: (a: number, b: number) => ((rangeFrom = a), (rangeTo = b), chain),
      single: () => ((single = 'single'), chain),
      maybeSingle: () => ((single = 'maybe'), chain),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(settle()).then(resolve, reject),
    });
    return chain;
  }

  const db: FakeDb = {
    tables,
    log,
    advance: (ms) => {
      clockMs += ms;
    },
    now: () => clockMs,
    setMissing: (table, gone) => {
      if (gone) missing.add(table);
      else missing.delete(table);
    },
    failNext: (op, error = { code: 'XX000', message: 'injected failure' }, skip = 0) => {
      failures.push({ op, error, skip });
    },
    beforeNext: (op, fn) => {
      hooks.push({ op, fn });
    },
    client: {
      from,
      rpc: async (name: string, args: Row = {}) => {
        if (name === 'claim_marketing_recipients') {
          if (missing.has('marketing_recipients')) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
          return { data: claimMarketingRecipients(db, Number(args.p_limit) || 0), error: null };
        }
        if (name === 'marketing_add_observed') {
          runHook('rpc marketing_add_observed');
          if (missing.has('marketing_playbooks')) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
          if (missing.has('marketing_add_observed')) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
          marketingAddObserved(db, String(args.p_key), Number(args.p_treated) || 0, Number(args.p_conversions) || 0);
          log.push('rpc marketing_add_observed');
          return { data: null, error: null };
        }
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
      },
    },
  };
  return db;
}

/** The SQL function of the same name, in memory: `observed_x = observed_x + n` on ONE row, with no read in between. */
export function marketingAddObserved(db: FakeDb, key: string, treated: number, conversions: number): void {
  for (const row of db.tables.marketing_playbooks ?? []) {
    if (row.key !== key) continue;
    row.observed_treated = Number(row.observed_treated ?? 0) + treated;
    row.observed_conversions = Number(row.observed_conversions ?? 0) + conversions;
  }
}

/** The SQL function of the same name, in memory: oldest queued rows of approved/sending campaigns, by campaign priority. */
export function claimMarketingRecipients(db: FakeDb, limit: number): Row[] {
  const campaigns = new Map((db.tables.marketing_campaigns ?? []).map((c) => [c.id, c]));
  const nowIso = new Date(db.now()).toISOString();
  const eligible = (db.tables.marketing_recipients ?? [])
    .filter((r) => {
      const c = campaigns.get(r.campaign_id);
      if (r.status !== 'queued' || !c) return false;
      if (c.status !== 'approved' && c.status !== 'sending') return false;
      return isNil(c.send_after) || Date.parse(String(c.send_after)) <= db.now();
    })
    .sort((a, b) => {
      const pa = Number(campaigns.get(a.campaign_id)?.priority ?? 10);
      const pb = Number(campaigns.get(b.campaign_id)?.priority ?? 10);
      return pa - pb || compare(a.created_at, b.created_at) || compare(a.id, b.id);
    })
    .slice(0, Math.max(0, Math.min(limit, 200)));
  for (const r of eligible) {
    r.status = 'sending';
    r.claimed_at = nowIso;
    r.attempts = Number(r.attempts ?? 0) + 1;
  }
  return eligible.map((r) => ({ ...r }));
}
