#!/usr/bin/env bash
# Backfills the tracked X accounts through the Worker's own endpoint, one handle
# every 30 seconds. Run it from day 3 of the soak week, once live ingest is stable:
# backfilled items draw on their own capped share of the AI budget.
#
#   RADAR_ORIGIN=https://radar.example.com scripts/backfill-kols.sh [days]     default 15
#
# The endpoint is public; Origin and JSON headers match browser interactions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAYS="${1:-15}"
: "${RADAR_ORIGIN:?set RADAR_ORIGIN to the deployed origin, e.g. https://radar.example.com}"
PAUSE_SECONDS="${PAUSE_SECONDS:-30}"

handles="$(node -e 'for (const s of require(process.argv[1])) if (s.type === "x" && s.enabled !== false) console.log(s.key)' "$ROOT/config/sources.json")"
for handle in $handles; do
  body="$(curl -sS -m 300 -X POST "$RADAR_ORIGIN/api/admin/backfill" \
    -H "Origin: $RADAR_ORIGIN" -H "Content-Type: application/json" \
    --data "{\"handle\":\"$handle\",\"days\":$DAYS}")"
  echo "$handle $body"
  # The source pushed back: stop instead of hammering a community service.
  if grep -q '"stoppedBecause":"upstream_error"' <<<"$body"; then echo "backfill-kols: upstream error on $handle, stopping" >&2; exit 1; fi
  sleep "$PAUSE_SECONDS"
done
