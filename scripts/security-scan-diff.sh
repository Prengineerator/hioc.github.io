#!/usr/bin/env bash
# ===========================================================================
# security-scan-diff — did this change add a security finding?
#
# scripts/security-scan.sh answers "is the whole codebase clean". This script
# answers the question a reviewer or CI needs for one change: does the working
# tree have a CRITICAL or WARN finding that the base branch does not? It is the
# gate every pull request and every agent change passes (docs/SECURITY-PLAYBOOK.md,
# docs/AGENT-TEAM.md), and it keeps working while older findings on the base are
# still being reviewed.
#
# Usage:   bash scripts/security-scan-diff.sh [base-ref]     (default: origin/main)
#   exit 0 — no new findings.
#   exit 1 — the change adds at least one finding. Each is printed.
#   exit 2 — the comparison could not run (unknown base ref, not a git checkout).
#            Never treat this as a pass.
#
# How it compares:
#   * The base is checked out into a temporary worktree and scanned with THIS
#     tree's copy of the scanner. A change therefore cannot hide a finding by
#     weakening the scanner, and a new rule does not blame the change for
#     findings the base already had.
#   * Line numbers are dropped before comparing, so moving code is not a finding.
#     Adding a second occurrence of a known pattern to the same file is.
# ===========================================================================

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

BASE="${1:-origin/main}"
SCANNER="scripts/security-scan.sh"

if ! git rev-parse --verify -q "${BASE}^{commit}" >/dev/null; then
  echo "security-scan-diff: base ref '${BASE}' not found. Fetch it first (git fetch origin main)." >&2
  exit 2
fi

WORK="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$WORK/base" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# Findings only, colour codes and line numbers removed, sorted for comm(1).
findings() {
  sed -e 's/\x1b\[[0-9;]*m//g' \
    | grep -E '^[[:space:]]*(CRITICAL|WARN) \[' \
    | sed -E -e 's/^[[:space:]]+//' -e 's/(\.[a-zA-Z]+):[0-9]+:/\1:/' \
    | sort
}

bash "$SCANNER" 2>&1 | findings > "$WORK/head.txt"

if ! git worktree add --detach "$WORK/base" "$BASE" >/dev/null 2>&1; then
  echo "security-scan-diff: could not check out '${BASE}' for comparison." >&2
  exit 2
fi
mkdir -p "$WORK/base/scripts"
cp "$SCANNER" "$WORK/base/$SCANNER"
bash "$WORK/base/$SCANNER" 2>&1 | findings > "$WORK/base.txt"

comm -13 "$WORK/base.txt" "$WORK/head.txt" > "$WORK/new.txt"
comm -23 "$WORK/base.txt" "$WORK/head.txt" > "$WORK/fixed.txt"

known=$(wc -l < "$WORK/base.txt" | tr -d ' ')
new=$(wc -l < "$WORK/new.txt" | tr -d ' ')
fixed=$(wc -l < "$WORK/fixed.txt" | tr -d ' ')

echo "security-scan-diff against ${BASE}"
echo "  findings already on the base: ${known}"
echo "  findings this change removes: ${fixed}"
echo "  findings this change adds:    ${new}"

if [ "$new" -gt 0 ]; then
  echo
  echo "New findings (rule ids and fixes are in docs/SECURITY-PLAYBOOK.md):"
  sed 's/^/  /' "$WORK/new.txt"
  echo
  echo "RESULT: FAIL — fix each new finding, or show in the pull request why a WARN is intentional."
  exit 1
fi

echo "RESULT: PASS — this change adds no finding."
exit 0
