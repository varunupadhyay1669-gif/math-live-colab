#!/usr/bin/env bash
# Restart MathsLive at the first moment no lesson is actually happening.
#
# The obvious rule — wait for rooms to reach zero — is wrong, and cost a deploy
# an afternoon before this existed. A room counts as occupied while ANY socket
# is attached, so a tab left open on a finished lesson keeps the count at one
# indefinitely. Waiting for zero means waiting for someone to close a browser
# they have already walked away from.
#
# So the question is not "is anyone connected" but "is anyone teaching":
# rooms=0, OR every room idle for longer than IDLE_MIN. A stale tab reconnects
# by itself after a restart; a lesson in progress is never interrupted.
set -uo pipefail

URL=http://127.0.0.1:4000/api/healthz
IDLE_MIN=${IDLE_MIN:-15}
MAX_WAIT_MIN=${MAX_WAIT_MIN:-120}

for i in $(seq 1 $((MAX_WAIT_MIN * 6))); do
  body=$(curl -s --max-time 8 "$URL" 2>/dev/null || true)
  rooms=$(printf '%s' "$body" | grep -oE '"rooms":[0-9]+' | cut -d: -f2)
  idle=$(printf '%s' "$body" | grep -oE '"idleMs":[0-9]+' | cut -d: -f2)

  if [ "${rooms:-1}" = "0" ]; then
    systemctl restart mathslive
    logger -t mathslive "deploy restart: no rooms open (waited $((i * 10))s)"
    exit 0
  fi
  # idleMs is absent on an older build; then only rooms=0 will do.
  if [ -n "${idle:-}" ] && [ "$idle" -gt $((IDLE_MIN * 60000)) ]; then
    systemctl restart mathslive
    logger -t mathslive "deploy restart: $rooms room(s) open but idle ${IDLE_MIN}m+ (waited $((i * 10))s)"
    exit 0
  fi
  sleep 10
done

logger -t mathslive "deploy restart: gave up after ${MAX_WAIT_MIN}m, a lesson is still active"
exit 1
