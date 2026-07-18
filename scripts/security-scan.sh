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

# --- tiny output helpers ---------------------------------------------------
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
hdr()   { printf '\n\033[1m%s\033[0m\n' "$*"; }

crit() { red   "  CRITICAL [$1] $2"; CRIT=$((CRIT+1)); }
warn() { yellow "  WARN [$1] $2";     WARN=$((WARN+1)); }

hdr "HIOC security scan — $(date '+%Y-%m-%d %H:%M')"

# ===========================================================================
# C-1  Service-role admin client must NEVER be imported by a client component.
#      A 'use client' file bundling createAdminSupabaseClient would ship the
#      service-role key to the browser. This is the single worst possible bug.
# ===========================================================================
hdr "C-1  service-role key never reaches the client"
c1_hits=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # A file is a client component if its FIRST non-empty line is 'use client'.
  if head -3 "$f" | grep -qE "^['\"]use client['\"]"; then
    crit C-1 "$f imports createAdminSupabaseClient in a 'use client' file"
    c1_hits=$((c1_hits+1))
  fi
done < <(grep -rl "createAdminSupabaseClient" app components lib --include="*.ts" --include="*.tsx" 2>/dev/null)
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
  if grep -q "export async function POST" "$f" && ! grep -q "rateLimitOk" "$f"; then
    warn C-2 "$f has a POST handler but no rateLimitOk() throttle"
    c2_hits=$((c2_hits+1))
  fi
done < <(find "$API_DIR/auth" -name route.ts 2>/dev/null)
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
  grep -q "createAdminSupabaseClient" "$f" || continue
  # A successful verifyOtp() IS the authentication gate for the OTP routes.
  if grep -qE "getStaffUser|getOwnerUser|getManagerUser|getAuthUser|getStaffOrOwner|CRON_SECRET|isUuid\(|verifyOtp\(" "$f"; then
    continue
  fi
  warn C-3 "$f uses the admin client with no recognised auth/opaque-id gate — confirm it is intentional"
  c3_hits=$((c3_hits+1))
done < <(find "$API_DIR" -name route.ts 2>/dev/null)
[ "$c3_hits" -eq 0 ] && green "  ok — every admin-client route has a recognised gate"

# ===========================================================================
# C-4  Secret checks must fail CLOSED. `if (secret) { ...check... }` skips the
#      check when the secret is unset (review finding S2). The correct shape is
#      `if (!secret || <mismatch>) return 401`.
# ===========================================================================
hdr "C-4  secret checks fail closed"
if grep -rnE "if \(secret\) \{" "$API_DIR" --include="*.ts" >/tmp/hioc_c4 2>/dev/null && [ -s /tmp/hioc_c4 ]; then
  while IFS= read -r line; do crit C-4 "$line  (fail-open secret check — use: if (!secret || ...) return 401)"; done < /tmp/hioc_c4
else
  green "  ok — no fail-open 'if (secret)' guards"
fi
rm -f /tmp/hioc_c4

# ===========================================================================
# C-5  Sessions must be validated with getUser() (re-verifies the JWT), never
#      getSession() (trusts an unverified cookie) for authorization.
# ===========================================================================
hdr "C-5  no getSession() used for authorization"
if grep -rn "auth.getSession()" app lib --include="*.ts" --include="*.tsx" >/tmp/hioc_c5 2>/dev/null && [ -s /tmp/hioc_c5 ]; then
  while IFS= read -r line; do warn C-5 "$line  (prefer getUser() for auth decisions)"; done < /tmp/hioc_c5
else
  green "  ok — authorization uses getUser()"
fi
rm -f /tmp/hioc_c5

# ===========================================================================
# C-6  No XSS sinks.
# ===========================================================================
hdr "C-6  no XSS / code-eval sinks"
if grep -rnE "dangerouslySetInnerHTML|[^a-zA-Z]eval\(|new Function\(" app components lib --include="*.ts" --include="*.tsx" >/tmp/hioc_c6 2>/dev/null && [ -s /tmp/hioc_c6 ]; then
  while IFS= read -r line; do crit C-6 "$line"; done < /tmp/hioc_c6
else
  green "  ok — no dangerouslySetInnerHTML / eval / new Function"
fi
rm -f /tmp/hioc_c6

# ===========================================================================
# C-7  No raw SQL string interpolation (SQL injection). Flags template literals
#      or string concatenation feeding .rpc()/.sql() calls. supabase-js query
#      builders are parameterized and safe.
# ===========================================================================
hdr "C-7  no string-built SQL"
if grep -rnE "\.(rpc|sql)\(\s*\`" lib app --include="*.ts" >/tmp/hioc_c7 2>/dev/null && [ -s /tmp/hioc_c7 ]; then
  while IFS= read -r line; do warn C-7 "$line  (verify no untrusted interpolation into SQL)"; done < /tmp/hioc_c7
else
  green "  ok — no template-literal SQL calls"
fi
rm -f /tmp/hioc_c7

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
if grep -rnE "eyJ[A-Za-z0-9_-]{30,}" app lib components --include="*.ts" --include="*.tsx" >/tmp/hioc_c8 2>/dev/null && [ -s /tmp/hioc_c8 ]; then
  while IFS= read -r line; do crit C-8 "$line  (possible hardcoded JWT/secret)"; done < /tmp/hioc_c8
  c8_hits=$((c8_hits+1))
fi
rm -f /tmp/hioc_c8
[ "$c8_hits" -eq 0 ] && green "  ok — no tracked .env files, no hardcoded JWTs in source"

# ===========================================================================
# Summary
# ===========================================================================
hdr "Summary"
printf '  CRITICAL failures: %s\n' "$CRIT"
printf '  WARN / review:     %s\n' "$WARN"
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
