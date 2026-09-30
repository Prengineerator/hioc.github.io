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
#      Then supabase/2026-10-inventory.sql,
#      supabase/2026-10-inventory-addon-scopes.sql and
#      supabase/2026-10-inventory-apply-book.sql are applied with
#      ON_ERROR_STOP=1, each TWICE (a fresh apply and a re-run): those must
#      apply cleanly. (Not in the tolerant pass, so nothing can be half-applied
#      there and hidden.) Between the first two files the POS add-on editor's
#      function is exercised on the OLD schema (no scope columns yet).
#   4. Loads the live menu from data/inventory/menu-snapshot.json (item and
#      add-on option ids exactly; groups by name with generated ids).
#   5. Runs SQL assertions for the add-on scope migration (inside one
#      transaction that is rolled back, so they leave nothing behind).
#      Then (5b) the two migrations are applied in the other order: the older
#      2026-10-inventory.sql AGAIN, after the scopes file, and the scopes file
#      after that, each with ON_ERROR_STOP=1. After each, the POS editor's
#      inventory_set_addon_recipe must still replace only an add-on's general
#      lines and leave its per-item / per-size lines intact (its own
#      rolled-back transaction). The two files can be re-applied in any order.
#      (5c) inventory_apply_book (the recipe-book seed's logic, called by
#      seed.sql and by `npm run inventory:apply`): a save-only call stores the
#      book and changes nothing else; a dry run raises 'DRY RUN OK' and leaves
#      no rows; every guard refuses (and rolls back the book it had saved);
#      a real apply is idempotent; anon and authenticated cannot execute it and
#      the service role can (all in one rolled-back transaction).
#   6. With --seed <file.sql> (a generated seed.sql: `select
#      inventory_apply_book(...)`): applies that seed twice with ON_ERROR_STOP=1
#      and prints what it loaded. The harness assumes nothing about the seed's
#      content, only that re-applying it changes no row counts.
#   7. Prints a PASS/FAIL summary and exits non-zero on any failure. It always
#      stops the server and deletes the data dir on exit.
#
# Usage:  bash scripts/inventory/pg-smoke.sh [--seed <file.sql>] [--keep]
#   --seed FILE   also apply a generated recipe-book seed (data/inventory/book/seed.sql)
#                 after the migrations, which include inventory_apply_book
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

# Every assertion script is one transaction that is rolled back at the end and
# records PASS/FAIL in smoke.results instead of aborting, so one run reports
# every broken guarantee. smoke_preamble opens it, smoke_report closes it: the
# report is tuples-only, one PASS|FAIL|name|detail line per assertion.
smoke_preamble() {
  cat <<'SQL'
begin;
create schema smoke;
create table smoke.results (id serial primary key, name text not null, ok boolean not null, detail text not null default '');
create function smoke.expect(p_name text, p_ok boolean, p_detail text default '') returns void
  language sql as $$ insert into smoke.results (name, ok, detail) values (p_name, coalesce(p_ok, false), coalesce(p_detail, '')) $$;
SQL
}
smoke_report() {
  cat <<'SQL'
select case when ok then 'PASS' else 'FAIL' end || '|' || name || '|' || detail from smoke.results order by id;
rollback;
SQL
}
# Runs an assertion script and reports each of its lines. <prefix> is put
# before every assertion's name (may be empty); more arguments go to psql.
run_assertions() { # <prefix> <file> [psql args...]
  local prefix="$1" file="$2" out rc verdict name detail n_checked=0
  shift 2
  out="$(psql_db -At -v ON_ERROR_STOP=1 "$@" -f "$file" 2>&1)"; rc=$?
  if [ $rc -ne 0 ]; then bad "${prefix}the assertion script could not run" "$out"; return 1; fi
  while IFS='|' read -r verdict name detail; do
    case "$verdict" in
      PASS) ok "${prefix}${name}"; n_checked=$((n_checked + 1)) ;;
      FAIL) bad "${prefix}${name}" "$detail"; n_checked=$((n_checked + 1)) ;;
    esac
  done <<< "$out"
  [ "$n_checked" -gt 0 ] || bad "${prefix}the assertion script reported no results" "$out"
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
    2026-10-inventory|2026-10-inventory-addon-scopes|2026-10-inventory-apply-book|2026-10-inventory-seed*) continue ;;  # strict pass / seeds
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

# The POS add-on editor's function as 2026-10-inventory.sql leaves it BEFORE the
# scopes migration exists: its delete reads menu_item_id through to_jsonb (the
# column is not there yet) and its insert names no scope column. Run on the old
# schema, in a transaction that is rolled back.
if [ $STRICT_OK = 1 ]; then
  { smoke_preamble; cat <<'SQL'; smoke_report; } > "$BASE/pre-scopes.sql"
do $$
declare
  v_group uuid; v_opt uuid; v_a uuid; v_b uuid; v_n int; v_rows int; v_qty numeric;
begin
  perform smoke.expect('before the scopes migration: addon_recipe_lines has no menu_item_id or size_label yet',
    not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'addon_recipe_lines' and column_name in ('menu_item_id', 'size_label')));
  insert into addon_groups (name, display_name, selection_type, min_select, max_select, sort_order)
    values ('Smoke pre-scopes group', 'Smoke', 'single', 0, 1, 0) returning id into v_group;
  insert into addon_options (addon_group_id, name, price_inr, sort_order) values (v_group, 'Smoke pre-scopes option', 0, 0) returning id into v_opt;
  insert into inventory_items (name, unit, tracks_expiry) values ('Smoke pre A', 'g', false) returning id into v_a;
  insert into inventory_items (name, unit, tracks_expiry) values ('Smoke pre B', 'g', false) returning id into v_b;

  v_n := inventory_set_addon_recipe(v_opt, null, jsonb_build_array(
    jsonb_build_object('item_id', v_a, 'qty', 5), jsonb_build_object('item_id', v_b, 'qty', 2)));
  select count(*) into v_rows from addon_recipe_lines where addon_option_id = v_opt;
  perform smoke.expect('before the scopes migration: inventory_set_addon_recipe saves an add-on recipe',
    v_n = 2 and v_rows = 2, format('returned %s, %s rows', v_n, v_rows));

  v_n := inventory_set_addon_recipe(v_opt, null, jsonb_build_array(jsonb_build_object('item_id', v_a, 'qty', 7)));
  select count(*), max(qty) into v_rows, v_qty from addon_recipe_lines where addon_option_id = v_opt;
  perform smoke.expect('before the scopes migration: ...saving again replaces it',
    v_n = 1 and v_rows = 1 and v_qty = 7, format('returned %s, %s rows, qty %s', v_n, v_rows, v_qty));

  v_n := inventory_set_addon_recipe(v_opt, null, '[]'::jsonb);
  select count(*) into v_rows from addon_recipe_lines where addon_option_id = v_opt;
  perform smoke.expect('before the scopes migration: ...and an empty list clears it', v_n = 0 and v_rows = 0, format('returned %s, %s rows', v_n, v_rows));
exception when others then
  perform smoke.expect('before the scopes migration: inventory_set_addon_recipe works on the old schema', false, sqlerrm);
end $$;
SQL
  info "the POS editor's function on the old schema (before the scopes migration):"
  run_assertions "" "$BASE/pre-scopes.sql"
fi

[ $STRICT_OK = 1 ] && { apply_strict "supabase/2026-10-inventory-addon-scopes.sql applies cleanly (fresh)" supabase/2026-10-inventory-addon-scopes.sql || STRICT_OK=0; }
[ $STRICT_OK = 1 ] && { apply_strict "supabase/2026-10-inventory-addon-scopes.sql re-applies cleanly (idempotent)" supabase/2026-10-inventory-addon-scopes.sql || STRICT_OK=0; }

# The recipe-book seed's logic (a plpgsql function; its body is only checked when
# it runs, which the assertions of step 5c do). Needs the two files above.
[ $STRICT_OK = 1 ] && { apply_strict "supabase/2026-10-inventory-apply-book.sql applies cleanly (fresh)" supabase/2026-10-inventory-apply-book.sql || STRICT_OK=0; }
[ $STRICT_OK = 1 ] && { apply_strict "supabase/2026-10-inventory-apply-book.sql re-applies cleanly (idempotent)" supabase/2026-10-inventory-apply-book.sql || STRICT_OK=0; }

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
  run_assertions "" "$BASE/asserts.sql"
else
  step "5/6" "Assertions — skipped (the migrations or the menu did not load)"
fi

# ── [5b/6] The two migrations in the other order ─────────────────────────────
# 2026-10-inventory.sql is older than the scopes file and says it is safe to
# re-run: it must not undo the scopes file. Applied again AFTER it, the POS
# editor's function must still replace only the general lines. Then the scopes
# file goes over it again, and the same checks run (in each state the installed
# body is the one just applied, so the check is not passing on the other's).
if [ $STRICT_OK = 1 ]; then
  step "5b/6" "Order independence: 2026-10-inventory.sql again AFTER the scopes migration, then the scopes file again"
  { smoke_preamble; cat <<'SQL'; smoke_report; } > "$BASE/order.sql"
select set_config('smoke.marker', :'marker', true);
-- The scoped lines of an add-on, one comparable string.
create function smoke.scoped(p_option uuid) returns text language sql as $$
  select string_agg(format('%s|%s|%s|%s', menu_item_id, size_label, item_id, qty), ',' order by menu_item_id, size_label, item_id)
    from addon_recipe_lines where addon_option_id = p_option and menu_item_id is not null $$;
create function smoke.general(p_option uuid) returns text language sql as $$
  select coalesce(string_agg(format('%s|%s', item_id, qty), ',' order by item_id), '')
    from addon_recipe_lines where addon_option_id = p_option and menu_item_id is null $$;

do $$
declare
  v_marker text := current_setting('smoke.marker');
  v_group uuid; v_opt uuid; v_item uuid; v_sugar uuid; v_stirrer uuid; v_cups uuid;
  v_def text; v_n int; v_before text;
begin
  insert into inventory_items (name, unit, tracks_expiry) values ('Smoke order sugar', 'g', false) returning id into v_sugar;
  insert into inventory_items (name, unit, tracks_expiry) values ('Smoke order stirrer', 'pcs', false) returning id into v_stirrer;
  insert into inventory_items (name, unit, tracks_expiry) values ('Smoke order cups', 'pcs', false) returning id into v_cups;
  insert into menu_items (name, category) values ('Smoke order item', 'Smoke') returning id into v_item;
  insert into menu_item_variants (menu_item_id, label, price_inr) values (v_item, 'Big', 1), (v_item, 'Small', 1);
  insert into addon_groups (name, display_name, selection_type, min_select, max_select, sort_order)
    values ('Smoke order group', 'Smoke', 'single', 0, 1, 0) returning id into v_group;
  insert into addon_options (addon_group_id, name, price_inr, sort_order) values (v_group, 'Smoke order option', 0, 0) returning id into v_opt;

  -- Which body is installed: the one the file just applied put there.
  v_def := pg_get_functiondef('inventory_set_addon_recipe(uuid, uuid, jsonb)'::regprocedure);
  perform smoke.expect('inventory_set_addon_recipe is the version the file just applied (its body has "' || v_marker || '")',
    position(v_marker in v_def) > 0, 'a different body is installed');
  perform smoke.expect('there is still exactly one inventory_set_addon_recipe and one inventory_set_addon_recipe_scopes',
    (select count(*) from pg_proc where proname = 'inventory_set_addon_recipe') = 1
    and (select count(*) from pg_proc where proname = 'inventory_set_addon_recipe_scopes') = 1);

  -- A recipe with all three scopes, the recipe book's way.
  perform inventory_set_addon_recipe_scopes(v_opt, null, jsonb_build_array(
    jsonb_build_object('item_id', v_sugar, 'qty', 20),
    jsonb_build_object('menu_item_id', v_item, 'size_label', '', 'item_id', v_sugar, 'qty', 15),
    jsonb_build_object('menu_item_id', v_item, 'size_label', 'Big', 'item_id', v_sugar, 'qty', 25),
    jsonb_build_object('menu_item_id', v_item, 'size_label', 'Small', 'item_id', v_cups, 'qty', 1)));
  v_before := smoke.scoped(v_opt);
  perform smoke.expect('fixture: the add-on has a general line and three scoped ones',
    v_before is not null and smoke.general(v_opt) = format('%s|20.000', v_sugar) and (select count(*) from addon_recipe_lines where addon_option_id = v_opt) = 4,
    v_before);

  -- The POS editor saves the add-on.
  v_n := inventory_set_addon_recipe(v_opt, null, jsonb_build_array(jsonb_build_object('item_id', v_stirrer, 'qty', 3)));
  perform smoke.expect('POS editor: saving replaces the general lines',
    v_n = 1 and smoke.general(v_opt) = format('%s|3.000', v_stirrer), format('returned %s; general is now [%s]', v_n, smoke.general(v_opt)));
  perform smoke.expect('POS editor: ...and leaves every per-item and per-size line intact',
    smoke.scoped(v_opt) = v_before, format('before [%s] after [%s]', v_before, smoke.scoped(v_opt)));

  v_n := inventory_set_addon_recipe(v_opt, null, '[]'::jsonb);
  perform smoke.expect('POS editor: an empty list clears only the general line',
    v_n = 0 and smoke.general(v_opt) = '' and smoke.scoped(v_opt) = v_before, format('returned %s; general [%s]', v_n, smoke.general(v_opt)));

  -- The ingredient that is scoped can come back as a general line beside the scoped ones.
  v_n := inventory_set_addon_recipe(v_opt, null, jsonb_build_array(jsonb_build_object('item_id', v_sugar, 'qty', 9)));
  perform smoke.expect('POS editor: the same ingredient as a general line beside its scoped lines',
    v_n = 1 and smoke.general(v_opt) = format('%s|9.000', v_sugar) and smoke.scoped(v_opt) = v_before);

  -- Still locked down.
  perform smoke.expect('lock-down: only the service role may run inventory_set_addon_recipe',
    has_function_privilege('service_role', 'inventory_set_addon_recipe(uuid, uuid, jsonb)', 'execute')
    and not has_function_privilege('anon', 'inventory_set_addon_recipe(uuid, uuid, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'inventory_set_addon_recipe(uuid, uuid, jsonb)', 'execute'));
exception when others then
  perform smoke.expect('order independence: the POS editor keeps the scoped lines', false, sqlerrm);
end $$;
SQL
  if apply_strict "supabase/2026-10-inventory.sql re-applies cleanly AFTER the scopes migration" supabase/2026-10-inventory.sql; then
    run_assertions "after 2026-10-inventory.sql again: " "$BASE/order.sql" -v marker=to_jsonb
  fi
  if apply_strict "supabase/2026-10-inventory-addon-scopes.sql re-applies cleanly after that" supabase/2026-10-inventory-addon-scopes.sql; then
    run_assertions "after the scopes file again: " "$BASE/order.sql" -v marker='and menu_item_id is null'
  fi
else
  step "5b/6" "Order independence — skipped (a migration failed)"
fi

# ── [5c/6] inventory_apply_book ──────────────────────────────────────────────
# The function the seed calls (2026-10-inventory-apply-book.sql). One
# transaction that is rolled back at the end, like the other assertion scripts.
# Fixtures are real rows of the loaded menu plus invented stock items; a call
# that must be refused is made inside its own sub-transaction (smoke.attempt),
# so a refusal can be checked for having rolled back everything it did before
# it failed, including the book that step 0 had already saved.
if [ $MENU_OK = 1 ]; then
  step "5c/6" "Assertions: inventory_apply_book (2026-10-inventory-apply-book.sql)"
  { smoke_preamble; cat <<'SQL'; smoke_report; } > "$BASE/applybook.sql"
create table smoke.fx (k text primary key, v text not null);
create function smoke.fixture(p_k text) returns uuid language sql as $$ select v::uuid from smoke.fx where k = p_k $$;
create function smoke.fixture_text(p_k text) returns text language sql as $$ select v from smoke.fx where k = p_k $$;

-- Every row of what a call writes, as one hash (the saved book is compared apart).
create function smoke.fingerprint() returns text language sql as $$
  select md5(concat_ws('|',
    (select coalesce(string_agg(j, ',' order by j), '') from (select to_jsonb(t)::text as j from inventory_items t) s),
    (select coalesce(string_agg(j, ',' order by j), '') from (select to_jsonb(t)::text as j from recipe_lines t) s),
    (select coalesce(string_agg(j, ',' order by j), '') from (select to_jsonb(t)::text as j from addon_recipe_lines t) s),
    (select coalesce(string_agg(j, ',' order by j), '') from (select to_jsonb(t)::text as j from store_settings t) s),
    (select coalesce(string_agg(j, ',' order by j), '') from (select to_jsonb(t)::text as j from menu_items t) s))) $$;
create function smoke.counts() returns text language sql as $$
  select format('items=%s recipe_lines=%s addon_lines=%s book_rows=%s',
    (select count(*) from inventory_items), (select count(*) from recipe_lines),
    (select count(*) from addon_recipe_lines), (select count(*) from inventory_recipe_book)) $$;
create function smoke.book() returns jsonb language sql as $$ select book from inventory_recipe_book $$;
create function smoke.doc(p_marker text) returns jsonb language sql as $$
  select jsonb_build_object('version', 1, 'stock_items', jsonb_build_object('items', '[]'::jsonb),
                            'recipe_files', '[]'::jsonb, 'addon_recipes', jsonb_build_object('options', '[]'::jsonb), 'marker', p_marker) $$;
-- One call in its own sub-transaction: 'ok', or the error's message. A refused call leaves nothing behind.
create function smoke.attempt(p_payload jsonb, p_doc jsonb, p_dry boolean default false) returns text language plpgsql as $$
begin
  perform inventory_apply_book(p_payload, p_doc, p_dry);
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
-- A call that must be refused with a message like p_like, and must leave no trace, not even the book.
create function smoke.refused(p_name text, p_payload jsonb, p_like text) returns void language plpgsql as $$
declare
  v_before text := smoke.fingerprint(); v_book jsonb := smoke.book(); v_msg text;
begin
  v_msg := smoke.attempt(p_payload, smoke.doc('refused'), false);
  perform smoke.expect(p_name, v_msg like p_like, v_msg);
  perform smoke.expect(p_name || ' — and nothing was saved, not even the book',
    smoke.fingerprint() = v_before and smoke.book() is not distinct from v_book);
end $$;
create function smoke.stock(p_name text, p_unit text default 'g', p_category text default '', p_par numeric default 0, p_reorder numeric default 0, p_expiry boolean default false)
  returns jsonb language sql as $$
  select jsonb_build_object('name', p_name, 'unit', p_unit, 'category', p_category, 'par_level', p_par, 'reorder_qty', p_reorder, 'tracks_expiry', p_expiry) $$;
create function smoke.payload(p_stock jsonb default '[]', p_recipes jsonb default '[]', p_addons jsonb default '[]') returns jsonb language sql as $$
  select jsonb_build_object('stock_items', p_stock, 'recipes', p_recipes, 'addon_recipes', p_addons) $$;
-- A payload that does a bit of everything: a new stock item; an existing one matched by a
-- differently spelled name; an existing one whose par / reorder / category must survive;
-- one recipe (for the "other" item); one add-on with a general line and a scoped one.
create function smoke.good_payload() returns jsonb language sql as $$
  select smoke.payload(
    jsonb_build_array(
      smoke.stock('Smoke ab new', 'g', 'Coffee'),
      smoke.stock('  Smoke AB existing ', 'g', 'Bakery', 9, 0, true),
      smoke.stock('Smoke ab keep', 'g', '', 0, 0, false)),
    jsonb_build_array(jsonb_build_object('id', smoke.fixture('other'), 'name', 'Other item', 'lines', jsonb_build_array(
      jsonb_build_object('size_label', '', 'ingredient', 'Smoke ab new', 'qty', 4)))),
    jsonb_build_array(jsonb_build_object('id', smoke.fixture('option'), 'name', 'Group › Option', 'lines', jsonb_build_array(
      jsonb_build_object('menu_item_id', null, 'size_label', '', 'ingredient', 'smoke AB existing', 'qty', 2),
      jsonb_build_object('menu_item_id', smoke.fixture('item'), 'size_label', smoke.fixture_text('size'), 'ingredient', 'Smoke ab new', 'qty', 3))))) $$;

-- ── Fixtures: real menu rows, and stock that already exists live
do $$
declare
  v_item uuid; v_other uuid; v_option uuid; v_size text; v_existing uuid;
begin
  select m.id into v_item from menu_items m
   where exists (select 1 from menu_item_variants v where v.menu_item_id = m.id) order by m.sort_order, m.id limit 1;
  select m.id into v_other from menu_items m
   where m.id <> v_item and exists (select 1 from menu_item_variants v where v.menu_item_id = m.id) order by m.sort_order, m.id limit 1;
  select trim(label) into v_size from menu_item_variants where menu_item_id = v_item order by sort_order, id limit 1;
  select o.id into v_option from addon_options o order by o.sort_order, o.id limit 1;
  insert into smoke.fx values ('item', v_item), ('other', v_other), ('option', v_option), ('size', v_size);
  perform smoke.expect('fixtures: two menu items with sizes and an add-on option are loaded',
    v_item is not null and v_other is not null and v_option is not null and v_size is not null, format('%s / %s / %s / %s', v_item, v_other, v_option, v_size));

  -- What is live before any call: two stock items, a recipe and an add-on recipe that a seed must not touch
  -- unless it lists them, and auto-hide switched on.
  insert into inventory_items (name, unit, category, par_level, reorder_qty, tracks_expiry) values ('Smoke ab existing', 'g', 'Coffee', 5, 0, false) returning id into v_existing;
  insert into inventory_items (name, unit, category, par_level, reorder_qty, tracks_expiry) values ('Smoke ab keep', 'g', 'Packaging', 7, 4, true);
  perform inventory_set_recipe(v_item, null, jsonb_build_array(jsonb_build_object('size_label', '', 'item_id', v_existing, 'qty', 3)));
  perform inventory_set_addon_recipe_scopes(v_option, null, jsonb_build_array(jsonb_build_object('item_id', v_existing, 'qty', 1)));
  update store_settings set stock_auto_hide = true where is_singleton;
  perform smoke.expect('fixtures: auto-hide is on, no stock has been received, and there is no saved book',
    (select stock_auto_hide from store_settings where is_singleton limit 1) and not exists (select 1 from inventory_batches) and not exists (select 1 from inventory_recipe_book));
exception when others then
  perform smoke.expect('fixtures', false, sqlerrm);
end $$;

-- ── The function is there, once, with the arguments the script and seed.sql send
do $$
begin
  perform smoke.expect('inventory_apply_book(p_payload jsonb, p_doc jsonb, p_dry_run boolean default false) returns jsonb is installed, once',
    (select count(*) from pg_proc where proname = 'inventory_apply_book') = 1
    and exists (select 1 from pg_proc where proname = 'inventory_apply_book'
                  and pg_get_function_identity_arguments(oid) = 'p_payload jsonb, p_doc jsonb, p_dry_run boolean'
                  and prorettype = 'jsonb'::regtype and pronargdefaults = 1));
end $$;

-- ── SAVE ONLY: a null payload stores the book and changes nothing else
do $$
declare
  v_before text := smoke.fingerprint(); v_res jsonb; v_doc1 jsonb := smoke.doc('one'); v_doc2 jsonb := smoke.doc('two');
begin
  v_res := inventory_apply_book(null, v_doc1, false);
  perform smoke.expect('save-only: returns saved = true, save_only = true and nothing applied',
    v_res = jsonb_build_object('saved', true, 'stock_items', 0, 'recipes', 0, 'addon_recipes', 0, 'save_only', true), v_res::text);
  perform smoke.expect('save-only: the book is stored as sent, in the one row',
    smoke.book() = v_doc1 and (select count(*) from inventory_recipe_book) = 1);
  perform smoke.expect('save-only: no stock item, recipe, add-on recipe, setting or menu item changed (not even auto-hide)',
    smoke.fingerprint() = v_before and (select stock_auto_hide from store_settings where is_singleton limit 1));

  v_res := inventory_apply_book('null'::jsonb, v_doc2, false);
  perform smoke.expect('save-only: saving again replaces the book (still one row), and a JSON null payload counts as none',
    smoke.book() = v_doc2 and (select count(*) from inventory_recipe_book) = 1 and (v_res->>'save_only')::boolean and smoke.fingerprint() = v_before);
exception when others then
  perform smoke.expect('save-only', false, sqlerrm);
end $$;

-- ── What a call must send: a book document, and a payload with its three lists
do $$
declare
  v_book jsonb := smoke.book(); v_before text := smoke.fingerprint(); v_msg text;
begin
  perform smoke.expect('the book document is required (null)', smoke.attempt(null, null) = 'inventory seed: the book document is missing');
  perform smoke.expect('the book document is required (with a payload too)', smoke.attempt(smoke.good_payload(), null) = 'inventory seed: the book document is missing');
  perform smoke.expect('the book document is required (a JSON null)', smoke.attempt(null, 'null'::jsonb) = 'inventory seed: the book document is missing');
  perform smoke.expect('the book document must be an object', smoke.attempt(null, '[]'::jsonb) = 'inventory seed: the book document must be a JSON object');
  perform smoke.expect('the payload must be an object',
    smoke.attempt('[]'::jsonb, smoke.doc('x')) = 'inventory seed: the payload must be a JSON object with stock_items, recipes and addon_recipes lists');
  perform smoke.expect('payload.stock_items must be an array',
    smoke.attempt('{"stock_items": {}, "recipes": [], "addon_recipes": []}'::jsonb, smoke.doc('x')) = 'inventory seed: payload.stock_items must be a JSON array');
  perform smoke.expect('payload.recipes must be an array (a missing one is refused too)',
    smoke.attempt('{"stock_items": [], "addon_recipes": []}'::jsonb, smoke.doc('x')) = 'inventory seed: payload.recipes must be a JSON array');
  perform smoke.expect('payload.addon_recipes must be an array',
    smoke.attempt('{"stock_items": [], "recipes": [], "addon_recipes": "x"}'::jsonb, smoke.doc('x')) = 'inventory seed: payload.addon_recipes must be a JSON array');
  perform smoke.expect('...and none of those refusals saved the book or changed anything', smoke.book() = v_book and smoke.fingerprint() = v_before);
end $$;

-- ── DRY RUN: does every step, raises 'DRY RUN OK', and leaves no rows
do $$
declare
  v_before text := smoke.fingerprint(); v_counts text := smoke.counts(); v_book jsonb := smoke.book(); v_msg text;
begin
  v_msg := smoke.attempt(smoke.good_payload(), smoke.doc('dry'), true);
  perform smoke.expect('dry run: raises "DRY RUN OK (nothing was saved): <result>"',
    v_msg like 'DRY RUN OK (nothing was saved): {%}'
      and position('"saved": true' in v_msg) > 0 and position('"stock_items": 3' in v_msg) > 0 and position('"recipes": 1' in v_msg) > 0
      and position('"addon_recipes": 1' in v_msg) > 0 and position('"save_only": false' in v_msg) > 0, v_msg);
  perform smoke.expect('dry run: leaves no rows: no stock item, recipe or add-on line, setting change or saved book',
    smoke.fingerprint() = v_before and smoke.counts() = v_counts and smoke.book() is not distinct from v_book
    and not exists (select 1 from inventory_items where name = 'Smoke ab new')
    and (select stock_auto_hide from store_settings where is_singleton limit 1), smoke.counts());

  v_msg := smoke.attempt(null, smoke.doc('dry2'), true);
  perform smoke.expect('dry run, save-only: raises DRY RUN OK and does not save the book',
    v_msg like 'DRY RUN OK (nothing was saved): %"save_only": true%' and smoke.book() is not distinct from v_book, v_msg);

  -- A dry run runs the guards for real: one that would be refused is refused, not "OK".
  v_msg := smoke.attempt(smoke.payload('[]', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', 'Ghost item', 'lines', '[]'::jsonb))), smoke.doc('dry3'), true);
  perform smoke.expect('dry run: a payload the real call would refuse is refused with the same message',
    v_msg like 'inventory seed: menu items not found live%Ghost item%', v_msg);
end $$;

-- ── The guards refuse, in the seed's order, and roll everything back (the book too)
do $$
declare
  v_other uuid := smoke.fixture('other'); v_option uuid := smoke.fixture('option'); v_size text := smoke.fixture_text('size');
begin
  perform smoke.refused('guard: a menu item that is not live',
    smoke.payload(jsonb_build_array(smoke.stock('Smoke ab guard')),
                  jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', 'Ghost item', 'lines', '[]'::jsonb))),
    'inventory seed: menu items not found live%Ghost item (%)%');
  perform smoke.refused('guard: an add-on option that is not live',
    smoke.payload(jsonb_build_array(smoke.stock('Smoke ab guard')), '[]',
                  jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', 'Ghost add-on', 'lines', '[]'::jsonb))),
    'inventory seed: add-on options not found live%Ghost add-on (%)%');
  perform smoke.refused('guard: an add-on scope that names a menu item that is not live',
    smoke.payload(jsonb_build_array(smoke.stock('Smoke ab guard'), smoke.stock('Smoke ab keep')), '[]',
                  jsonb_build_array(jsonb_build_object('id', v_option, 'name', 'Scoped add-on', 'lines', jsonb_build_array(
                    jsonb_build_object('menu_item_id', gen_random_uuid(), 'size_label', '', 'ingredient', 'Smoke ab keep', 'qty', 1))))),
    'inventory seed: add-on scopes name menu items not found live%Scoped add-on (%)%');
  perform smoke.refused('guard: a unit that differs from the live stock item (matched regardless of case)',
    smoke.payload(jsonb_build_array(smoke.stock('smoke AB existing', 'kg'))),
    'inventory seed: unit differs from the live stock item: Smoke ab existing (live g, book kg)');
  perform smoke.refused('guard: the unit guard comes before the existence guards',
    smoke.payload(jsonb_build_array(smoke.stock('Smoke ab existing', 'kg')),
                  jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', 'Ghost item', 'lines', '[]'::jsonb))),
    'inventory seed: unit differs from the live stock item:%');
  perform smoke.refused('guard: a recipe line that names a stock item that does not exist',
    smoke.payload('[]', jsonb_build_array(jsonb_build_object('id', v_other, 'name', 'Other item', 'lines', jsonb_build_array(
      jsonb_build_object('size_label', '', 'ingredient', 'Ghost ingredient', 'qty', 1))))),
    'inventory seed: a line of "Other item" names a stock item that does not exist');
  perform smoke.refused('guard: an add-on line that names a stock item that does not exist',
    smoke.payload('[]', '[]', jsonb_build_array(jsonb_build_object('id', v_option, 'name', 'Group › Option', 'lines', jsonb_build_array(
      jsonb_build_object('menu_item_id', null, 'size_label', '', 'ingredient', 'Ghost ingredient', 'qty', 1))))),
    'inventory seed: a line of "Group › Option" names a stock item that does not exist');
  perform smoke.refused('recipe: a size the menu item does not have is refused by inventory_set_recipe',
    smoke.payload(jsonb_build_array(smoke.stock('Smoke ab keep')),
                  jsonb_build_array(jsonb_build_object('id', v_other, 'name', 'Other item', 'lines', jsonb_build_array(
                    jsonb_build_object('size_label', 'No Such Size', 'ingredient', 'Smoke ab keep', 'qty', 1))))),
    'inventory: that size does not belong to this menu item');
  perform smoke.refused('add-on: a size the scoped menu item does not have is refused by inventory_set_addon_recipe_scopes',
    smoke.payload(jsonb_build_array(smoke.stock('Smoke ab keep')), '[]',
                  jsonb_build_array(jsonb_build_object('id', v_option, 'name', 'Group › Option', 'lines', jsonb_build_array(
                    jsonb_build_object('menu_item_id', smoke.fixture('item'), 'size_label', 'No Such Size', 'ingredient', 'Smoke ab keep', 'qty', 1))))),
    'inventory: that size does not belong to this menu item');
exception when others then
  perform smoke.expect('guards', false, sqlerrm);
end $$;

-- ── A real apply: the seed's steps 1 to 5, and idempotent
do $$
declare
  v_item uuid := smoke.fixture('item'); v_other uuid := smoke.fixture('other'); v_option uuid := smoke.fixture('option'); v_size text := smoke.fixture_text('size');
  v_res jsonb; v_counts text; v_n int; v_rec record;
begin
  v_res := inventory_apply_book(smoke.good_payload(), smoke.doc('applied'), false);
  perform smoke.expect('apply: returns { saved, stock_items, recipes, addon_recipes, save_only: false }',
    v_res = jsonb_build_object('saved', true, 'stock_items', 3, 'recipes', 1, 'addon_recipes', 1, 'save_only', false), v_res::text);
  perform smoke.expect('apply (step 0): the book is saved with it', smoke.book() = smoke.doc('applied') and (select count(*) from inventory_recipe_book) = 1);

  perform smoke.expect('apply (step 3): a new stock item is added',
    exists (select 1 from inventory_items where name = 'Smoke ab new' and unit = 'g' and category = 'Coffee' and is_active));
  select count(*) into v_n from inventory_items where lower(trim(name)) = 'smoke ab existing';
  select * into v_rec from inventory_items where lower(trim(name)) = 'smoke ab existing';
  perform smoke.expect('apply (step 3): an existing item is matched by name regardless of case and padding, not duplicated, its unit kept, its par / category / expiry updated',
    v_n = 1 and v_rec.name = 'Smoke ab existing' and v_rec.unit = 'g' and v_rec.par_level = 9 and v_rec.category = 'Bakery' and v_rec.tracks_expiry,
    format('%s row(s); %s %s par %s %s expiry %s', v_n, v_rec.name, v_rec.unit, v_rec.par_level, v_rec.category, v_rec.tracks_expiry));
  select * into v_rec from inventory_items where name = 'Smoke ab keep';
  perform smoke.expect('apply (step 3): a par / reorder of 0 and a blank category leave the live values alone',
    v_rec.par_level = 7 and v_rec.reorder_qty = 4 and v_rec.category = 'Packaging', format('par %s reorder %s category %s', v_rec.par_level, v_rec.reorder_qty, v_rec.category));

  perform smoke.expect('apply (step 5): the listed recipe is saved through inventory_set_recipe',
    (select count(*) from recipe_lines where menu_item_id = v_other) = 1
    and exists (select 1 from recipe_lines rl join inventory_items i on i.id = rl.item_id where rl.menu_item_id = v_other and i.name = 'Smoke ab new' and rl.qty = 4 and rl.size_label = ''));
  perform smoke.expect('apply (step 5): a recipe that is not listed is left alone',
    (select count(*) from recipe_lines where menu_item_id = v_item) = 1
    and exists (select 1 from recipe_lines rl join inventory_items i on i.id = rl.item_id where rl.menu_item_id = v_item and i.name = 'Smoke ab existing' and rl.qty = 3));
  perform smoke.expect('apply (step 5): the add-on''s WHOLE recipe is replaced, general line and scope, through inventory_set_addon_recipe_scopes',
    (select count(*) from addon_recipe_lines where addon_option_id = v_option) = 2
    and exists (select 1 from addon_recipe_lines l join inventory_items i on i.id = l.item_id
                 where l.addon_option_id = v_option and l.menu_item_id is null and l.size_label = '' and i.name = 'Smoke ab existing' and l.qty = 2)
    and exists (select 1 from addon_recipe_lines l join inventory_items i on i.id = l.item_id
                 where l.addon_option_id = v_option and l.menu_item_id = v_item and l.size_label = v_size and i.name = 'Smoke ab new' and l.qty = 3));
  perform smoke.expect('apply (step 1): no stock has ever been received, so auto-hide is switched off',
    not (select stock_auto_hide from store_settings where is_singleton limit 1));

  v_counts := smoke.counts();
  perform inventory_apply_book(smoke.good_payload(), smoke.doc('applied'), false);
  perform smoke.expect('apply: applying again is idempotent (no row count changes)', smoke.counts() = v_counts, smoke.counts() || ' vs ' || v_counts);

  -- Step 1 only fires while no stock has been received.
  update store_settings set stock_auto_hide = true where is_singleton;
  insert into inventory_batches (item_id, qty_received, qty_remaining, source) select id, 10, 10, 'receive' from inventory_items where name = 'Smoke ab keep';
  perform inventory_apply_book(smoke.good_payload(), smoke.doc('applied'), false);
  perform smoke.expect('apply (step 1): once stock has been received, the auto-hide setting is left as it is',
    (select stock_auto_hide from store_settings where is_singleton limit 1));
exception when others then
  perform smoke.expect('apply', false, sqlerrm);
end $$;

-- ── Lock-down: anon and authenticated cannot execute it; the service role runs all of it
-- try_as runs one statement as a role and says what happened. A failure to SET ROLE
-- itself is NOT swallowed: it would read as "denied" and hide a hole.
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
  r text; v_res text; v_open text := '';
  v_call text := 'select inventory_apply_book(null, ''{"version": 1}''::jsonb, true)';
begin
  perform smoke.expect('lock-down: anon, authenticated and PUBLIC have no execute privilege on inventory_apply_book; the service role has',
    not has_function_privilege('anon', 'inventory_apply_book(jsonb, jsonb, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'inventory_apply_book(jsonb, jsonb, boolean)', 'execute')
    and has_function_privilege('service_role', 'inventory_apply_book(jsonb, jsonb, boolean)', 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where p.oid = 'inventory_apply_book(jsonb, jsonb, boolean)'::regprocedure and a.grantee = 0));

  foreach r in array array['anon', 'authenticated'] loop
    v_res := smoke.try_as(r, v_call);
    if v_res <> 'denied' then v_open := v_open || format(' [%s => %s]', r, v_res); end if;
    v_res := smoke.try_as(r, format('select inventory_apply_book(%L::jsonb, %L::jsonb, true)', smoke.good_payload()::text, smoke.doc('anon')::text));
    if v_res <> 'denied' then v_open := v_open || format(' [%s, payload => %s]', r, v_res); end if;
  end loop;
  perform smoke.expect('lock-down: anon and authenticated cannot call inventory_apply_book (permission denied)',
    v_open = '', case when v_open = '' then 'permission denied for all 4 probes' else 'OPEN:' || v_open end);

  -- As the service role: every step runs (a dry run writes, then raises), and a real call is allowed.
  v_res := smoke.try_as('service_role', format('select inventory_apply_book(%L::jsonb, %L::jsonb, true)', smoke.good_payload()::text, smoke.doc('svc')::text));
  perform smoke.expect('lock-down: the service role can run every step (a dry run reaches "DRY RUN OK")', v_res like 'ran: DRY RUN OK (nothing was saved): %', v_res);
  v_res := smoke.try_as('service_role', format('select inventory_apply_book(%L::jsonb, %L::jsonb, false)', smoke.good_payload()::text, smoke.doc('svc')::text));
  perform smoke.expect('lock-down: the service role can apply for real', v_res = 'allowed', v_res);
  v_res := smoke.try_as('service_role', 'select inventory_apply_book(null, ''{"version": 1}''::jsonb, false)');
  perform smoke.expect('lock-down: the service role can save the book only', v_res = 'allowed', v_res);
exception when others then
  perform smoke.expect('lock-down', false, sqlerrm);
end $$;
SQL
  run_assertions "" "$BASE/applybook.sql"
else
  step "5c/6" "inventory_apply_book — skipped (the migrations or the menu did not load)"
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
