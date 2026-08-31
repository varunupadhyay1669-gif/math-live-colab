#!/usr/bin/env bash
# Nightly database backup.
#
# Everything a teacher would grieve for lives in one Postgres on one Lightsail
# instance in Mumbai: the roster, every saved lesson, the payment record. Until
# this script there was no copy of any of it anywhere.
#
# WHAT THIS PROTECTS AGAINST, and what it does not:
#
#   ✓ a bad migration, a mistaken DELETE, a corrupted table, "it was working
#     yesterday" — restore last night and lose at most a day.
#   ✗ losing the instance. These dumps live on the same disk as the database,
#     so a dead box takes them with it.
#
# The second line is why BACKUP_REMOTE exists below. Without it this is a
# useful safety net with an honest hole in it, and calling it "backed up"
# without saying so would be exactly the kind of comfortable half-truth this
# codebase keeps having to dig out.
set -uo pipefail

DIR=/var/backups/mathslive
KEEP_DAYS=14
ENV_FILE=/opt/mathslive/deploy/mathslive.env
STAMP=$(date -u +%Y%m%d-%H%M)
OUT="$DIR/mathslive-$STAMP.dump"

mkdir -p "$DIR"
chmod 700 "$DIR"

# Read RESEND_API_KEY / OWNER_EMAIL so a failure can reach a human. Sourcing
# rather than parsing because the file is already systemd's EnvironmentFile
# format and a second parser is a second thing to get wrong.
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

# Escape a string for JSON with sed and awk only. A backup script that needs
# python3 installed is a backup script that stops running the day someone
# trims the image.
json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
    | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}'
}

notify() {
  local subject="$1" body="$2"
  echo "$subject: $body"
  [ -n "${RESEND_API_KEY:-}" ] && [ -n "${OWNER_EMAIL:-}" ] || return 0
  local to_json
  to_json=$(printf '%s' "${OWNER_EMAIL}" \
    | awk -F, '{for(i=1;i<=NF;i++){gsub(/^ +| +$/,"",$i); printf "%s\"%s\"", (i>1?",":""), $i}}')
  curl -s --max-time 20 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"${AUTH_EMAIL_FROM:-MathsLive <login@matheinstein.com>}\",\"to\":[${to_json}],\"subject\":\"$(json_escape "$subject")\",\"text\":\"$(json_escape "$body")\"}" \
    >/dev/null 2>&1 || true
}

DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  notify "MathsLive backup FAILED" "DATABASE_URL is not set in $ENV_FILE, so nothing was backed up."
  exit 1
fi

# -Fc: the custom format, which is compressed and lets pg_restore pick out a
# single table. A plain .sql of a database with image bytea in it is enormous
# and can only be restored whole.
if ! pg_dump -Fc --no-owner --no-privileges -f "$OUT" "$DB_URL" 2>/tmp/backup.err; then
  notify "MathsLive backup FAILED" "pg_dump exited non-zero.$(printf '\n\n')$(tail -c 800 /tmp/backup.err)"
  rm -f "$OUT"
  exit 1
fi

# A file that exists is not a backup. Read it back and check the tables that
# would actually be missed are in there — a dump that restores to an empty
# schema is the worst possible outcome, because it looks like success.
MISSING=""
for t in users classes teaching_sessions payment_claims rooms board_images; do
  pg_restore --list "$OUT" 2>/dev/null | grep -q "TABLE DATA public $t" || MISSING="$MISSING $t"
done
SIZE=$(stat -c %s "$OUT" 2>/dev/null || echo 0)

if [ -n "$MISSING" ] || [ "$SIZE" -lt 4096 ]; then
  notify "MathsLive backup SUSPECT" \
    "The dump is $SIZE bytes and is missing table data for:${MISSING:- (none)}. It was kept at $OUT but should not be trusted."
  exit 1
fi

# Optional off-box copy. Set BACKUP_REMOTE in the env file to an rclone target
# (e.g. "b2:mathslive-backups") once a destination exists.
if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  if ! rclone copy "$OUT" "$BACKUP_REMOTE" --quiet 2>/tmp/rclone.err; then
    notify "MathsLive backup: off-box copy failed" \
      "The local dump is fine ($OUT) but copying to $BACKUP_REMOTE failed.$(printf '\n\n')$(tail -c 500 /tmp/rclone.err)"
  fi
fi

find "$DIR" -name 'mathslive-*.dump' -mtime "+$KEEP_DAYS" -delete
COUNT=$(find "$DIR" -name 'mathslive-*.dump' | wc -l)
echo "backup ok: $OUT ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes")), $COUNT kept"
