#!/usr/bin/env bash
# Is the site actually up, and is it about to stop being up?
#
# Today the way an outage is discovered is that a student cannot join a lesson
# and tells their tutor, who tells Varun. On 24 August that loop took eight
# hours. This closes the common case to about a minute.
#
# WHAT THIS CANNOT DO, said plainly because it matters: a watchdog running ON
# the box cannot tell you the box is gone. If the instance dies, this dies with
# it and you hear nothing. What it catches is the far more frequent failure —
# the app crashed, wedged, or ran out of memory while the machine is fine.
#
# The gap is covered from the other side: the server emails an 8am digest every
# day (src/server/scheduler.ts). If that stops arriving, the box is down. It is
# a dead man's switch that was already there for another reason, and it is
# worth knowing it doubles as one.
set -uo pipefail

URL=http://127.0.0.1:4000/api/healthz
SERVICE=mathslive
STATE=/var/lib/mathslive/watchdog
ENV_FILE=/opt/mathslive/deploy/mathslive.env
FAILS_BEFORE_RESTART=3
MEM_WARN_PCT=92
DISK_WARN_PCT=88

mkdir -p "$STATE"
if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
    | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}'
}

notify() {
  local subject="$1" body="$2"
  logger -t mathslive-watchdog "$subject"
  echo "$subject"
  # Telegram first: an outage alert is worth nothing an hour late, and this is
  # the channel that buzzes a phone. Email still goes, because it is the record
  # and because a bot token can be revoked without anybody noticing.
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s --max-time 20 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"disable_web_page_preview\":true,\"text\":\"🚨 $(json_escape "$subject

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

# Alert at most once per hour per kind. A watchdog that emails every minute
# during an outage trains the one person who can fix it to ignore its mail.
should_alert() {
  local kind="$1" f="$STATE/last-$1"
  local now last
  now=$(date +%s)
  last=$(cat "$f" 2>/dev/null || echo 0)
  if [ $(( now - last )) -ge 3600 ]; then echo "$now" > "$f"; return 0; fi
  return 1
}

# ── Is it answering? ───────────────────────────────────────────────────────
BODY=$(curl -s --max-time 10 "$URL" 2>/dev/null || true)
if printf '%s' "$BODY" | grep -q '"ok":true'; then
  rm -f "$STATE/fails"
else
  FAILS=$(( $(cat "$STATE/fails" 2>/dev/null || echo 0) + 1 ))
  echo "$FAILS" > "$STATE/fails"

  # Three strikes, not one: a single missed probe during a deploy or a GC pause
  # is not an outage, and restarting on it would cut a live lesson in half for
  # no reason.
  if [ "$FAILS" -ge "$FAILS_BEFORE_RESTART" ]; then
    ROOMS=$(printf '%s' "$BODY" | grep -oE '"rooms":[0-9]+' | cut -d: -f2)
    systemctl restart "$SERVICE"
    sleep 8
    if curl -s --max-time 10 "$URL" 2>/dev/null | grep -q '"ok":true'; then
      rm -f "$STATE/fails"
      should_alert restart && notify "MathsLive: recovered after a restart" \
        "The site failed $FAILS health checks in a row and was restarted automatically. It is answering again.$(printf '\n\n')Recent log:$(printf '\n')$(journalctl -u $SERVICE -n 25 --no-pager 2>/dev/null | tail -c 1500)"
    else
      should_alert down && notify "MathsLive is DOWN and a restart did not fix it" \
        "Health checks have failed $FAILS times and the service did not come back after a restart. This needs a person.$(printf '\n\n')$(journalctl -u $SERVICE -n 40 --no-pager 2>/dev/null | tail -c 2500)"
    fi
  fi
fi

# ── Is the DATABASE there? ─────────────────────────────────────────────────
#
# The gap that cost three hours on 3 Sep 2026. Postgres was OOM-killed, its
# unit had no Restart=, and the app kept answering "ok" — so this script, which
# ran sixty times an hour throughout, reported a healthy site while sign-in and
# every save were broken.
#
# Deliberately does NOT restart the app: restarting Node does not start
# Postgres, and it would cut whatever lesson was still limping along. It starts
# the DATABASE, which is the thing that is actually down, and only then tells
# somebody.
if printf '%s' "$BODY" | grep -q '"db":"down"'; then
  if should_alert dbdown; then
    logger -t mathslive-watchdog "database unreachable — attempting to start it"
    systemctl start postgresql@16-main 2>/dev/null || systemctl start postgresql 2>/dev/null || true
    sleep 5
    AFTER=$(curl -s --max-time 10 "$URL" 2>/dev/null || true)
    if printf '%s' "$AFTER" | grep -q '"db":"up"'; then
      notify "MathsLive: the database was down and has been restarted" \
        "Postgres was not answering. It was started automatically and the app can reach it again.$(printf '\n\n')Sign-in, saving lessons and durable rooms were ALL failing until now — check whether a lesson happened during that window.$(printf '\n\n')$(journalctl -u postgresql@16-main -n 20 --no-pager 2>/dev/null | tail -c 1200)"
    else
      notify "MathsLive: the DATABASE IS DOWN and would not start" \
        "The app is still serving, so the site looks fine — but sign-in, saving a lesson and durable rooms are all failing. This needs a person.$(printf '\n\n')$(journalctl -u postgresql@16-main -n 30 --no-pager 2>/dev/null | tail -c 2000)"
    fi
  fi
fi

# ── Is it about to fall over? ──────────────────────────────────────────────
# The 1 GB box runs the app, Postgres and the OS together, and the failure that
# actually happened was memory. Warning before the kernel starts choosing what
# to kill is worth more than reporting it afterwards.
MEM_PCT=$(free | awk '/^Mem:/ {printf "%d", ($2-$7)/$2*100}')
if [ "${MEM_PCT:-0}" -ge "$MEM_WARN_PCT" ]; then
  should_alert mem && notify "MathsLive: memory at ${MEM_PCT}%" \
    "The box is at ${MEM_PCT}% memory. Under class load this is where the kernel starts killing processes.$(printf '\n\n')$(free -m)$(printf '\n\n')$(ps -eo rss,comm --sort=-rss | head -6)"
fi

DISK_PCT=$(df / | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ "${DISK_PCT:-0}" -ge "$DISK_WARN_PCT" ]; then
  should_alert disk && notify "MathsLive: disk at ${DISK_PCT}%" \
    "The root disk is ${DISK_PCT}% full. Backups and Postgres both stop cleanly-ish and then not at all.$(printf '\n\n')$(df -h /)"
fi

# A backup that quietly stopped running is indistinguishable from one that
# never existed, right up until the moment it is needed.
NEWEST=$(find /var/backups/mathslive -name 'mathslive-*.dump' -mtime -2 2>/dev/null | head -1)
if [ -z "$NEWEST" ] && [ -d /var/backups/mathslive ]; then
  should_alert backup && notify "MathsLive: no database backup in 48 hours" \
    "Nothing has been written to /var/backups/mathslive in two days. Check: systemctl status mathslive-backup.timer"
fi
