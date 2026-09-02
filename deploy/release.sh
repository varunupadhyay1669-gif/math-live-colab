#!/usr/bin/env bash
# Deploy a build, and be able to undo it in one command.
#
# Until this script the deploy was: copy files over the running app, restart,
# hope. There was no previous version to go back to — undoing a bad deploy
# meant rebuilding the last good one from git and shipping it again, from a
# laptop, possibly at night, possibly with a lesson booked in an hour.
#
# WHAT THIS DOES NOT DO, on purpose: it does not move the app into a
# releases/current symlink layout. That would mean editing the systemd unit,
# re-pointing WorkingDirectory, and fixing node_modules resolution, on a live
# box, to buy atomicity this app does not need — the files only take effect at
# the restart, and the restart is already the atomic moment. Instead the
# previous versions are kept beside the app and a rollback copies one back.
# Same outcome, nothing to migrate, nothing to get wrong at 2am.
#
#   sudo /opt/mathslive/deploy/release.sh snapshot            keep a copy of what is running now
#   sudo /opt/mathslive/deploy/release.sh deploy /tmp/app.tgz ship a tarball, keeping a copy first
#   sudo /opt/mathslive/deploy/release.sh list                what can be gone back to
#   sudo /opt/mathslive/deploy/release.sh rollback            back to the previous release
#   sudo /opt/mathslive/deploy/release.sh rollback <id>       back to a named one
set -uo pipefail

APP=/opt/mathslive
RELEASES=$APP/releases
KEEP=${KEEP_RELEASES:-5}
# What a release is. node_modules is deliberately absent: it is large, it is
# installed by npm on the box, and it changes only when package.json does —
# which is why package.json and its lock file ARE included, so a rollback can
# tell you it needs an `npm ci`.
PARTS=(server.ts src dist package.json package-lock.json index.html vite.config.ts tsconfig.json)

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
[ -d "$APP" ] || die "$APP does not exist — this is meant to run on the server."
mkdir -p "$RELEASES"

stamp() { date -u +%Y%m%d-%H%M%S; }

current_id() {
  # The commit the running code came from, when the tarball carried one.
  cat "$APP/.release-id" 2>/dev/null || echo "unknown"
}

snapshot() {
  local id="${1:-$(stamp)-$(current_id)}"
  local dest="$RELEASES/$id"
  [ -e "$dest" ] && { echo "  $id already kept"; echo "$dest"; return 0; }
  mkdir -p "$dest"
  local part
  for part in "${PARTS[@]}"; do
    [ -e "$APP/$part" ] || continue
    cp -a "$APP/$part" "$dest/" || die "could not copy $part"
  done
  # deploy/ is copied WITHOUT the environment file. Secrets do not belong in
  # five directories, and rolling back the code must never roll back the
  # configuration — an old env file could point at the wrong database or carry
  # a key that has since been rotated.
  if [ -d "$APP/deploy" ]; then
    mkdir -p "$dest/deploy"
    find "$APP/deploy" -maxdepth 1 -type f ! -name 'mathslive.env' -exec cp -a {} "$dest/deploy/" \;
  fi
  du -sh "$dest" | sed 's/^/  kept /'
  echo "$dest"
}

# Old hashed assets accumulate, because a deploy untars OVER dist/ and tar does
# not delete what is no longer in the archive. That is deliberate and load
# bearing: a student who fetched index.html a minute before the deploy will ask
# for the old hashed chunks a moment after it, and if they are gone they get a
# white page mid-lesson. Vite's content hashing means the old and new files can
# sit side by side safely.
#
# What it must not do is grow for ever. Seven days is far longer than any page
# stays open — a socket reconnect reloads the app long before that — and it
# keeps every asset from every deploy of the last week.
prune_assets() {
  local before after
  before=$(find "$APP/dist/assets" -type f 2>/dev/null | wc -l)
  find "$APP/dist/assets" -type f -mtime +7 -delete 2>/dev/null
  after=$(find "$APP/dist/assets" -type f 2>/dev/null | wc -l)
  [ "$before" != "$after" ] && echo "  pruned $((before - after)) asset(s) older than 7 days ($after kept)"
  return 0
}

prune() {
  local n
  n=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | wc -l)
  [ "$n" -le "$KEEP" ] && return 0
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -n | head -n $(( n - KEEP )) | cut -d' ' -f2- \
    | while read -r old; do echo "  pruning $(basename "$old")"; rm -rf "$old"; done
}

healthy() {
  curl -sf --max-time 5 http://127.0.0.1:4000/api/healthz 2>/dev/null | grep -q '"ok":true'
}

restart() {
  # A service that is not answering has no lesson to protect, and waiting for
  # one would keep the site down for up to two hours. This matters most on the
  # rollback path, where the whole reason we are here is that the app did not
  # come up: restart-when-free reads its room count from the health endpoint,
  # so a dead app looks to it exactly like a busy one.
  if ! healthy; then
    say "The service is not answering — restarting now rather than waiting for an idle room"
    systemctl restart mathslive
    return
  fi
  if [ -x /usr/local/bin/mathslive-restart-when-free ]; then
    say "Restarting at the first moment no lesson is running"
    # Deliberately backgrounded through systemd-run: this waits for an idle
    # room and would otherwise hold the terminal for up to two hours.
    systemd-run --unit="mathslive-release-restart-$(date +%s)" --description='MathsLive deferred restart' \
      /usr/local/bin/mathslive-restart-when-free \
      && echo "  armed — it will restart when the last lesson ends (watch: journalctl -t mathslive -f)"
  else
    say "Restarting now (restart-when-free is not installed)"
    systemctl restart mathslive
  fi
}

case "${1:-}" in
  snapshot)
    say "Keeping a copy of what is running"
    snapshot >/dev/null
    prune
    ;;

  deploy)
    TARBALL="${2:-}"
    [ -f "$TARBALL" ] || die "usage: release.sh deploy /path/to/app.tgz"
    say "1/4  Keeping a copy of what is running"
    snapshot >/dev/null
    say "2/4  Unpacking $(basename "$TARBALL")"
    tar xzf "$TARBALL" -C "$APP" || die "unpack failed — nothing was changed beyond the files already written"
    chown -R mathslive:mathslive "$APP" 2>/dev/null || true
    [ -n "${RELEASE_ID:-}" ] && echo "$RELEASE_ID" > "$APP/.release-id"
    say "3/4  Checking it at least parses"
    # A build that cannot type-check is a build that will crash-loop. This is
    # the last moment it is cheaper to find out.
    if ! sudo -u mathslive bash -c "cd $APP && timeout 300 npx tsc --noEmit"; then
      die "TypeScript failed. The old version is still running. Roll forward with a fixed build, or: release.sh rollback"
    fi
    say "4/4  Restart"
    prune_assets
    restart
    prune
    ;;

  list)
    say "Releases (newest last)"
    find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
      | sort -n | cut -d' ' -f2- \
      | while read -r d; do printf '  %-34s %s\n' "$(basename "$d")" "$(du -sh "$d" | cut -f1)"; done
    echo
    echo "  running: $(current_id)"
    ;;

  rollback)
    WANT="${2:-}"
    if [ -z "$WANT" ]; then
      WANT=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
        | sort -rn | sed -n '1p' | cut -d' ' -f2-)
    else
      WANT="$RELEASES/$WANT"
    fi
    [ -d "$WANT" ] || die "no such release. Try: release.sh list"
    say "Keeping a copy of the CURRENT (broken) version first"
    # Because the reason for a rollback is usually not yet understood, and
    # deleting the evidence while fixing it is how the same bug ships twice.
    snapshot "$(stamp)-before-rollback" >/dev/null
    say "Restoring $(basename "$WANT")"
    for part in "${PARTS[@]}"; do
      [ -e "$WANT/$part" ] || continue
      rm -rf "${APP:?}/$part"
      cp -a "$WANT/$part" "$APP/"
    done
    if [ -d "$WANT/deploy" ]; then
      find "$WANT/deploy" -maxdepth 1 -type f ! -name 'mathslive.env' -exec cp -a {} "$APP/deploy/" \;
    fi
    chown -R mathslive:mathslive "$APP" 2>/dev/null || true
    basename "$WANT" > "$APP/.release-id"
    if ! sudo -u mathslive bash -c "cd $APP && npm ls --depth=0 >/dev/null 2>&1"; then
      echo "  ⚠  dependencies do not match this release — run: sudo -u mathslive bash -c 'cd $APP && npm ci'"
    fi
    restart
    ;;

  *)
    sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
