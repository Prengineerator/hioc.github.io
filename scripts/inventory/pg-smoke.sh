#!/usr/bin/env bash
# ===========================================================================
# pg-smoke — run the inventory SQL against a REAL, throwaway Postgres.
#
# The vitest suite mocks Supabase, so it cannot see a constraint, an index, a
# grant or a plpgsql function (see scripts/verify-db.mjs for the same blind
# spot on the live database). verify-db probes production; this script proves
# the migrations and the recipe-book seed BEFORE anything reaches production,
# with no network and no Supabase project: it starts a private Postgres on a
# random localhost port, builds a Supabase-like baseline, applies the repo's
# migrations, loads the live menu and runs assertions. It never connects to
# anything but that private server (every PG* variable is cleared first).
#
# What it does
#   1. Starts a private cluster (data dir under ${TMPDIR:-/tmp}/hioc-pg-smoke,
#      random free port, trust auth on 127.0.0.1). initdb refuses root, so as
#      root the server runs as the OS user `postgres`, or a throwaway
#      `pgsmoke` user made for the run (PG_SMOKE_OS_USER overrides).
#   2. Supabase-like baseline: roles anon / authenticated / service_role, a
#      stub auth schema (auth.users(id), auth.uid()), and Supabase's DEFAULT
#      PRIVILEGES (new tables and functions are granted to those roles), so the
#      migrations' REVOKEs are really tested rather than passing vacuously.
#   3. Applies supabase/schema.sql, phase1/2/3 migrations, security-rls-fix and
#      the dated migrations in name order, WITHOUT stopping on errors: pg_cron,
#      pg_net and Supabase's real auth.users columns are not here, so a few
#      files fail in part. Their errors are logged to a file and summarised.
#      Then supabase/2026-10-inventory.sql and
#      supabase/2026-10-inventory-addon-scopes.sql are applied with
#      ON_ERROR_STOP=1, each TWICE (a fresh apply and a re-run): those must
#      apply cleanly. (Not in the tolerant pass, so nothing can be half-applied
#      there and hidden.) Never re-run 2026-10-inventory.sql after the scopes
#      file: it would put back the old inventory_set_addon_recipe.
#   4. Loads the live menu from data/inventory/menu-snapshot.json (item and
#      add-on option ids exactly; groups by name with generated ids).
#   5. Runs SQL assertions for the add-on scope migration (inside one
#      transaction that is rolled back, so they leave nothing behind).
#   6. With --seed <file.sql>: applies that seed twice with ON_ERROR_STOP=1
#      and prints what it loaded. The harness assumes nothing about the seed's
#      content, only that re-applying it changes no row counts.
#   7. Prints a PASS/FAIL summary and exits non-zero on any failure. It always
#      stops the server and deletes the data dir on exit.
#
# Usage:  bash scripts/inventory/pg-smoke.sh [--seed <file.sql>] [--keep]
#   --seed FILE   also apply a generated recipe-book seed (data/inventory/book/seed.sql)
#   --keep        leave the server running and the data dir in place, print how to connect
# Env:    PG_BIN (dir with initdb, pg_ctl, psql; default the newest in /usr/lib/postgresql),
#         PG_SMOKE_OS_USER (OS user for the server when run as root)
#
# Dev-only: not part of the app, the build or CI. Needs Postgres 13+ server
# binaries (the inventory functions use trim_scale), node, and bash 4+.
# ===========================================================================

set -uo pipefail

usage() { sed -n '/^# Usage:/,/^# Dev-only/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

SEED_FILE=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) [ $# -ge 2 ] || { echo "pg-smoke: --seed needs a file" >&2; exit 2; }; SEED_FILE="$2"; shift 2 ;;
    --seed=*) SEED_FILE="${1#--seed=}"; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "pg-smoke: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 2
if [ -n "$SEED_FILE" ]; then
  [ -f "$SEED_FILE" ] || { echo "pg-smoke: seed file not found: $SEED_FILE" >&2; exit 2; }
  SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"
fi
SNAPSHOT="$REPO/data/inventory/menu-snapshot.json"
[ -f "$SNAPSHOT" ] || { echo "pg-smoke: $SNAPSHOT is missing (npm run inventory:snapshot)" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "pg-smoke: node is needed to load the menu snapshot" >&2; exit 2; }

# Never let an ambient connection setting point psql anywhere but our own server.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE PGPASSWORD PGSSLMODE PGCONNECT_TIMEOUT PGOPTIONS DATABASE_URL
export PGOPTIONS='-c client_min_messages=warning'

# ── Reporting ────────────────────────────────────────────────────────────────
PASS_N=0
FAIL_N=0
FAILS=()
T0=$SECONDS
step() { printf '\n[%s] %s\n' "$1" "$2"; }
ok()   { PASS_N=$((PASS_N + 1)); printf '  PASS  %s\n' "$1"; }
bad() {
  FAIL_N=$((FAIL_N + 1)); FAILS+=("$1")
  printf '  FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/          /' | head -40; fi
}
info() { printf '        %s\n' "$*"; }

# ── Postgres binaries ────────────────────────────────────────────────────────
PGBIN="${PG_BIN:-}"
if [ -z "$PGBIN" ]; then
  for d in /usr/lib/postgresql/16/bin $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -rV) "$(pg_config --bindir 2>/dev/null || true)"; do
    if [ -n "$d" ] && [ -x "$d/initdb" ] && [ -x "$d/pg_ctl" ] && [ -x "$d/psql" ]; then PGBIN="$d"; break; fi
  done
fi
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "pg-smoke: no Postgres server binaries found (set PG_BIN=/path/to/bin with initdb, pg_ctl, psql)" >&2
  exit 2
fi

# ── Who runs the server (initdb refuses root) ────────────────────────────────
PG_OS_USER=""
CREATED_USER=0
if [ "$(id -u)" = 0 ]; then
  PG_OS_USER="${PG_SMOKE_OS_USER:-}"
  if [ -z "$PG_OS_USER" ]; then
    if id postgres >/dev/null 2>&1; then PG_OS_USER=postgres; else PG_OS_USER=pgsmoke; fi
  fi
  if ! id "$PG_OS_USER" >/dev/null 2>&1; then
    useradd -r -M -s /usr/sbin/nologin "$PG_OS_USER" || { echo "pg-smoke: cannot create OS user $PG_OS_USER" >&2; exit 2; }
    CREATED_USER=1
  fi
fi
# Runs a command as the server's OS user (a no-op wrapper when not root).
run_as_pg() {
  if [ -z "$PG_OS_USER" ]; then "$@"
  elif command -v runuser >/dev/null 2>&1; then runuser -u "$PG_OS_USER" -- "$@"
  else su -s /bin/sh "$PG_OS_USER" -c "$(printf '%q ' "$@")"
  fi
}

# ── Work directory (one per run; a live run's directory is never touched) ────
TMP_ROOT="${TMPDIR:-/tmp}"
BASE="$TMP_ROOT/hioc-pg-smoke"
if [ -f "$BASE/runner.pid" ] && kill -0 "$(cat "$BASE/runner.pid" 2>/dev/null)" 2>/dev/null; then
  BASE="$BASE-$$"   # another run is using the default directory right now
fi
DATA="$BASE/data"
TOLERATED_LOG="$BASE.tolerated-errors.log"   # next to the work dir, so it outlives the cleanup
DB=hioc_smoke
PORT=""
SERVER_UP=0

stop_server() {
  [ -d "$DATA" ] || return 0
  if [ -f "$DATA/postmaster.pid" ]; then
    run_as_pg "$PGBIN/pg_ctl" -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || {
      local pid; pid="$(head -1 "$DATA/postmaster.pid" 2>/dev/null)"
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
    }
  fi
  SERVER_UP=0
}
cleanup() {
  if [ "$KEEP" = 1 ] && [ "$SERVER_UP" = 1 ]; then
    printf '\npg-smoke: --keep: server still running. Connect with:\n  %s/psql -h 127.0.0.1 -p %s -U postgres %s\nStop and clean up with (as %s):\n  %s -D %s -m immediate stop; rm -rf %s\n' \
      "$PGBIN" "$PORT" "$DB" "${PG_OS_USER:-$(id -un)}" "$PGBIN/pg_ctl" "$DATA" "$BASE"
    return 0
  fi
  stop_server
  rm -rf "$BASE"
  if [ "$CREATED_USER" = 1 ]; then userdel "$PG_OS_USER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# A crashed earlier run: stop its server, clear its directory.
if [ -e "$BASE" ]; then stop_server; rm -rf "$BASE"; fi
if [ -z "$PG_OS_USER" ]; then mkdir -m 700 -p "$BASE"; else install -d -m 700 -o "$PG_OS_USER" "$BASE"; fi
echo "$$" > "$BASE/runner.pid"
if ! run_as_pg test -x "$BASE" || ! run_as_pg test -x "$(dirname "$BASE")"; then
  echo "pg-smoke: OS user '${PG_OS_USER:-$(id -un)}' cannot reach $BASE — set TMPDIR to a directory it can enter (e.g. /tmp)" >&2
  exit 2
fi

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
psql_db() { "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -d "$DB" "$@"; }

# Applies one file with ON_ERROR_STOP=1; PASS/FAIL line; returns non-zero on failure.
apply_strict() { # <label> <file>
  local out rc
  out="$(timeout 300 "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$2" 2>&1 >/dev/null)"; rc=$?
  if [ $rc -eq 0 ]; then ok "$1"; return 0; fi
  bad "$1" "$out"; return 1
}

# ── [1/6] Start Postgres ─────────────────────────────────────────────────────
step "1/6" "Starting a private Postgres ($("$PGBIN/postgres" --version | awk '{print $3}'))"
if ! run_as_pg "$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C --no-sync >"$BASE/initdb.log" 2>&1; then
  echo "pg-smoke: initdb failed:" >&2; cat "$BASE/initdb.log" >&2; exit 2
fi
for attempt in 1 2 3; do
  PORT="$(free_port)"
  if run_as_pg "$PGBIN/pg_ctl" -D "$DATA" -l "$BASE/server.log" -w -t 60 \
       -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
       start >/dev/null 2>&1; then
    SERVER_UP=1; break
  fi
  stop_server
done
if [ "$SERVER_UP" != 1 ]; then echo "pg-smoke: the server did not start:" >&2; cat "$BASE/server.log" >&2; exit 2; fi
info "listening on 127.0.0.1:$PORT (server runs as ${PG_OS_USER:-$(id -un)}), data dir $DATA"
if ! "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -d postgres -c "create database $DB"; then
  echo "pg-smoke: cannot create the database" >&2; exit 2
fi

# ── [2/6] Supabase-like baseline ─────────────────────────────────────────────
step "2/6" "Supabase-like baseline (roles, auth stub, default privileges)"
cat > "$BASE/baseline.sql" <<'SQL'
-- The three API roles. service_role bypasses RLS, as on Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

-- Minimal auth schema: the migrations reference auth.users(id) and auth.uid()
-- (RLS policies). The real auth.users has many more columns (email, phone, ...)
-- and a few earlier migrations read them: those fail here and are tolerated.
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid()  returns uuid  language sql stable as $$ select null::uuid $$;
create function auth.role() returns text  language sql stable as $$ select null::text $$;
create function auth.jwt()  returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema public, auth to anon, authenticated, service_role;

-- Supabase's default privileges: every table, sequence and function the
-- migrations create is granted to the three API roles (and functions to
-- PUBLIC by Postgres itself). Without this, "anon cannot read X" would pass
-- even if a migration forgot its REVOKE.
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;

-- No prerequisite stubs are needed today: every table 2026-10-inventory.sql
-- needs (menu_items, menu_item_variants, addon_options, orders, store_settings,
-- staff_emails) is created by a migration that applies here. If a Supabase-only
-- failure in an earlier file ever hides one, create the minimal stub HERE
-- (create table if not exists ...) and say why.
SQL
if psql_db -v ON_ERROR_STOP=1 -f "$BASE/baseline.sql"; then ok "baseline applied"; else bad "baseline"; exit 1; fi

# ── [3/6] Migrations ─────────────────────────────────────────────────────────
step "3/6" "Applying supabase/*.sql (tolerant pass), then the inventory migrations strictly"
TOLERANT_FILES=(supabase/schema.sql supabase/phase1-migration.sql supabase/phase2-migration.sql supabase/phase2-hardening.sql supabase/phase3-migration.sql supabase/security-rls-fix.sql)
while IFS= read -r f; do
  case "$(basename "$f" .sql)" in
    2026-10-inventory|2026-10-inventory-addon-scopes|2026-10-inventory-seed*) continue ;;  # strict pass / seeds
  esac
  TOLERANT_FILES+=("$f")
done < <(ls supabase/2026-*.sql 2>/dev/null | LC_ALL=C sort)

: > "$TOLERATED_LOG"
TOL_ERRORS=0
TOL_SUMMARY=()
for f in "${TOLERANT_FILES[@]}"; do
  [ -f "$f" ] || continue
  out="$(timeout 300 "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -X -q -d "$DB" -v ON_ERROR_STOP=0 -f "$f" 2>&1 >/dev/null)"
  n="$(printf '%s\n' "$out" | grep -c ': ERROR:')" || true
  if [ "${n:-0}" -gt 0 ]; then
    TOL_ERRORS=$((TOL_ERRORS + n))
    printf '== %s\n%s\n\n' "$f" "$out" >> "$TOLERATED_LOG"
    first="$(printf '%s\n' "$out" | grep ': ERROR:' | grep -v 'current transaction is aborted' | head -1 | sed 's/^psql:[^ ]* //')"
    TOL_SUMMARY+=("$(basename "$f"): $n error(s), first: ${first:-?}")
  fi
done
ok "${#TOLERANT_FILES[@]} earlier migrations applied without stopping on errors"
info "$TOL_ERRORS error(s) tolerated (Supabase-only pieces: pg_cron / pg_net / real auth.users columns; files that need a later-named file; cascades from those); full text: $TOLERATED_LOG"
for line in "${TOL_SUMMARY[@]+"${TOL_SUMMARY[@]}"}"; do [ -n "$line" ] && info "- $line"; done

STRICT_OK=1
apply_strict "supabase/2026-10-inventory.sql applies cleanly (fresh)" supabase/2026-10-inventory.sql || STRICT_OK=0
[ $STRICT_OK = 1 ] && { apply_strict "supabase/2026-10-inventory.sql re-applies cleanly (idempotent)" supabase/2026-10-inventory.sql || STRICT_OK=0; }
[ $STRICT_OK = 1 ] && { apply_strict "supabase/2026-10-inventory-addon-scopes.sql applies cleanly (fresh)" supabase/2026-10-inventory-addon-scopes.sql || STRICT_OK=0; }
[ $STRICT_OK = 1 ] && { apply_strict "supabase/2026-10-inventory-addon-scopes.sql re-applies cleanly (idempotent)" supabase/2026-10-inventory-addon-scopes.sql || STRICT_OK=0; }

# ── [4/6] The live menu ──────────────────────────────────────────────────────
MENU_OK=0
if [ $STRICT_OK = 1 ]; then
  step "4/6" "Loading the live menu from data/inventory/menu-snapshot.json"
  node - "$SNAPSHOT" > "$BASE/menu.sql" <<'JS'
// Snapshot -> SQL. Item and add-on option ids are used exactly. The snapshot
// names add-on groups only by name (and label), so groups get generated ids.
const fs = require('node:fs');
const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const out = ['begin;'];
const groups = new Map(); // name -> customer-facing label
for (const o of snap.addon_options ?? []) if (!groups.has(o.group)) groups.set(o.group, o.group_label || o.group);
for (const i of snap.items ?? []) for (const g of i.addon_groups ?? []) if (!groups.has(g)) groups.set(g, g);
let n = 0;
for (const [name, label] of groups) {
  out.push(`insert into addon_groups (name, display_name, selection_type, min_select, max_select, sort_order) values (${q(name)}, ${q(label)}, 'single', 0, 1, ${n++});`);
}
(snap.items ?? []).forEach((i, idx) => {
  out.push(`insert into menu_items (id, name, description, category, parent_category, is_available, sort_order) values (${q(i.id)}, ${q(i.name)}, ${q(i.description ?? '')}, ${q(i.category)}, ${q(i.parent_category ?? '')}, ${i.is_available !== false}, ${idx});`);
  (i.sizes ?? []).forEach((s, si) => {
    out.push(`insert into menu_item_variants (menu_item_id, label, price_inr, sort_order) values (${q(i.id)}, ${q(s.label)}, ${Math.round(Number(s.price_inr) || 0)}, ${si});`);
  });
  for (const g of i.addon_groups ?? []) {
    out.push(`insert into menu_item_addon_groups (menu_item_id, addon_group_id) select ${q(i.id)}, id from addon_groups where name = ${q(g)};`);
  }
});
(snap.addon_options ?? []).forEach((o, idx) => {
  out.push(`insert into addon_options (id, addon_group_id, name, price_inr, sort_order) select ${q(o.id)}, id, ${q(o.option)}, ${Math.round(Number(o.price_inr) || 0)}, ${idx} from addon_groups where name = ${q(o.group)};`);
});
out.push('insert into store_settings (is_singleton) values (true) on conflict (is_singleton) do nothing;');
out.push('commit;');
process.stdout.write(out.join('\n') + '\n');
JS
  if [ $? -ne 0 ]; then
    bad "menu snapshot -> SQL"
  elif apply_strict "menu snapshot loaded" "$BASE/menu.sql"; then
    MENU_OK=1
    counts="$(psql_db -At -F ' ' -c "select (select count(*) from menu_items), (select count(*) from menu_item_variants), (select count(*) from addon_groups), (select count(*) from addon_options), (select count(*) from store_settings)")"
    read -r c_items c_vars c_groups c_opts c_store <<< "$counts"
    info "$c_items menu items, $c_vars sizes, $c_groups add-on groups, $c_opts add-on options, $c_store store_settings row"
  fi
else
  step "4/6" "Loading the live menu — skipped (a migration failed)"
fi

# ── [5/6] Assertions ─────────────────────────────────────────────────────────
if [ $MENU_OK = 1 ]; then
  step "5/6" "Assertions: add-on recipe scopes (2026-10-inventory-addon-scopes.sql)"
  cat > "$BASE/asserts.sql" <<'SQL'
-- Assertions for supabase/2026-10-inventory-addon-scopes.sql, run against the
-- migrated smoke database inside ONE transaction that is rolled back at the
-- end, so nothing they create survives (a --seed run starts from a clean slate).
-- Each block records PASS/FAIL in smoke.results instead of aborting, so one
-- run reports every broken guarantee.
begin;

create schema smoke;
create table smoke.results (id serial primary key, name text not null, ok boolean not null, detail text not null default '');
create table smoke.fx (k text primary key, v text not null);
create function smoke.expect(p_name text, p_ok boolean, p_detail text default '') returns void
  language sql as $$ insert into smoke.results (name, ok, detail) values (p_name, coalesce(p_ok, false), coalesce(p_detail, '')) $$;
create function smoke.fixture(p_k text) returns uuid language sql as $$ select v::uuid from smoke.fx where k = p_k $$;
-- Rows of the option's recipe by scope kind: general / item / item+size.
create function smoke.scope_counts(p_option uuid) returns text language sql as $$
  select format('general=%s item=%s item+size=%s',
           count(*) filter (where menu_item_id is null),
           count(*) filter (where menu_item_id is not null and size_label = ''),
           count(*) filter (where size_label <> ''))
    from addon_recipe_lines where addon_option_id = p_option $$;

-- ── Fixtures: two stock items, a menu item with 2+ sizes, another item, an add-on
do $$
declare
  v_sugar uuid; v_stirrer uuid; v_item uuid; v_other uuid; v_option uuid;
  v_size_a text; v_size_b text;
begin
  insert into inventory_items (name, unit, tracks_expiry) values ('Smoke sugar', 'g', false) returning id into v_sugar;
  insert into inventory_items (name, unit, tracks_expiry) values ('Smoke stirrer', 'pcs', false) returning id into v_stirrer;
  select m.id into v_item from menu_items m
   where (select count(*) from menu_item_variants v where v.menu_item_id = m.id) >= 2
   order by m.sort_order, m.id limit 1;
  select m.id into v_other from menu_items m where m.id <> v_item order by m.sort_order, m.id limit 1;
  select o.id into v_option from addon_options o order by o.sort_order, o.id limit 1;
  select trim(label) into v_size_a from menu_item_variants where menu_item_id = v_item order by sort_order, id limit 1;
  select trim(label) into v_size_b from menu_item_variants where menu_item_id = v_item order by sort_order, id offset 1 limit 1;
  insert into smoke.fx values ('sugar', v_sugar), ('stirrer', v_stirrer), ('item', v_item), ('other', v_other), ('option', v_option),
                              ('size_a', v_size_a), ('size_b', v_size_b);
  perform smoke.expect('fixtures: live menu has an item with 2+ sizes, a second item and an add-on option',
                       v_sugar is not null and v_item is not null and v_other is not null and v_option is not null and v_size_b is not null,
                       format('item=%s sizes=%s/%s option=%s', v_item, v_size_a, v_size_b, v_option));
exception when others then
  perform smoke.expect('fixtures: live menu has an item with 2+ sizes, a second item and an add-on option', false, sqlerrm);
end $$;

-- ── Schema shape
do $$
declare
  v_cols int; v_idx int; v_old int; v_uniq2 int; v_rls boolean;
begin
  select count(*) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'addon_recipe_lines'
     and ((column_name = 'menu_item_id' and data_type = 'uuid' and is_nullable = 'YES')
       or (column_name = 'size_label' and data_type = 'text' and is_nullable = 'NO' and column_default like '''''%'));
  perform smoke.expect('addon_recipe_lines has menu_item_id (uuid, null) and size_label (text, not null, default empty)', v_cols = 2, format('%s of 2 columns as expected', v_cols));

  select count(*) into v_idx from pg_indexes
   where schemaname = 'public' and tablename = 'addon_recipe_lines'
     and indexname in ('addon_recipe_lines_scope_unique', 'addon_recipe_lines_menu_item');
  perform smoke.expect('the scope unique index and the menu_item index exist', v_idx = 2, format('%s of 2', v_idx));

  select count(*) into v_old from pg_constraint
   where conrelid = 'public.addon_recipe_lines'::regclass and conname = 'addon_recipe_lines_addon_option_id_item_id_key';
  select count(*) into v_uniq2 from pg_index i
   where i.indrelid = 'public.addon_recipe_lines'::regclass and i.indisunique and not i.indisprimary
     and i.indnkeyatts = 2
     and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
           where a.attrelid = i.indrelid and a.attnum = any (i.indkey::int2[])) = array['addon_option_id', 'item_id'];
  perform smoke.expect('the old unique (addon_option_id, item_id) is gone', v_old = 0 and v_uniq2 = 0, format('constraint=%s, unique indexes on just those two columns=%s', v_old, v_uniq2));

  perform smoke.expect('inventory_set_addon_recipe_scopes(uuid, uuid, jsonb) returns integer',
    exists (select 1 from pg_proc where proname = 'inventory_set_addon_recipe_scopes'
              and pg_get_function_identity_arguments(oid) = 'p_option_id uuid, p_actor uuid, p_lines jsonb'
              and prorettype = 'integer'::regtype));
  perform smoke.expect('inventory_set_addon_recipe(uuid, uuid, jsonb) is still installed',
    exists (select 1 from pg_proc where proname = 'inventory_set_addon_recipe'
              and pg_get_function_identity_arguments(oid) = 'p_option_id uuid, p_actor uuid, p_lines jsonb'));

  select relrowsecurity into v_rls from pg_class where oid = 'public.inventory_recipe_book'::regclass;
  perform smoke.expect('inventory_recipe_book exists with row level security on', coalesce(v_rls, false));
exception when others then
  perform smoke.expect('schema shape', false, sqlerrm);
end $$;

-- ── inventory_set_addon_recipe_scopes: general + item + item/size lines
do $$
declare
  v_option uuid := smoke.fixture('option'); v_item uuid := smoke.fixture('item'); v_other uuid := smoke.fixture('other');
  v_sugar uuid := smoke.fixture('sugar'); v_stirrer uuid := smoke.fixture('stirrer');
  v_a text; v_b text; v_n int; v_counts text; v_stored text;
begin
  select v into v_a from smoke.fx where k = 'size_a';
  select v into v_b from smoke.fx where k = 'size_b';
  -- The same ingredient in every scope, and a padded size label (must be trimmed).
  v_n := inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
    jsonb_build_object('item_id', v_sugar, 'qty', 20),
    jsonb_build_object('menu_item_id', v_other, 'size_label', '', 'item_id', v_sugar, 'qty', 10),
    jsonb_build_object('menu_item_id', v_item, 'size_label', '  ' || v_a || '  ', 'item_id', v_sugar, 'qty', 25),
    jsonb_build_object('menu_item_id', v_item, 'size_label', v_a, 'item_id', v_stirrer, 'qty', 1)));
  v_counts := smoke.scope_counts(v_option);
  perform smoke.expect('scopes: general + item + item/size lines save (same ingredient in three scopes)',
    v_n = 4 and v_counts = 'general=1 item=1 item+size=2', format('returned %s; %s', v_n, v_counts));
  select size_label into v_stored from addon_recipe_lines
   where addon_option_id = v_option and menu_item_id = v_item and item_id = v_sugar;
  perform smoke.expect('scopes: a padded size label is stored trimmed', v_stored = v_a, format('stored [%s]', v_stored));

  -- Replaces EVERY scope, not just the general lines.
  v_n := inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
    jsonb_build_object('menu_item_id', null, 'size_label', '', 'item_id', v_sugar, 'qty', 5)));
  perform smoke.expect('scopes: saving again replaces all the add-on''s lines, every scope',
    v_n = 1 and smoke.scope_counts(v_option) = 'general=1 item=0 item+size=0', smoke.scope_counts(v_option));

  -- Back to a mixed set for the tests below.
  perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
    jsonb_build_object('item_id', v_sugar, 'qty', 20),
    jsonb_build_object('menu_item_id', v_other, 'item_id', v_sugar, 'qty', 10),
    jsonb_build_object('menu_item_id', v_item, 'size_label', v_a, 'item_id', v_sugar, 'qty', 25)));
  perform smoke.expect('scopes: menu_item_id and size_label may be absent from a line (general / all sizes)',
    smoke.scope_counts(v_option) = 'general=1 item=1 item+size=1', smoke.scope_counts(v_option));
exception when others then
  perform smoke.expect('scopes: save general + item + item/size lines', false, sqlerrm);
end $$;

-- ── Refusals leave the saved recipe exactly as it was
do $$
declare
  v_option uuid := smoke.fixture('option'); v_item uuid := smoke.fixture('item');
  v_sugar uuid := smoke.fixture('sugar');
  v_before text := smoke.scope_counts(smoke.fixture('option'));
  v_msg text; v_constraint text;
begin
  -- A size the item does not have.
  begin
    perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
      jsonb_build_object('item_id', v_sugar, 'qty', 1),
      jsonb_build_object('menu_item_id', v_item, 'size_label', 'No Such Size', 'item_id', v_sugar, 'qty', 2)));
    perform smoke.expect('scopes: a size that is not on the item is refused', false, 'no error was raised');
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform smoke.expect('scopes: a size that is not on the item is refused',
      v_msg = 'inventory: that size does not belong to this menu item', v_msg);
  end;
  perform smoke.expect('scopes: ...and the refused save changed nothing', smoke.scope_counts(v_option) = v_before, smoke.scope_counts(v_option));

  -- A size is checked against ITS line's menu item, not some other item.
  begin
    perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
      jsonb_build_object('menu_item_id', smoke.fixture('other'), 'size_label', (select v from smoke.fx where k = 'size_b'), 'item_id', v_sugar, 'qty', 2)));
    -- Legal only if the other item happens to have a size with that label.
    perform smoke.expect('scopes: a size is checked against its own line''s menu item',
      exists (select 1 from menu_item_variants where menu_item_id = smoke.fixture('other') and trim(label) = (select v from smoke.fx where k = 'size_b')),
      'accepted a size label the other item does not have');
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform smoke.expect('scopes: a size is checked against its own line''s menu item',
      v_msg = 'inventory: that size does not belong to this menu item', v_msg);
  end;
  perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
    jsonb_build_object('item_id', v_sugar, 'qty', 20),
    jsonb_build_object('menu_item_id', smoke.fixture('other'), 'item_id', v_sugar, 'qty', 10),
    jsonb_build_object('menu_item_id', v_item, 'size_label', (select v from smoke.fx where k = 'size_a'), 'item_id', v_sugar, 'qty', 25)));

  -- An add-on that does not exist.
  begin
    perform inventory_set_addon_recipe_scopes(gen_random_uuid(), null, '[]'::jsonb);
    perform smoke.expect('scopes: an unknown add-on is refused', false, 'no error was raised');
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform smoke.expect('scopes: an unknown add-on is refused', v_msg = 'inventory: add-on not found', v_msg);
  end;

  -- Unknown menu item / stock item: the foreign keys.
  begin
    perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
      jsonb_build_object('menu_item_id', gen_random_uuid(), 'item_id', v_sugar, 'qty', 2)));
    perform smoke.expect('scopes: an unknown menu item is refused', false, 'no error was raised');
  exception when foreign_key_violation then
    perform smoke.expect('scopes: an unknown menu item is refused', true);
  end;
  begin
    perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
      jsonb_build_object('item_id', gen_random_uuid(), 'qty', 2)));
    perform smoke.expect('scopes: an unknown stock item is refused', false, 'no error was raised');
  exception when foreign_key_violation then
    perform smoke.expect('scopes: an unknown stock item is refused', true);
  end;

  -- A size on a general line (no menu item) is meaningless: the CHECK.
  begin
    perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
      jsonb_build_object('size_label', 'Large', 'item_id', v_sugar, 'qty', 2)));
    perform smoke.expect('scopes: a size without a menu item is refused', false, 'no error was raised');
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform smoke.expect('scopes: a size without a menu item is refused', v_constraint = 'addon_recipe_lines_size_needs_item', v_constraint);
  end;

  -- The same scope twice in one save: the unique index.
  begin
    perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item, 'item_id', v_sugar, 'qty', 1),
      jsonb_build_object('menu_item_id', v_item, 'size_label', '', 'item_id', v_sugar, 'qty', 2)));
    perform smoke.expect('scopes: the same ingredient twice in one scope is refused', false, 'no error was raised');
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform smoke.expect('scopes: the same ingredient twice in one scope is refused', v_constraint = 'addon_recipe_lines_scope_unique', v_constraint);
  end;

  perform smoke.expect('scopes: none of the refused saves changed the recipe', smoke.scope_counts(v_option) = v_before, smoke.scope_counts(v_option));
exception when others then
  perform smoke.expect('scopes: refusals', false, sqlerrm);
end $$;

-- ── inventory_set_addon_recipe (the POS editor) touches only the general lines
do $$
declare
  v_option uuid := smoke.fixture('option'); v_sugar uuid := smoke.fixture('sugar'); v_stirrer uuid := smoke.fixture('stirrer');
  v_n int; v_scoped_before text; v_scoped_after text; v_general_item uuid; v_general_qty numeric;
begin
  v_scoped_before := (select string_agg(format('%s|%s|%s|%s', menu_item_id, size_label, item_id, qty), ',' order by menu_item_id, size_label, item_id)
                        from addon_recipe_lines where addon_option_id = v_option and menu_item_id is not null);
  v_n := inventory_set_addon_recipe(v_option, null, jsonb_build_array(jsonb_build_object('item_id', v_stirrer, 'qty', 3)));
  select item_id, qty into v_general_item, v_general_qty from addon_recipe_lines where addon_option_id = v_option and menu_item_id is null;
  v_scoped_after := (select string_agg(format('%s|%s|%s|%s', menu_item_id, size_label, item_id, qty), ',' order by menu_item_id, size_label, item_id)
                       from addon_recipe_lines where addon_option_id = v_option and menu_item_id is not null);
  perform smoke.expect('POS editor: saving replaces the general lines',
    v_n = 1 and v_general_item = v_stirrer and v_general_qty = 3 and (select count(*) from addon_recipe_lines where addon_option_id = v_option and menu_item_id is null) = 1,
    format('returned %s; general is now %s x %s', v_n, v_general_item, v_general_qty));
  perform smoke.expect('POS editor: ...and leaves the per-item and per-size lines untouched',
    v_scoped_before is not null and v_scoped_before = v_scoped_after, smoke.scope_counts(v_option));

  v_n := inventory_set_addon_recipe(v_option, null, '[]'::jsonb);
  perform smoke.expect('POS editor: an empty list clears only the general recipe',
    v_n = 0 and smoke.scope_counts(v_option) = 'general=0 item=1 item+size=1', smoke.scope_counts(v_option));

  perform inventory_set_addon_recipe(v_option, null, jsonb_build_array(jsonb_build_object('item_id', v_sugar, 'qty', 20)));
  perform smoke.expect('POS editor: the same ingredient can come back as a general line beside scoped ones',
    smoke.scope_counts(v_option) = 'general=1 item=1 item+size=1', smoke.scope_counts(v_option));

  begin
    perform inventory_set_addon_recipe(gen_random_uuid(), null, '[]'::jsonb);
    perform smoke.expect('POS editor: an unknown add-on is refused', false, 'no error was raised');
  exception when others then
    perform smoke.expect('POS editor: an unknown add-on is refused', sqlerrm = 'inventory: add-on not found', sqlerrm);
  end;
exception when others then
  perform smoke.expect('POS editor: general-only replace', false, sqlerrm);
end $$;

-- ── Uniqueness and CHECKs, straight on the table
do $$
declare
  v_option uuid := smoke.fixture('option'); v_item uuid := smoke.fixture('item'); v_other uuid := smoke.fixture('other');
  v_sugar uuid := smoke.fixture('sugar'); v_stirrer uuid := smoke.fixture('stirrer');
  v_a text; v_c text;
begin
  select v into v_a from smoke.fx where k = 'size_a';
  -- Duplicate of an existing item scope line (v_other / '' / sugar).
  begin
    insert into addon_recipe_lines (addon_option_id, menu_item_id, size_label, item_id, qty) values (v_option, v_other, '', v_sugar, 1);
    perform smoke.expect('unique: a duplicate item-scope line violates the scope index', false, 'insert succeeded');
  exception when unique_violation then
    get stacked diagnostics v_c = constraint_name;
    perform smoke.expect('unique: a duplicate item-scope line violates the scope index', v_c = 'addon_recipe_lines_scope_unique', v_c);
  end;
  begin
    insert into addon_recipe_lines (addon_option_id, menu_item_id, size_label, item_id, qty) values (v_option, v_item, v_a, v_sugar, 1);
    perform smoke.expect('unique: a duplicate item+size line violates the scope index', false, 'insert succeeded');
  exception when unique_violation then
    perform smoke.expect('unique: a duplicate item+size line violates the scope index', true);
  end;
  -- NULL menu_item_id must not make general lines look distinct.
  begin
    insert into addon_recipe_lines (addon_option_id, item_id, qty) values (v_option, v_sugar, 1);
    perform smoke.expect('unique: a duplicate GENERAL line violates the scope index (null menu item folded)', false, 'insert succeeded');
  exception when unique_violation then
    perform smoke.expect('unique: a duplicate GENERAL line violates the scope index (null menu item folded)', true);
  end;
  -- Different scopes, same ingredient: allowed.
  insert into addon_recipe_lines (addon_option_id, menu_item_id, size_label, item_id, qty) values (v_option, v_item, '', v_sugar, 15);
  perform smoke.expect('unique: the same ingredient in another scope is allowed', true);

  begin
    insert into addon_recipe_lines (addon_option_id, menu_item_id, size_label, item_id, qty) values (v_option, v_item, ' Large', v_stirrer, 1);
    perform smoke.expect('check: a size label with padding is refused', false, 'insert succeeded');
  exception when check_violation then
    get stacked diagnostics v_c = constraint_name;
    perform smoke.expect('check: a size label with padding is refused', v_c = 'addon_recipe_lines_size_trimmed', v_c);
  end;
  begin
    insert into addon_recipe_lines (addon_option_id, size_label, item_id, qty) values (v_option, 'Large', v_stirrer, 1);
    perform smoke.expect('check: a size label with no menu item is refused', false, 'insert succeeded');
  exception when check_violation then
    get stacked diagnostics v_c = constraint_name;
    perform smoke.expect('check: a size label with no menu item is refused', v_c = 'addon_recipe_lines_size_needs_item', v_c);
  end;
  begin
    insert into addon_recipe_lines (addon_option_id, menu_item_id, item_id, qty) values (v_option, v_item, v_stirrer, 0);
    perform smoke.expect('check: qty must stay above 0', false, 'insert succeeded');
  exception when check_violation then
    perform smoke.expect('check: qty must stay above 0', true);
  end;
exception when others then
  perform smoke.expect('uniqueness and checks', false, sqlerrm);
end $$;

-- ── Deleting a menu item takes its scoped lines with it (on delete cascade)
do $$
declare
  v_option uuid := smoke.fixture('option'); v_sugar uuid := smoke.fixture('sugar');
  v_tmp uuid; v_before int; v_after int; v_general int;
begin
  insert into menu_items (name, category) values ('Smoke temp item', 'Smoke') returning id into v_tmp;
  insert into menu_item_variants (menu_item_id, label, price_inr) values (v_tmp, 'Big', 1);
  perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(
    jsonb_build_object('item_id', v_sugar, 'qty', 20),
    jsonb_build_object('menu_item_id', v_tmp, 'size_label', 'Big', 'item_id', v_sugar, 'qty', 30)));
  select count(*) into v_before from addon_recipe_lines where menu_item_id = v_tmp;
  delete from menu_items where id = v_tmp;
  select count(*) into v_after from addon_recipe_lines where menu_item_id = v_tmp;
  select count(*) into v_general from addon_recipe_lines where addon_option_id = v_option and menu_item_id is null;
  perform smoke.expect('cascade: deleting a menu item deletes its scoped add-on lines and keeps the general ones',
    v_before = 1 and v_after = 0 and v_general = 1, format('scoped %s -> %s, general kept %s', v_before, v_after, v_general));
exception when others then
  perform smoke.expect('cascade: deleting a menu item deletes its scoped add-on lines', false, sqlerrm);
end $$;

-- ── The recipe book: one row, service role only
do $$
declare
  v_saved timestamptz;
begin
  set local role service_role;
  insert into inventory_recipe_book (book) values ('{"stock_items": []}'::jsonb);
  insert into inventory_recipe_book (id, book) values (true, '{"v": 2}'::jsonb)
    on conflict (id) do update set book = excluded.book, saved_at = now();
  select saved_at into v_saved from inventory_recipe_book;
  perform set_config('smoke.book_rows', (select count(*)::text from inventory_recipe_book), true);
  begin
    insert into inventory_recipe_book (id, book) values (false, '{}'::jsonb);
    perform set_config('smoke.book_false', 'accepted', true);
  exception when check_violation then
    perform set_config('smoke.book_false', 'refused', true);
  end;
  reset role;
  perform smoke.expect('recipe book: the service role can save and upsert it, and it stays one row',
    current_setting('smoke.book_rows') = '1' and v_saved is not null and (select book->>'v' from inventory_recipe_book) = '2',
    format('rows=%s', current_setting('smoke.book_rows')));
  perform smoke.expect('recipe book: a second row (id = false) is refused', current_setting('smoke.book_false') = 'refused', current_setting('smoke.book_false'));
exception when others then
  perform smoke.expect('recipe book: service role', false, sqlerrm);
end $$;

-- ── Lock-down: anon and authenticated get nothing; the service role is let in
-- try_as runs one statement as a role and says what happened. A failure to
-- SET ROLE itself is NOT swallowed: it would read as "denied" and hide a hole.
create function smoke.try_as(p_role text, p_sql text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
  exception
    when insufficient_privilege then reset role; return 'denied';
    when others then reset role; return 'ran: ' || sqlerrm;
  end;
  reset role;
  return 'allowed';
end $$;

do $$
declare
  r text; s text; v_res text; v_open text := '';
  v_probes text[] := array[
    'select 1 from inventory_recipe_book',
    'insert into inventory_recipe_book (book) values (''{}''::jsonb)',
    'select 1 from addon_recipe_lines',
    'select inventory_set_addon_recipe_scopes(gen_random_uuid(), null, ''[]''::jsonb)',
    'select inventory_set_addon_recipe(gen_random_uuid(), null, ''[]''::jsonb)'];
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach s in array v_probes loop
      v_res := smoke.try_as(r, s);
      if v_res <> 'denied' then v_open := v_open || format(' [%s: %s => %s]', r, s, v_res); end if;
    end loop;
  end loop;
  perform smoke.expect('lock-down: anon and authenticated cannot read or write the recipe book, read the add-on lines, or run either function',
    v_open = '', case when v_open = '' then 'permission denied for all 10 probes' else 'OPEN:' || v_open end);

  -- The service role reaches the function bodies (their own refusal proves they ran).
  v_res := smoke.try_as('service_role', 'select inventory_set_addon_recipe_scopes(gen_random_uuid(), null, ''[]''::jsonb)');
  perform smoke.expect('lock-down: the service role can call inventory_set_addon_recipe_scopes', v_res = 'ran: inventory: add-on not found', v_res);
  v_res := smoke.try_as('service_role', 'select inventory_set_addon_recipe(gen_random_uuid(), null, ''[]''::jsonb)');
  perform smoke.expect('lock-down: the service role can call inventory_set_addon_recipe', v_res = 'ran: inventory: add-on not found', v_res);
  v_res := smoke.try_as('service_role', 'select 1 from inventory_recipe_book');
  perform smoke.expect('lock-down: the service role can read the recipe book', v_res = 'allowed', v_res);
exception when others then
  perform smoke.expect('lock-down', false, sqlerrm);
end $$;

-- ── Report (tuples-only, one PASS|FAIL line per assertion), then throw it all away
select case when ok then 'PASS' else 'FAIL' end || '|' || name || '|' || detail from smoke.results order by id;
rollback;
SQL
  out="$(psql_db -At -v ON_ERROR_STOP=1 -f "$BASE/asserts.sql" 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then
    bad "the assertion script could not run" "$out"
  else
    n_checked=0
    while IFS='|' read -r verdict name detail; do
      case "$verdict" in
        PASS) ok "$name"; n_checked=$((n_checked + 1)) ;;
        FAIL) bad "$name" "$detail"; n_checked=$((n_checked + 1)) ;;
      esac
    done <<< "$out"
    [ "$n_checked" -gt 0 ] || bad "the assertion script reported no results" "$out"
  fi
else
  step "5/6" "Assertions — skipped (the migrations or the menu did not load)"
fi

# ── [6/6] Optional: a recipe-book seed ───────────────────────────────────────
seed_stats() {
  psql_db -At -F '|' -v ON_ERROR_STOP=1 <<'SQL'
select 'stock items (inventory_items)', count(*)::text from inventory_items
union all select 'recipe_lines', count(*)::text from recipe_lines
union all select 'menu items with recipes', count(distinct menu_item_id)::text from recipe_lines
union all select 'add-on options with recipes', count(distinct addon_option_id)::text from addon_recipe_lines
union all select 'addon_recipe_lines: general', count(*)::text from addon_recipe_lines where menu_item_id is null
union all select 'addon_recipe_lines: item (all sizes)', count(*)::text from addon_recipe_lines where menu_item_id is not null and size_label = ''
union all select 'addon_recipe_lines: item + size', count(*)::text from addon_recipe_lines where size_label <> ''
union all select 'inventory_recipe_book rows', count(*)::text from inventory_recipe_book
union all select 'store_settings.stock_auto_hide', coalesce((select stock_auto_hide::text from store_settings where is_singleton limit 1), '(no settings row)');
SQL
}
if [ -n "$SEED_FILE" ]; then
  if [ $MENU_OK = 1 ]; then
    step "6/6" "Applying the seed twice: $SEED_FILE"
    if apply_strict "seed applies cleanly (first run)" "$SEED_FILE"; then
      stats1="$(seed_stats 2>&1)" || bad "reading back what the seed loaded" "$stats1"
      if apply_strict "seed re-applies cleanly (second run)" "$SEED_FILE"; then
        stats2="$(seed_stats 2>&1)" || bad "reading back what the seed loaded (second run)" "$stats2"
        if [ -z "$stats2" ] || [ "$stats1" != "$stats2" ]; then
          bad "seed is idempotent: no row count changed on the second run" "$(diff <(printf '%s\n' "$stats1") <(printf '%s\n' "$stats2") || true)"
        else
          ok "seed is idempotent: no row count changed on the second run"
        fi
        printf '\n  What the seed loaded:\n'
        printf '%s\n' "$stats2" | awk -F'|' '{ printf "        %-40s %s\n", $1, $2 }'
      fi
    fi
  else
    step "6/6" "Seed — skipped (the migrations or the menu did not load)"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n%s\n' "----------------------------------------------------------------"
if [ "$FAIL_N" -eq 0 ]; then
  printf 'pg-smoke: PASS  (%s checks, 0 failed, %ss)\n' "$PASS_N" "$((SECONDS - T0))"
  RC=0
else
  printf 'pg-smoke: FAIL  (%s passed, %s failed, %ss)\n' "$PASS_N" "$FAIL_N" "$((SECONDS - T0))"
  for f in "${FAILS[@]}"; do printf '  - %s\n' "$f"; done
  printf 'Tolerated-error log of the earlier migrations: %s\n' "$TOLERATED_LOG"
  RC=1
fi
exit $RC
