#!/usr/bin/env bash
# Moves the HIOC Supabase database from the Seoul project to a new, EMPTY
# project in Mumbai (docs/DB-REGION-MOVE.md). Run by
# .github/workflows/supabase-region-move.yml; every input is an env var:
#
#   MODE              check | rehearse | migrate | storage
#   CONFIRM           must be "MIGRATE" when MODE=migrate
#   OLD_DB_URL        Seoul  — Session pooler connection string
#   NEW_DB_URL        Mumbai — Session pooler connection string
#   OLD_SUPABASE_URL  https://<seoul-ref>.supabase.co
#   NEW_SUPABASE_URL  https://<mumbai-ref>.supabase.co
#   OLD_SERVICE_KEY   Seoul's secret (sb_secret_…) or service_role key   } migrate,
#   NEW_SERVICE_KEY   Mumbai's secret (sb_secret_…) or service_role key  } storage
#   CRON_SECRET       the app's CRON_SECRET, sealed into the new project's Vault
#
#   check     read-only: connects to both projects, checks Mumbai is empty.
#   rehearse  check, then the full dump of Seoul restored into a throwaway
#             local Supabase on the runner, with row counts compared. Neither
#             real project is written to.
#   migrate   check, then the same dump restored into Mumbai in ONE
#             transaction (all or nothing), storage files copied, row counts
#             compared.
#   storage   only the last two steps of migrate, for when the restore
#             committed but the file copy or the count check did not finish.
#             Safe to repeat: uploads overwrite.
#
# Seoul is only ever read. The dumps contain customer data, so they live in a
# temp dir on the runner and are deleted on exit, never uploaded.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

die() { echo "::error::$*" >&2; exit 1; }
q() { psql "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "$2"; }

case "${MODE:-}" in check|rehearse|migrate|storage) ;; *) die "MODE must be check, rehearse, migrate or storage" ;; esac
for v in OLD_DB_URL NEW_DB_URL OLD_SUPABASE_URL NEW_SUPABASE_URL CRON_SECRET; do
  [ -n "${!v:-}" ] || die "secret $v is not set"
done
OLD_SUPABASE_URL="${OLD_SUPABASE_URL%/}"
NEW_SUPABASE_URL="${NEW_SUPABASE_URL%/}"

# --- guards: the right projects, the right way round -------------------------
# Pooler strings log in as postgres.<project-ref>; the direct ones don't, and
# GitHub's runners can't reach the direct (IPv6-only) address anyway.
ref_of() { sed -nE 's#^postgres(ql)?://postgres\.([a-z0-9]{20}):.*#\2#p' <<<"$1"; }
old_ref="$(ref_of "$OLD_DB_URL")"
new_ref="$(ref_of "$NEW_DB_URL")"
[ -n "$old_ref" ] && [ -n "$new_ref" ] ||
  die "use each project's Session pooler connection string (user postgres.<project-ref>)"
[ "$old_ref" != "$new_ref" ] || die "OLD_DB_URL and NEW_DB_URL are the same project"
[[ "$OLD_SUPABASE_URL" == "https://$old_ref.supabase.co" ]] || die "OLD_SUPABASE_URL is not project $old_ref"
[[ "$NEW_SUPABASE_URL" == "https://$new_ref.supabase.co" ]] || die "NEW_SUPABASE_URL is not project $new_ref"
[[ "$NEW_DB_URL" == *ap-south-1* ]] || die "NEW_DB_URL is not in ap-south-1 (Mumbai)"
q "$OLD_DB_URL" "select 1" >/dev/null || die "cannot connect to Seoul with OLD_DB_URL"
q "$NEW_DB_URL" "select 1" >/dev/null || die "cannot connect to Mumbai with NEW_DB_URL"

state() {
  q "$1" "select (select count(*) from information_schema.tables where table_schema = 'public') || ' public tables, '
             || (select count(*) from auth.users) || ' users, '
             || (select count(*) from storage.objects) || ' stored files, '
             || pg_size_pretty(pg_database_size(current_database()))"
}
echo "Seoul  $old_ref: $(state "$OLD_DB_URL")"
echo "Mumbai $new_ref: $(state "$NEW_DB_URL")"
echo "Seoul scheduled jobs:"
q "$OLD_DB_URL" "select '  ' || jobname || '  ' || schedule || '  active=' || active from cron.job order by jobid"

# --- row counts: every table we copy, listed from Seoul's catalog -------------
# Our own schemas whole, plus the rows that matter in Supabase's (users,
# identities, buckets, files). Partitions are counted through their parent.
q "$OLD_DB_URL" "
  select string_agg(format('select %L as t, count(*) as n from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname),
                    ' union all ' order by n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and not c.relispartition
    and (   (n.nspname, c.relname) in (('auth', 'users'), ('auth', 'identities'), ('storage', 'buckets'), ('storage', 'objects'))
         or (n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'auth', 'storage', 'realtime', 'vault', 'cron',
             'net', 'extensions', 'graphql', 'graphql_public', 'pgbouncer', 'supabase_functions', 'supabase_migrations')))" \
  >"$work/count.sql"
counts() { q "$1" "select t || ' ' || n from ($(cat "$work/count.sql")) x order by 1"; }

# A query that fails must stop the run, never read as "empty" or "not empty".
target_empty() {
  local n
  n="$(q "$1" "select (select count(*) from information_schema.tables where table_schema = 'public')
                    + (select count(*) from auth.users)")" || die "cannot read the Mumbai project"
  [ "$n" = 0 ]
}

copy_storage() {
  echo "== Copying storage files"
  q "$OLD_DB_URL" "select bucket_id || E'\t' || name || E'\t' || coalesce(metadata->>'mimetype', '')
                   from storage.objects where name not like '%.emptyFolderPlaceholder' order by 1" |
    node "$here/copy-storage.mjs"
}

compare() { # <target db url> <fail on difference: yes|no>
  counts "$1" >"$work/counts.new"
  if diff -u "$work/counts.old" "$work/counts.new" >"$work/counts.diff"; then
    echo "row counts match: $(wc -l <"$work/counts.old") tables"
  else
    echo "row count differences (- Seoul, + copy):"
    grep -E '^[-+][a-z]' "$work/counts.diff" || true
    [ "$2" = no ] || die "row counts differ; do not switch the app over"
  fi
}

if [ "$MODE" = migrate ] || [ "$MODE" = storage ]; then
  [ -n "${OLD_SERVICE_KEY:-}" ] && [ -n "${NEW_SERVICE_KEY:-}" ] || die "OLD_SERVICE_KEY and NEW_SERVICE_KEY are needed to copy storage"
fi
if [ "$MODE" = storage ]; then
  target_empty "$NEW_DB_URL" && die "the Mumbai project is empty: run migrate first"
  counts "$OLD_DB_URL" >"$work/counts.old"
  copy_storage
  compare "$NEW_DB_URL" yes
  exit 0
fi

target_empty "$NEW_DB_URL" || die "the Mumbai project is not empty; migrate only ever fills an empty one (use storage to finish a copy)"
[ "$MODE" = check ] && { echo "check passed"; exit 0; }
[ "$MODE" = migrate ] && [ "${CONFIRM:-}" != MIGRATE ] && die 'type MIGRATE in the "confirm" box to run the real copy'

# --- dump Seoul ------------------------------------------------------------------
echo "== Dumping Seoul (read-only)"
counts "$OLD_DB_URL" >"$work/counts.old"
supabase db dump --db-url "$OLD_DB_URL" -f "$work/roles.sql" --role-only
supabase db dump --db-url "$OLD_DB_URL" -f "$work/schema.sql"
# cron.job_run_details is pg_cron's run log: history only, not worth copying.
supabase db dump --db-url "$OLD_DB_URL" -f "$work/data.sql" --use-copy --data-only -x cron.job_run_details
# The jobs exactly as Seoul runs them. Re-created switched OFF: they call
# https://hioc.in, which keeps using Seoul until the app is switched over.
q "$OLD_DB_URL" "select format('select cron.schedule(%L, %L, %L);', jobname, schedule, command) from cron.job order by jobid" \
  >"$work/cron.sql"
ls -l "$work"/*.sql | awk '{print "  " $5 " bytes  " $NF}'

# --- restore: one transaction, so a failure leaves the target untouched ----------
restore() { # <target db url> <target project url>
  psql "$1" -X -q --single-transaction -v ON_ERROR_STOP=1 \
    -v old_url="$OLD_SUPABASE_URL" -v new_url="$2" -v cron_secret="$CRON_SECRET" \
    -c 'set statement_timeout = 0' \
    -f "$work/roles.sql" \
    -f "$work/schema.sql" \
    -c 'set session_replication_role = replica' \
    -f "$work/data.sql" \
    -c 'set session_replication_role = origin' \
    -f "$here/post-restore.sql" \
    -f "$work/cron.sql" \
    -c 'select cron.alter_job(jobid, active := false) from cron.job' >/dev/null
}

if [ "$MODE" = rehearse ]; then
  echo "== Rehearsal: restoring into a local Supabase on this runner"
  mkdir "$work/local"
  (cd "$work/local" && supabase init </dev/null >/dev/null &&
    supabase start -x studio,imgproxy,edge-runtime,logflare,vector,postgres-meta >/dev/null)
  local_db="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  restore "$local_db" "http://127.0.0.1:54321"
  # Seoul is live during a daytime rehearsal, so a few busy tables may have
  # moved on since the dump; differences are reported, not fatal.
  compare "$local_db" no
  echo "rehearsal passed: the dump restores cleanly"
  exit 0
fi

echo "== Restoring into Mumbai"
restore "$NEW_DB_URL" "$NEW_SUPABASE_URL"
copy_storage
compare "$NEW_DB_URL" yes
cat <<EOF
Mumbai now holds a full copy of Seoul. Its scheduled jobs are created but
switched OFF. Next: docs/DB-REGION-MOVE.md, cutover step 4.
EOF
