#!/usr/bin/env bash
# Restart into a new version, and put the old one back if it does not come up.
#
# The gap this closes: shipping files and arming a deferred restart is safe for
# the lesson in progress, but nobody is watching at the moment the restart
# actually happens — it could be two hours later, at night. If the new build
# fails to boot, the site is down until a person notices. The watchdog will
# restart it, three times, into the same broken build.
#
# So the deploy carries its own undo. This waits for an idle moment exactly as
# before, restarts, then asks the health endpoint whether the app is actually
# serving. If it is not, it restores the previous release and restarts again —
# which is the difference between "down until somebody looks" and "a minute of
# the old version".
#
#   sudo systemd-run --unit=mathslive-guarded-deploy /usr/local/bin/mathslive-guarded-restart
#   journalctl -t mathslive -f          # watch what it decided
set -uo pipefail

URL=http://127.0.0.1:4000/api/healthz
BOOT_WAIT_S=${BOOT_WAIT_S:-90}

log() { logger -t mathslive "guarded-deploy: $*"; echo "$*"; }

healthy() { curl -sf --max-time 5 "$URL" 2>/dev/null | grep -q '"ok":true'; }

log "waiting for a moment with no lesson in progress"
if ! /usr/local/bin/mathslive-restart-when-free; then
  log "gave up waiting — a lesson is still active. NOTHING was restarted; the new files are staged and will take effect on the next restart."
  exit 1
fi

# restart-when-free has restarted the service by here.
log "restarted; waiting up to ${BOOT_WAIT_S}s for it to serve"
for _ in $(seq 1 $(( BOOT_WAIT_S / 3 )) ); do
  sleep 3
  if healthy; then
    log "healthy — $(curl -s --max-time 5 "$URL")"
    exit 0
  fi
done

log "NOT healthy after ${BOOT_WAIT_S}s — rolling back to the previous release"
# release.sh restarts immediately when the service is not answering, so this
# does not sit waiting for an idle room that will never be reported.
/usr/local/bin/mathslive-release rollback

sleep 8
if healthy; then
  log "rolled back and healthy again. The bad build is kept in releases/ as *-before-rollback."
  exit 1
fi
log "ROLLBACK DID NOT RECOVER THE SITE. This needs a person: journalctl -u mathslive -n 60"
exit 2
