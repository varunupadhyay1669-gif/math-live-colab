#!/usr/bin/env bash
# Install the watchdog and the nightly backup. Idempotent — safe to re-run.
#
#   sudo bash /opt/mathslive/deploy/install-ops.sh
#
# Deliberately separate from bootstrap.sh: bootstrap is what builds a box, and
# this is what can be added to the box that already exists without touching the
# running service. Nothing here restarts MathsLive.
set -euo pipefail

SRC=/opt/mathslive/deploy
say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

[ -f "$SRC/watchdog.sh" ] || { echo "run this from a deployed checkout: $SRC/watchdog.sh is missing"; exit 1; }

say "Installing scripts"
install -m 750 "$SRC/watchdog.sh" /usr/local/bin/mathslive-watchdog
install -m 750 "$SRC/backup.sh"   /usr/local/bin/mathslive-backup
install -m 750 "$SRC/restart-when-free.sh" /usr/local/bin/mathslive-restart-when-free
install -m 750 "$SRC/restore-test.sh" /usr/local/bin/mathslive-restore-test
install -m 750 "$SRC/release.sh"  /usr/local/bin/mathslive-release
mkdir -p /var/lib/mathslive /var/backups/mathslive
chmod 700 /var/backups/mathslive

say "Watchdog — every minute"
cat > /etc/systemd/system/mathslive-watchdog.service <<'UNIT'
[Unit]
Description=MathsLive health watchdog
After=mathslive.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mathslive-watchdog
UNIT

cat > /etc/systemd/system/mathslive-watchdog.timer <<'UNIT'
[Unit]
Description=Check MathsLive every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s
Unit=mathslive-watchdog.service

[Install]
WantedBy=timers.target
UNIT

say "Backup — nightly at 02:30 IST (21:00 UTC)"
cat > /etc/systemd/system/mathslive-backup.service <<'UNIT'
[Unit]
Description=MathsLive nightly database backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mathslive-backup
UNIT

cat > /etc/systemd/system/mathslive-backup.timer <<'UNIT'
[Unit]
Description=Back up the MathsLive database nightly

[Timer]
# 21:00 UTC is 02:30 IST — after the last lesson of the evening and well
# before the first of the morning, so a dump never competes with a class.
OnCalendar=*-*-* 21:00:00
Persistent=true
RandomizedDelaySec=5min
Unit=mathslive-backup.service

[Install]
WantedBy=timers.target
UNIT

say "Restore test — weekly, Sunday 03:30 IST (22:00 UTC Saturday)"
# A backup nobody has restored is a rumour. This restores the newest dump into
# a scratch database and counts the rows that came back. It runs an hour after
# Saturday's backup, so the dump it tests is the newest one, and it says
# nothing at all unless something is wrong.
cat > /etc/systemd/system/mathslive-restore-test.service <<'UNIT'
[Unit]
Description=MathsLive weekly backup restore test

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mathslive-restore-test
UNIT

cat > /etc/systemd/system/mathslive-restore-test.timer <<'UNIT'
[Unit]
Description=Prove the MathsLive backup restores, weekly

[Timer]
OnCalendar=Sat *-*-* 22:00:00
Persistent=true
RandomizedDelaySec=10min
Unit=mathslive-restore-test.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now mathslive-watchdog.timer mathslive-backup.timer mathslive-restore-test.timer

say "Taking one backup now, so there is a copy before you walk away"
/usr/local/bin/mathslive-backup || echo "  (the first backup failed — see the message above)"

say "State"
systemctl list-timers --no-pager | grep -E 'mathslive|NEXT' || true
ls -lh /var/backups/mathslive 2>/dev/null | tail -3 || true

say "Restore test — running one now, so the first result is not a week away"
/usr/local/bin/mathslive-restore-test || echo "  (the restore test failed — see the message above; this is exactly what it is for)"

cat <<'NOTE'

Also installed:

  mathslive-restore-test   weekly, and just now. Restores the newest dump into
                           a scratch database and compares row counts with the
                           live one. Silent on success.
  mathslive-release        deploy with a kept copy of the previous version, and
                           `mathslive-release rollback` to go back in one step.

Two things this does NOT do, on purpose:

  1. The dumps sit on the same disk as the database. That covers a bad
     migration or a mistaken delete; it does not cover losing the instance.
     Set BACKUP_REMOTE in deploy/mathslive.env to an rclone target when a
     destination exists, and backup.sh will copy off-box.

  2. A watchdog on the box cannot report that the box is gone, and neither can
     the restore test. The 8am digest email is the cover for that: if it stops
     arriving, the box is down. An off-box uptime check (PLAN.md task 0.8) is
     the proper fix and needs an account only Varun can create.

NOTE
