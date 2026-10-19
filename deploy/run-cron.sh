#!/usr/bin/env bash
# Fires one scheduled job: the same request Vercel Cron makes, a GET to
# /api/cron/<job> with `Authorization: Bearer <CRON_SECRET>`, aimed at the app
# on loopback. Called from /etc/cron.d/hioc (deploy/hioc-cron).
#
#   run-cron.sh <job>        e.g. run-cron.sh expire-orders
#
# Every run appends one line to /var/log/hioc-cron.log.
set -uo pipefail
job="${1:?usage: run-cron.sh <job>}"
here="$(dirname "$(readlink -f "$0")")"

# Read CRON_SECRET out of the app's own env file, so the two can never drift.
secret=$(sed -n 's/^CRON_SECRET=//p' "$here/app.env" | tail -n 1 | sed -E "s/^['\"]//; s/['\"]$//")
if [ -z "$secret" ]; then
  echo "$(date -u +%FT%TZ) $job SKIPPED: CRON_SECRET is not set in $here/app.env" >> /var/log/hioc-cron.log
  exit 1
fi

out=$(mktemp)
code=$(curl -sS -o "$out" -w '%{http_code}' --max-time 300 \
  -H "Authorization: Bearer $secret" \
  "http://127.0.0.1:3000/api/cron/$job" 2>>"$out")
echo "$(date -u +%FT%TZ) $job HTTP $code $(head -c 300 "$out" | tr '\n' ' ')" >> /var/log/hioc-cron.log
rm -f "$out"
[ "$code" = 200 ]
