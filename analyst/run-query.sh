#!/usr/bin/env bash
# Runs one query against the remote content-radar D1 with the analyst's scoped token.
#
#   analyst/run-query.sh analyst/queries/03-entity-momentum.sql --set min_ratio=2
#   analyst/run-query.sh --sql "SELECT story_id, headline_vi FROM v_story_cards LIMIT 5"
#
# This script does two real things: it pins the target database, and it wraps
# every string value in <untrusted-data> tags, except identifier-like values of a
# few structural columns. It is NOT a security boundary. An
# agent can call wrangler directly; what it can then do is decided by the token,
# which must carry D1 permission and nothing else. See docs/analyst-runbook.md.
set -euo pipefail

DATABASE="content-radar"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${RADAR_ANALYST_ENV:-$HOME/.config/content-radar/analyst.env}"
WRANGLER="${RADAR_WRANGLER_CMD:-npx wrangler}"

die() { echo "run-query: $*" >&2; exit 2; }

# A full-account credential in this shell would silently win over the scoped one.
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL; do
  [ -z "${!name:-}" ] || die "$name is already set in this shell. Analyst sessions run with the scoped token only; unset it first."
done
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE. Create the scoped token as described in docs/analyst-runbook.md."
mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
[ "$mode" = "600" ] || die "$ENV_FILE must have mode 600 (it has $mode)."

token="$(grep -E '^CLOUDFLARE_API_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -E "s/^([\"'])(.*)\1\$/\2/")"
account="$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -E "s/^([\"'])(.*)\1\$/\2/")"
[ -n "$token" ] && [ -n "$account" ] || die "$ENV_FILE must define CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID."

sql=""
declare -a params=()
while [ $# -gt 0 ]; do
  case "$1" in
    --sql) [ $# -ge 2 ] || die "--sql needs a statement"; sql="$2"; shift 2 ;;
    --set) [ $# -ge 2 ] || die "--set needs name=value"; params+=("$2"); shift 2 ;;
    -*) die "unknown option $1" ;;
    *)
      file="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")"
      case "$file" in "$ROOT/analyst/queries/"*.sql) ;; *) die "query files must live in analyst/queries/" ;; esac
      [ -f "$file" ] || die "no such query file: $1"
      sql="$(cat "$file")"; shift ;;
  esac
done
[ -n "$sql" ] || die "give a query file from analyst/queries/ or --sql \"SELECT ...\""

# Parameters are substituted as SQL literals: numbers as they are, everything else quoted.
sql="$(SQL="$sql" node -e '
  const values = new Map();
  for (const pair of process.argv.slice(1)) {
    const at = pair.indexOf("=");
    if (at < 1 || !/^[a-z_][a-z0-9_]*$/.test(pair.slice(0, at))) { console.error("run-query: bad --set " + pair); process.exit(2); }
    const value = pair.slice(at + 1);
    values.set(pair.slice(0, at), /^-?\d+(\.\d+)?$/.test(value) ? value : "\x27" + value.replaceAll("\x27", "\x27\x27") + "\x27");
  }
  // One pass over the statement: comments and string literals are copied as they are, so a value that
  // happens to contain ":name" is never substituted again, and placeholders inside text are left alone.
  const missing = new Set();
  const sql = process.env.SQL.replace(/--[^\n]*|\x27(?:[^\x27]|\x27\x27)*\x27|(?<![:\w]):([a-z_][a-z0-9_]*)\b/g, (match, name) => {
    if (name === undefined) return match;
    if (!values.has(name)) { missing.add(":" + name); return match; }
    return values.get(name);
  });
  if (missing.size > 0) { console.error("run-query: missing --set for " + [...missing].join(", ")); process.exit(2); }
  process.stdout.write(sql);
' -- "${params[@]}")"

# Only the wrangler process sees the token.
raw="$(cd "$ROOT/apps/worker" && env CLOUDFLARE_API_TOKEN="$token" CLOUDFLARE_ACCOUNT_ID="$account" $WRANGLER d1 execute "$DATABASE" --remote --json --command "$sql")"

# Every string in a result is treated as written by a stranger and marked as data. Only a short list of
# structural columns is exempt, so an alias, SELECT * or a column added later is untrusted by default.
RAW="$raw" node -e '
  const STRUCTURAL = new Set(["role", "kind", "status", "type", "platform", "rule", "subject_kind", "record", "kind_or_status", "day", "day_pt", "model",
    "headline_source", "user_state", "ingest_mode", "decision", "resolved_by", "derivation_reason", "relation_type", "session_label"]);
  const ENUM_LIKE = /^[a-z0-9_.:@\/-]{1,64}$/i;
  const wrap = (value) => "<untrusted-data>" + value.replaceAll(/<\/?untrusted-data>/gi, "[tag removed]") + "</untrusted-data>";
  let parsed;
  try { parsed = JSON.parse(process.env.RAW); } catch { console.error("run-query: wrangler did not return JSON"); console.error(process.env.RAW.slice(0, 2000)); process.exit(1); }
  const sets = Array.isArray(parsed) ? parsed : [parsed];
  for (const set of sets) {
    for (const row of set.results ?? []) {
      for (const [key, value] of Object.entries(row)) {
        // A structural column is only exempt while it still looks like an identifier.
        if (typeof value === "string" && !(STRUCTURAL.has(key) && ENUM_LIKE.test(value))) row[key] = wrap(value);
      }
    }
  }
  console.log(JSON.stringify(sets.map((set) => ({ success: set.success, rows: set.results ?? [], meta: set.meta && { rows_read: set.meta.rows_read, rows_written: set.meta.rows_written } })), null, 2));
'
