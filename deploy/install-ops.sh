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

systemctl daemon-reload
systemctl enable --now mathslive-watchdog.timer mathslive-backup.timer

say "Taking one backup now, so there is a copy before you walk away"
/usr/local/bin/mathslive-backup || echo "  (the first backup failed — see the message above)"

say "State"
systemctl list-timers --no-pager | grep -E 'mathslive|NEXT' || true
ls -lh /var/backups/mathslive 2>/dev/null | tail -3 || true

cat <<'NOTE'

Two things this does NOT do, on purpose:

  1. The dumps sit on the same disk as the database. That covers a bad
     migration or a mistaken delete; it does not cover losing the instance.
     Set BACKUP_REMOTE in deploy/mathslive.env to an rclone target when a
     destination exists, and backup.sh will copy off-box.

  2. A watchdog on the box cannot report that the box is gone. The 8am digest
     email is the cover for that: if it stops arriving, the box is down.

NOTE
