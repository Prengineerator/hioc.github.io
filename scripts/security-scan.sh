#!/usr/bin/env bash
#
# HIOC deterministic security scanner.
#
# Purpose: encode the review's known-bad patterns as grep checks so a CHEAP model
# (or CI) can run it, read the labelled output, and act with high accuracy — no
# judgement calls, no whole-file reading required. Every finding prints the file,
# line, the rule id, and a one-line "what to do".
#
# Usage:   bash scripts/security-scan.sh
# CI:      exits 1 if any CRITICAL check fails, else 0. WARN/REVIEW never fail CI.
#
# This is a static linter, not a proof of safety. It catches regressions of the
# specific issues found in docs/SECURITY-REVIEW-2026-07.md. Extend it when a new
# class of bug is found — see docs/SECURITY-PLAYBOOK.md.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

ROOT="$(pwd)"
CRIT=0
WARN=0
API_DIR="app/api"

# --- how the rules read the code -------------------------------------------
# Every kind of source file the build would compile, not only .ts and .tsx. A
# rule that looked at TypeScript alone missed the same code in a .js or .jsx.
SRC=(--include="*.ts" --include="*.tsx" --include="*.mts" --include="*.cts"
     --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs")

# grep flags used by every content rule:
#   -a  read every file as text. Without it, grep reports a file holding a NUL
#       byte or a byte that is not valid in the current locale as "binary file
#       matches" on stderr and prints no line, so one stray byte in a file
#       would hide every finding in it.
#   -r  recurse WITHOUT following symbolic links. A link can point anywhere:
#       at a file outside the repository, whose matching lines the scanner
#       would then print, or at a device that never ends. Links are never read.
#       Rule C-0 below reports every one of them instead.

# A private scratch directory. Fixed names under /tmp could already exist (as a
# directory, or owned by someone else), which made the redirect fail and the
# rule print "ok".
TMP="$(mktemp -d)" || { echo "security-scan: cannot create a scratch directory" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT

# run_grep <output file> <grep arguments...>
# Writes the matches to the file and is true when there is at least one. A grep
# that fails outright (exit status above 1) is counted, and the summary then
# fails: a rule that could not run must never read as a clean one.
SCAN_ERRORS=0
run_grep() {
  local out="$1"; shift
  grep "$@" > "$out" 2>/dev/null
  local rc=$?
  if [ "$rc" -gt 1 ] || [ ! -f "$out" ]; then SCAN_ERRORS=$((SCAN_ERRORS+1)); fi
  [ -s "$out" ]
}

# --- tiny output helpers ---------------------------------------------------
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
hdr()   { printf '\n\033[1m%s\033[0m\n' "$*"; }

crit() { red   "  CRITICAL [$1] $2"; CRIT=$((CRIT+1)); }
warn() { yellow "  WARN [$1] $2";     WARN=$((WARN+1)); }

hdr "HIOC security scan — $(date '+%Y-%m-%d %H:%M')"

# ===========================================================================
# C-0  No symbolic links in the source directories. The rules below do not read
#      through a link, so code behind one would go unchecked, and a link can
#      point at a file outside the repository. Checked first, before any file
#      is read. If one of the directories the rules are pointed at is itself a
#      link, nothing is read at all.
# ===========================================================================
hdr "C-0  no symbolic links in source directories"
c0_hits=0
linked_root=0
for d in app components lib "$API_DIR"; do
  if [ -L "$d" ]; then
    crit C-0 "$d is a symbolic link — a source directory must be a real directory"
    c0_hits=$((c0_hits+1))
    linked_root=1
  fi
done
if [ "$linked_root" -eq 0 ]; then
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    crit C-0 "$l is a symbolic link — replace it with the real file"
    c0_hits=$((c0_hits+1))
  done < <(find app components lib -type l 2>/dev/null | sort)
fi
[ "$c0_hits" -eq 0 ] && green "  ok — no symbolic links under app, components or lib"
if [ "$linked_root" -ne 0 ]; then
  hdr "Summary"
  printf '  CRITICAL failures: %s\n' "$CRIT"
  printf '  WARN / review:     %s\n' "$WARN"
  printf '  Checks that could not run: %s\n' "$SCAN_ERRORS"
  red   "  RESULT: FAIL — a source directory is a symbolic link, so no file was read. Fix that first."
  exit 1
fi

# ===========================================================================
# C-1  Service-role admin client must NEVER be imported by a client component.
#      A 'use client' file bundling createAdminSupabaseClient would ship the
#      service-role key to the browser. This is the single worst possible bug.
# ===========================================================================
hdr "C-1  service-role key never reaches the client"
c1_hits=0
run_grep "$TMP/c1" -arl "createAdminSupabaseClient" app components lib "${SRC[@]}"
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # A file is a client component if its FIRST non-empty line is 'use client'.
  if head -3 "$f" | grep -qE "^['\"]use client['\"]"; then
    crit C-1 "$f imports createAdminSupabaseClient in a 'use client' file"
    c1_hits=$((c1_hits+1))
  fi
done < "$TMP/c1"
[ "$c1_hits" -eq 0 ] && green "  ok — no client component imports the admin client"

# ===========================================================================
# C-2  Every auth route (app/api/auth/**) that performs a login/signup/verify
#      POST must call rateLimitOk(). Missing = brute-force / bombing surface
#      (review finding S1).
# ===========================================================================
hdr "C-2  auth routes are rate-limited"
c2_hits=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # logout only clears cookies — no credential surface, exempt by design.
  case "$f" in */logout/*) continue;; esac
  if grep -aq "export async function POST" "$f" && ! grep -aq "rateLimitOk" "$f"; then
    warn C-2 "$f has a POST handler but no rateLimitOk() throttle"
    c2_hits=$((c2_hits+1))
  fi
done < <(find "$API_DIR/auth" -type f -name 'route.*' 2>/dev/null)
[ "$c2_hits" -eq 0 ] && green "  ok — every auth POST route is throttled"

# ===========================================================================
# C-3  Any route that uses the admin (service-role) client must have an auth
#      gate OR be an intentional public-by-opaque-id route. Flags routes that
#      use the admin client with NO recognised gate for human review.
#      Recognised gates: getStaffUser/getOwnerUser/getManagerUser/getAuthUser/
#      getStaffOrOwner, a CRON_SECRET check, or an isUuid() opaque-id lookup.
# ===========================================================================
hdr "C-3  admin-client routes have an access gate"
c3_hits=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  grep -aq "createAdminSupabaseClient" "$f" || continue
  # A successful verifyOtp() IS the authentication gate for the OTP routes.
  if grep -aqE "getStaffUser|getOwnerUser|getManagerUser|getAuthUser|getStaffOrOwner|CRON_SECRET|isUuid\(|verifyOtp\(" "$f"; then
    continue
  fi
  warn C-3 "$f uses the admin client with no recognised auth/opaque-id gate — confirm it is intentional"
  c3_hits=$((c3_hits+1))
done < <(find "$API_DIR" -type f -name 'route.*' 2>/dev/null)
[ "$c3_hits" -eq 0 ] && green "  ok — every admin-client route has a recognised gate"

# ===========================================================================
# C-4  Secret checks must fail CLOSED. `if (secret) { ...check... }` skips the
#      check when the secret is unset (review finding S2). The correct shape is
#      `if (!secret || <mismatch>) return 401`.
# ===========================================================================
hdr "C-4  secret checks fail closed"
if run_grep "$TMP/c4" -arnE "if \(secret\) \{" "$API_DIR" "${SRC[@]}"; then
  while IFS= read -r line; do crit C-4 "$line  (fail-open secret check — use: if (!secret || ...) return 401)"; done < "$TMP/c4"
else
  green "  ok — no fail-open 'if (secret)' guards"
fi

# ===========================================================================
# C-5  Sessions must be validated with getUser() (re-verifies the JWT), never
#      getSession() (trusts an unverified cookie) for authorization.
# ===========================================================================
hdr "C-5  no getSession() used for authorization"
if run_grep "$TMP/c5" -arn "auth.getSession()" app lib "${SRC[@]}"; then
  while IFS= read -r line; do warn C-5 "$line  (prefer getUser() for auth decisions)"; done < "$TMP/c5"
else
  green "  ok — authorization uses getUser()"
fi

# ===========================================================================
# C-6  No XSS sinks.
# ===========================================================================
hdr "C-6  no XSS / code-eval sinks"
if run_grep "$TMP/c6" -arnE "dangerouslySetInnerHTML|(^|[^a-zA-Z])eval\(|new Function\(" app components lib "${SRC[@]}"; then
  while IFS= read -r line; do crit C-6 "$line"; done < "$TMP/c6"
else
  green "  ok — no dangerouslySetInnerHTML / eval / new Function"
fi

# ===========================================================================
# C-7  No raw SQL string interpolation (SQL injection). Flags template literals
#      or string concatenation feeding .rpc()/.sql() calls. supabase-js query
#      builders are parameterized and safe.
# ===========================================================================
hdr "C-7  no string-built SQL"
if run_grep "$TMP/c7" -arnE "\.(rpc|sql)\(\s*\`" lib app "${SRC[@]}"; then
  while IFS= read -r line; do warn C-7 "$line  (verify no untrusted interpolation into SQL)"; done < "$TMP/c7"
else
  green "  ok — no template-literal SQL calls"
fi

# ===========================================================================
# C-8  No secrets committed. .env*.local must be git-ignored; no service-role
#      key literals in source.
# ===========================================================================
hdr "C-8  no committed secrets"
c8_hits=0
if git ls-files 2>/dev/null | grep -qE "\.env(\..*)?\.local$|\.env$"; then
  crit C-8 "an .env file is tracked in git — it must be git-ignored"
  c8_hits=$((c8_hits+1))
fi
# service-role JWTs are long base64 'eyJ...' literals; flag any outside env examples.
if run_grep "$TMP/c8" -arnE "eyJ[A-Za-z0-9_-]{30,}" app lib components "${SRC[@]}"; then
  while IFS= read -r line; do crit C-8 "$line  (possible hardcoded JWT/secret)"; done < "$TMP/c8"
  c8_hits=$((c8_hits+1))
fi
[ "$c8_hits" -eq 0 ] && green "  ok — no tracked .env files, no hardcoded JWTs in source"

# ===========================================================================
# Summary
# ===========================================================================
hdr "Summary"
printf '  CRITICAL failures: %s\n' "$CRIT"
printf '  WARN / review:     %s\n' "$WARN"
printf '  Checks that could not run: %s\n' "$SCAN_ERRORS"
if [ "$SCAN_ERRORS" -gt 0 ]; then
  red   "  RESULT: FAIL — $SCAN_ERRORS check(s) could not run, so this is not a clean result. Fix the cause and run again."
  exit 1
fi
if [ "$CRIT" -gt 0 ]; then
  red   "  RESULT: FAIL — fix all CRITICAL items before deploy (see docs/SECURITY-PLAYBOOK.md)."
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  yellow "  RESULT: PASS with warnings — review each WARN (may be an intentional public route)."
  exit 0
fi
green "  RESULT: PASS — no known-bad patterns found."
exit 0
