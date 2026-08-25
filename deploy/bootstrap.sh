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
