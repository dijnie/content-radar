#!/usr/bin/env bash
# Runs one query against the remote content-radar D1 with the analyst's scoped token.
#
#   analyst/run-query.sh analyst/queries/03-entity-momentum.sql --set min_ratio=2
#   analyst/run-query.sh --sql "SELECT story_id, headline_vi FROM v_story_cards LIMIT 5"
#
# This script does two real things: it pins the target database, and it wraps
# free-text columns in <untrusted-data> tags. It is NOT a security boundary. An
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

token="$(grep -E '^CLOUDFLARE_API_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"'")"
account="$(grep -E '^CLOUDFLARE_ACCOUNT_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"'")"
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
  let sql = process.env.SQL;
  for (const pair of process.argv.slice(1)) {
    const at = pair.indexOf("=");
    if (at < 1 || !/^[a-z_][a-z0-9_]*$/.test(pair.slice(0, at))) { console.error("run-query: bad --set " + pair); process.exit(2); }
    const value = pair.slice(at + 1);
    const literal = /^-?\d+(\.\d+)?$/.test(value) ? value : "\x27" + value.replaceAll("\x27", "\x27\x27") + "\x27";
    sql = sql.replaceAll(new RegExp(":" + pair.slice(0, at) + "\\b", "g"), () => literal);
  }
  const missing = sql.replace(/--.*$/gm, "").replace(/\x27(?:[^\x27]|\x27\x27)*\x27/g, "").match(/(?<![:\w]):[a-z_][a-z0-9_]*\b/g);
  if (missing) { console.error("run-query: missing --set for " + [...new Set(missing)].join(", ")); process.exit(2); }
  process.stdout.write(sql);
' -- "${params[@]}")"

# Only the wrangler process sees the token.
raw="$(cd "$ROOT/apps/worker" && env CLOUDFLARE_API_TOKEN="$token" CLOUDFLARE_ACCOUNT_ID="$account" $WRANGLER d1 execute "$DATABASE" --remote --json --command "$sql")"

# Text written by strangers on the internet is marked as data before anyone reads it.
RAW="$raw" node -e '
  const UNTRUSTED = new Set(["quote", "text_vi", "text_en", "title", "headline_vi", "summary_vi", "label_text", "related_label_text", "label", "canonical_name", "author", "question", "statement_vi", "verification_notes_vi", "last_error"]);
  const wrap = (value) => "<untrusted-data>" + String(value).replaceAll(/<\/?untrusted-data>/gi, "[tag removed]") + "</untrusted-data>";
  let parsed;
  try { parsed = JSON.parse(process.env.RAW); } catch { console.error("run-query: wrangler did not return JSON"); console.error(process.env.RAW.slice(0, 2000)); process.exit(1); }
  for (const set of Array.isArray(parsed) ? parsed : [parsed]) {
    for (const row of set.results ?? []) for (const [key, value] of Object.entries(row)) if (UNTRUSTED.has(key) && typeof value === "string") row[key] = wrap(value);
  }
  console.log(JSON.stringify((Array.isArray(parsed) ? parsed : [parsed]).map((set) => ({ success: set.success, rows: set.results ?? [], meta: set.meta && { rows_read: set.meta.rows_read, rows_written: set.meta.rows_written } })), null, 2));
'
