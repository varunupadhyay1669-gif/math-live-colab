#!/usr/bin/env bash
#
# Provision a fresh Ubuntu box to run MathsLive. Idempotent: safe to re-run.
#
#   sudo bash deploy/bootstrap.sh
#
# Installs Node 22, PostgreSQL, Caddy; creates the database and the service
# user; installs the systemd unit. It does NOT start the app — that needs
# deploy/mathslive.env filled in first, which is the next step in DEPLOY.md.
set -euo pipefail

APP_USER=mathslive
APP_DIR=/opt/mathslive
DB_NAME=mathslive
DB_USER=mathslive

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }

log "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw postgresql postgresql-contrib

log "Node 22 (the app needs >= 20)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node -v

log "Caddy (terminates TLS, renews certs by itself)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

log "Service user and directory"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

log "PostgreSQL database"
systemctl enable --now postgresql
# A password is generated once and only written into the env file. Re-running
# the script must not rotate it out from under a working deployment.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  DB_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -qc "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
  echo "$DB_PASS" > /root/.mathslive-db-pass
  chmod 600 /root/.mathslive-db-pass
  echo "    new database password written to /root/.mathslive-db-pass"
else
  echo "    database user already exists — password left alone"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

log "Swap — the difference between a slow minute and a dead process"
# A 1 GB box runs Node AND PostgreSQL AND the OS. Without swap, a momentary
# spike is not slow, it is fatal: the kernel picks the biggest process and
# kills it, which on this box is always the app, and always mid-lesson.
#
# Swap is not extra memory and must not be treated as headroom. It is a shock
# absorber, so a brief overshoot costs latency instead of the class.
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Prefer RAM, but do not refuse swap when it is the alternative to being killed.
sysctl -qw vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
free -h | head -3

log "PostgreSQL tuned for a small box"
# Defaults assume the database owns the machine. Here it is a guest sharing
# 1 GB with the thing that actually serves lessons, so it is capped hard. The
# workload is a handful of small documents, not analytics.
PG_CONF=$(sudo -u postgres psql -tAc 'SHOW config_file;')
if ! grep -q '# mathslive small-box tuning' "$PG_CONF"; then
  cat >> "$PG_CONF" <<'PGTUNE'

# mathslive small-box tuning
shared_buffers = 96MB
work_mem = 4MB
maintenance_work_mem = 32MB
max_connections = 20
effective_cache_size = 256MB
PGTUNE
  systemctl restart postgresql
fi

log "Firewall — only SSH and the web ports"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp   >/dev/null
ufw allow 443/tcp  >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

log "systemd unit"
install -m 644 "$(dirname "$0")/mathslive.service" /etc/systemd/system/mathslive.service
systemctl daemon-reload
systemctl enable mathslive >/dev/null

cat <<'DONE'

Bootstrap complete.

Next, in order (DEPLOY.md has the detail):
  1. clone the repo into /opt/mathslive
  2. write /opt/mathslive/deploy/mathslive.env   (template: mathslive.env.example)
     - DATABASE_URL uses the password in /root/.mathslive-db-pass
  3. npm ci && npm run build     (as the mathslive user)
  4. systemctl start mathslive
  5. put the domain in /etc/caddy/Caddyfile and: systemctl reload caddy

DONE
