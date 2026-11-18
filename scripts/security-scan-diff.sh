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
#   exit 1 — the change adds at least one finding, or removes the scanner.
#   exit 2 — the comparison could not run (unknown base ref, not a git checkout,
#            a scanner that did not reach its summary). Never treat this as a pass.
#
# How it compares:
#   * The scanner is taken from the BASE ref, not from the change, and run over
#     both trees. A change cannot pass by deleting a rule, emptying the scanner
#     or making it exit early: the base's rules still judge it.
#   * If the change also edits the scanner, its version is run over both trees
#     as well, so a new rule applies to the change that adds it without blaming
#     that change for what the base already had. Either comparison can fail it.
#   * Every scan must reach the scanner's summary line. One that does not is
#     an error (exit 2), not a clean result.
#   * Line numbers are dropped before comparing, so moving code is not a finding.
#
# What it cannot see:
#   * Some rules report once per file (C-3). More of the same pattern in a file
#     the base already flags is not a new line here. The security reviewer reads
#     the diff for that.
#   * A change to THIS file. CI and the reviewer therefore run the base
#     branch's copy of this script (see .github/workflows/code-revamp.yml).
#     The script finds the repository from the current directory, not from its
#     own location, so a copy saved elsewhere works.
# ===========================================================================

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "security-scan-diff: not inside a git checkout." >&2
  exit 2
}
cd "$ROOT" || exit 2

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

if ! git show "${BASE}:${SCANNER}" > "$WORK/scanner-base.sh" 2>/dev/null || [ ! -s "$WORK/scanner-base.sh" ]; then
  echo "security-scan-diff: '${BASE}' has no ${SCANNER}, so there are no trusted rules to compare with." >&2
  exit 2
fi

if [ ! -s "$SCANNER" ]; then
  echo "security-scan-diff against ${BASE}"
  echo "RESULT: FAIL — this change removes or empties ${SCANNER}."
  exit 1
fi

if ! git worktree add --detach "$WORK/base" "$BASE" >/dev/null 2>&1; then
  echo "security-scan-diff: could not check out '${BASE}' for comparison." >&2
  exit 2
fi

# run_scan <scanner file> <tree> <output file>
# The scanner finds its tree from its own path ($0), so it is sourced with $0
# set to where it would live inside the tree being scanned. Nothing is written
# into either tree.
run_scan() {
  bash -c 'source "$1"' "$2/$SCANNER" "$1" > "$3.raw" 2>&1
  if ! grep -q 'CRITICAL failures:' "$3.raw"; then
    echo "security-scan-diff: a scan did not reach its summary ($(basename "$1") over $(basename "$2")). Treat as not run." >&2
    exit 2
  fi
  # Findings only, colour codes and line numbers removed, sorted for comm(1).
  sed -e 's/\x1b\[[0-9;]*m//g' "$3.raw" \
    | grep -E '^[[:space:]]*(CRITICAL|WARN) \[' \
    | sed -E -e 's/^[[:space:]]+//' -e 's/(\.[a-zA-Z]+):[0-9]+:/\1:/' \
    | sort > "$3"
}

run_scan "$WORK/scanner-base.sh" "$WORK/base" "$WORK/base.by-base"
run_scan "$WORK/scanner-base.sh" "$ROOT"      "$WORK/head.by-base"
comm -13 "$WORK/base.by-base" "$WORK/head.by-base" > "$WORK/new.txt"
comm -23 "$WORK/base.by-base" "$WORK/head.by-base" > "$WORK/fixed.txt"

scanner_note="the base's scanner"
if ! cmp -s "$WORK/scanner-base.sh" "$SCANNER"; then
  scanner_note="the base's scanner and this change's edited scanner"
  cp "$SCANNER" "$WORK/scanner-head.sh"
  run_scan "$WORK/scanner-head.sh" "$WORK/base" "$WORK/base.by-head"
  run_scan "$WORK/scanner-head.sh" "$ROOT"      "$WORK/head.by-head"
  comm -13 "$WORK/base.by-head" "$WORK/head.by-head" >> "$WORK/new.txt"
  sort -u -o "$WORK/new.txt" "$WORK/new.txt"
fi

known=$(wc -l < "$WORK/base.by-base" | tr -d ' ')
new=$(wc -l < "$WORK/new.txt" | tr -d ' ')
fixed=$(wc -l < "$WORK/fixed.txt" | tr -d ' ')

echo "security-scan-diff against ${BASE} (${scanner_note})"
echo "  findings already on the base: ${known}"
echo "  findings this change removes: ${fixed}"
echo "  findings this change adds:    ${new}"

if [ "$new" -gt 0 ]; then
  echo
  echo "New findings (rule ids and fixes are in docs/SECURITY-PLAYBOOK.md):"
  sed 's/^/  /' "$WORK/new.txt"
  echo
  echo "RESULT: FAIL — fix each new finding. A WARN that is intentional needs the owner's acceptance."
  exit 1
fi

echo "RESULT: PASS — this change adds no finding."
exit 0
