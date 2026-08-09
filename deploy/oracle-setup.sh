#!/usr/bin/env bash
#
# MathsLive on an Oracle Cloud Always Free VM.
#
# WHY THIS EXISTS
# Render's free tier gives 512MB and 750 instance-hours per month across the
# whole workspace. Keeping the server awake costs ~730 of those hours, so one
# always-on service consumes essentially the entire allowance — which is how
# the account came to be suspended with every service down at once.
#
# Oracle's Always Free tier, by contrast, is documented as free "for the life
# of the account":
#     Ampere A1 ARM   1,500 OCPU-hours + 9,000 GB-hours per month
#                     = 2 OCPUs and 12 GB RAM, running continuously
#     Outbound data   10 TB per month
#     Block storage   200 GB
#
# That is 24x the memory of the Render free instance, no monthly hour quota,
# and no sleeping. The catch is that it is a bare Linux box: this script is
# what turns it into a running, HTTPS-served MathsLive so you do not have to
# become a sysadmin to use it.
#
# WHAT IT DOES
#   - installs Node 20, git and Caddy (Caddy gets a real TLS certificate
#     automatically, so students get https:// with no certificate work)
#   - clones the repo and builds it
#   - writes the environment file, including the site passcode
#   - installs a systemd service so it restarts on crash AND on reboot
#   - opens ports 80/443 in the VM firewall
#
# RUN IT AS:
#   curl -fsSL <this file's raw URL> -o setup.sh && sudo bash setup.sh
# or copy it onto the VM and:  sudo bash oracle-setup.sh
#
set -euo pipefail

# ── Things you may want to change ────────────────────────────────────────
REPO="${REPO:-https://github.com/varunupadhyay1669-gif/math-live-colab.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/mathslive}"
APP_USER="${APP_USER:-mathslive}"
APP_PORT="${APP_PORT:-4000}"
# Your domain, if you have one. Leave blank and Caddy serves over the VM's IP
# on plain HTTP — fine for a first test, but see the warning at the end:
# camera, microphone and screen sharing need HTTPS.
DOMAIN="${DOMAIN:-}"
# Heap ceiling. The A1 free shape has 12GB, so this is generous compared with
# the 256MB the 512MB Render box needed. Node must still be told a number, or
# it sizes its heap from total system memory and grows until something kills
# it — that is exactly what took the Render service down.
NODE_HEAP_MB="${NODE_HEAP_MB:-2048}"

need() { command -v "$1" >/dev/null 2>&1; }
say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo bash $0" >&2
  exit 1
fi

say "Installing Node 20, git and Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! need node || [ "$(node -v | cut -c2-3)" -lt 20 ] 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

if ! need caddy; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

say "Creating the service user and fetching the code"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all -q && git -C "$APP_DIR" reset --hard "origin/$BRANCH" -q
else
  rm -rf "$APP_DIR"
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Installing dependencies and building (a few minutes on the free ARM shape)"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm install --no-audit --no-fund && npm run build"

# ── Environment ──────────────────────────────────────────────────────────
# Written 0600 and owned by the service user: the passcode and the Supabase
# keys live here, and this file must not be world-readable.
if [ ! -f "$APP_DIR/.env.production" ]; then
  say "Writing the environment file — EDIT IT before going live"
  cat > "$APP_DIR/.env.production" <<ENVEOF
# Everyone must present this before the server will do anything.
SITE_PASSCODE=9456

# Supabase — copy these from your existing Render service's Environment tab,
# or from the Supabase dashboard (Project Settings -> API).
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Rooms that survive a restart. Free at upstash.com (Redis -> Create).
# Without these, a restart empties every live room.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# This box does not sleep and has no hour quota, so the self-ping that caused
# the Render quota problem is pointless here.
KEEP_WARM=off

NODE_ENV=production
PORT=$APP_PORT
NODE_HEAP_MB=$NODE_HEAP_MB
MEMORY_BUDGET_MB=1536
ENVEOF
  chmod 600 "$APP_DIR/.env.production"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env.production"
fi

say "Installing the systemd service"
cat > /etc/systemd/system/mathslive.service <<UNITEOF
[Unit]
Description=MathsLive
After=network-online.target
Wants=network-online.target
# These belong in [Unit], NOT [Service]. Put in [Service] systemd logs
# "Unknown key name ... ignoring" and the crash-loop protection silently does
# nothing — a failing service then restarts every 5s forever. Caught by
# systemd-analyze verify against a real Ubuntu, not by reading it.
StartLimitBurst=5
StartLimitIntervalSec=120

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env.production
# The heap cap matters as much here as it did on Render. Without it Node sizes
# its heap from total system memory and grows until the OOM killer intervenes.
ExecStart=/usr/bin/node --max-old-space-size=\${NODE_HEAP_MB} $APP_DIR/node_modules/tsx/dist/cli.mjs $APP_DIR/server.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable mathslive >/dev/null

say "Configuring Caddy (HTTPS, and WebSocket pass-through)"
if [ -n "$DOMAIN" ]; then
  # Caddy obtains and renews a Let's Encrypt certificate by itself.
  cat > /etc/caddy/Caddyfile <<CADDYEOF
$DOMAIN {
	encode zstd gzip
	# reverse_proxy passes Upgrade/Connection headers through untouched, which
	# is what Socket.IO needs. No extra WebSocket config is required.
	reverse_proxy 127.0.0.1:$APP_PORT
}
CADDYEOF
else
  cat > /etc/caddy/Caddyfile <<CADDYEOF
:80 {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
CADDYEOF
fi
systemctl restart caddy

say "Opening the firewall"
# Oracle images ship with iptables rules that block everything but SSH, and
# they persist across reboots — forgetting this is the classic "the VM is
# running but nothing loads" hour.
if need iptables; then
  iptables -I INPUT 5 -p tcp --dport 80  -j ACCEPT 2>/dev/null || true
  iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
  netfilter-persistent save >/dev/null 2>&1 || iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
fi
if need firewall-cmd; then
  firewall-cmd --permanent --add-service=http  >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

say "Starting MathsLive"
systemctl restart mathslive
sleep 5
if curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null; then
  echo "  healthz OK"
else
  warn "The app did not answer yet. Check:  journalctl -u mathslive -n 50 --no-pager"
fi

cat <<DONEEOF

────────────────────────────────────────────────────────────────
 Done. Before you teach on it:

 1. EDIT  $APP_DIR/.env.production
    The Supabase URL and key are blank — without them there are no
    student records, no lesson history and no admin page. Copy them
    from your Render service's Environment tab.
    Then:  sudo systemctl restart mathslive

 2. OPEN THE PORTS IN ORACLE'S CONSOLE TOO.
    The VM firewall above is only half of it. In the Oracle console go to
    Networking -> Virtual Cloud Networks -> your VCN -> Security Lists and
    add ingress rules for TCP 80 and 443 from 0.0.0.0/0. Miss this and the
    site is unreachable even though everything here is running.

 3. USE A DOMAIN, not the bare IP.
    Camera, microphone and screen sharing are blocked by browsers on plain
    http://. Point a domain at this VM's public IP, then re-run:
        sudo DOMAIN=your.domain bash $0
    Caddy will fetch a certificate automatically.

 Useful afterwards:
   sudo systemctl status mathslive
   sudo journalctl -u mathslive -f          # live logs
   cd $APP_DIR && sudo -u $APP_USER git pull && sudo -u $APP_USER npm run build \\
     && sudo systemctl restart mathslive     # deploy a new version
────────────────────────────────────────────────────────────────
DONEEOF
