#!/usr/bin/env bash
# Exports the whole remote database to a dated SQL file OUTSIDE the repository.
#   scripts/backup-d1.sh [backup-dir]        default: ~/backups/content-radar
# The file contains all data. Keep it out of git, out of any directory an analyst
# session can read, and do not upload it to third-party services.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-$HOME/backups/content-radar}"
case "$(cd "$(dirname "$DIR")" 2>/dev/null && pwd)/$(basename "$DIR")" in
  "$ROOT"|"$ROOT"/*) echo "backup-d1: the backup directory must be outside the repository" >&2; exit 2 ;;
esac
mkdir -p "$DIR" && chmod 700 "$DIR"
OUT="$DIR/content-radar-$(date -u +%Y%m%d-%H%M%S).sql"
node "$ROOT/scripts/setup.ts"
(cd "$ROOT/apps/worker" && npx wrangler d1 export DB --remote --config wrangler.jsonc --output "$OUT")
chmod 600 "$OUT"
echo "backup written to $OUT ($(wc -c < "$OUT") bytes)"
