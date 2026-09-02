#!/usr/bin/env bash
# Restore last night's backup into a scratch database and count what came back.
#
# A backup nobody has restored is a rumour. backup.sh already reads its own
# dump back and checks the table-data entries are present, which proves the
# file is not empty — it does not prove the file would restore, and it does not
# prove the rows are in it. This does both, every week, without anybody
# remembering to.
#
# It is deliberately paranoid about one thing: it must never touch the live
# database. Every statement below is either read-only against the live database
# or scoped to a scratch database whose name is fixed and unmistakable, and the
# scratch database is dropped on every exit path including a failure.
#
#   sudo /usr/local/bin/mathslive-restore-test        (installed by install-ops.sh)
set -uo pipefail

DIR=/var/backups/mathslive
SCRATCH=mathslive_restoretest
ENV_FILE=/opt/mathslive/deploy/mathslive.env
STATE=/var/lib/mathslive
# Tables worth grieving for. If the restored copy of any of these is empty
# while the live one is not, the backup is not a backup.
TABLES="users classes teaching_sessions payment_claims board_images rooms"

mkdir -p "$STATE"
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
    | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}'
}

notify() {
  local subject="$1" body="$2"
  logger -t mathslive-restore-test "$subject"
  echo "$subject"
  echo "$body"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s --max-time 20 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"disable_web_page_preview\":true,\"text\":\"$(json_escape "$subject

$body")\"}" >/dev/null 2>&1 || true
  fi
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

cleanup() {
  sudo -u postgres dropdb --if-exists "$SCRATCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  notify "MathsLive restore test FAILED" "DATABASE_URL is not set in $ENV_FILE, so the live row counts could not be read."
  exit 1
fi

NEWEST=$(find "$DIR" -name 'mathslive-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
if [ -z "$NEWEST" ]; then
  notify "MathsLive restore test FAILED" "No dump found in $DIR. Check: systemctl status mathslive-backup.timer"
  exit 1
fi

AGE_HOURS=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST") ) / 3600 ))
if [ "$AGE_HOURS" -gt 48 ]; then
  notify "MathsLive restore test FAILED" "The newest dump ($NEWEST) is ${AGE_HOURS} hours old. The nightly backup has stopped."
  exit 1
fi

# ── Restore into a scratch database ────────────────────────────────────────
cleanup
if ! sudo -u postgres createdb "$SCRATCH" 2>/tmp/restoretest.err; then
  notify "MathsLive restore test FAILED" "Could not create the scratch database.$(printf '\n\n')$(tail -c 500 /tmp/restoretest.err)"
  exit 1
fi

# pg_restore reports missing-role and ownership noise on a --no-owner dump;
# those are warnings, not failures, so the exit code is what is judged and the
# output is kept only to show if the counts then disagree.
sudo -u postgres pg_restore --no-owner --no-privileges -d "$SCRATCH" "$NEWEST" >/tmp/restoretest.log 2>&1
RESTORE_RC=$?

count_live()    { psql "$DB_URL" -tAc "SELECT count(*) FROM $1" 2>/dev/null || echo "?"; }
count_scratch() { sudo -u postgres psql -d "$SCRATCH" -tAc "SELECT count(*) FROM $1" 2>/dev/null || echo "?"; }

REPORT=""
PROBLEMS=""
for t in $TABLES; do
  live=$(count_live "$t")
  restored=$(count_scratch "$t")
  REPORT="${REPORT}
  $(printf '%-18s live %-8s restored %s' "$t" "$live" "$restored")"
  # A restored count is always a little behind the live one — the dump is from
  # last night. What is being caught here is a restore that produced nothing,
  # or a fraction of the rows, not the ordinary day's difference.
  case "$live" in ''|*[!0-9]*) PROBLEMS="$PROBLEMS $t(live unreadable)"; continue ;; esac
  case "$restored" in ''|*[!0-9]*) PROBLEMS="$PROBLEMS $t(restored unreadable)"; continue ;; esac
  if [ "$live" -gt 0 ] && [ "$restored" -eq 0 ]; then
    PROBLEMS="$PROBLEMS $t(empty)"
  elif [ "$live" -gt 20 ] && [ "$restored" -lt $(( live / 2 )) ]; then
    PROBLEMS="$PROBLEMS $t(less than half)"
  fi
done

SIZE=$(stat -c %s "$NEWEST" 2>/dev/null || echo 0)
HUMAN=$(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes")

if [ "$RESTORE_RC" -ne 0 ] || [ -n "$PROBLEMS" ]; then
  notify "MathsLive restore test FAILED — the backup may not be usable" \
    "Dump    : $NEWEST ($HUMAN, ${AGE_HOURS}h old)
Restore : exit $RESTORE_RC
Problems:${PROBLEMS:- (none, but the restore itself failed)}

Row counts:${REPORT}

Last lines of the restore log:
$(tail -c 1200 /tmp/restoretest.log)"
  exit 1
fi

date +%s > "$STATE/last-restore-test"
echo "restore test ok: $NEWEST ($HUMAN, ${AGE_HOURS}h old)${REPORT}"
# Silence is the success case. A weekly "all fine" email is a weekly email that
# teaches you to ignore this address; the failure path is the one that speaks.
