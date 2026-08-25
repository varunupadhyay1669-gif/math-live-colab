# Moving MathsLive to AWS Lightsail

The whole point of this order: **the old host keeps teaching classes until the
new one is proven.** Nothing is switched off, and DNS moves last. If anything
goes wrong at any step before the final one, you have lost nothing — you are
still running on Railway and you try again tomorrow.

Budget about two hours, none of it urgent.

---

## What you are building

```
        class.matheinstein.com
                 │
                 ▼
        ┌──────────────────┐
        │  Lightsail 2 GB  │   Mumbai (ap-south-1)
        │                  │
        │  Caddy  :443 ────┼──► TLS, auto-renewed
        │    │             │
        │    ▼             │
        │  node  :4000     │   MathsLive
        │    │             │
        │    ▼             │
        │  postgres :5432  │   rooms + the intelligence schema
        └──────────────────┘
```

Postgres runs **on the same box**, not as a Lightsail Managed Database. The
managed one is about $15/month, which would more than double the bill and cut
the credit's life in half, to buy failover that a one-teacher-at-a-time
platform does not need. The nightly dump in step 8 is the protection that
actually matters here.

---

## 0. Before anything — check the credit's real expiry

AWS credits expire **12 months after the account was opened**, not 12 months
from today. In the console: **Billing → Credits**. If that date is close, this
whole plan is worth less than it looks and you should say so before spending a
weekend on it.

Also confirm you are on the **Free plan**, and note that when the plan lapses
or credits reach zero, AWS *closes the account* unless it is upgraded to Paid.
A card has to go on eventually.

---

## 1. Create the instance

Lightsail → Create instance:

| Setting | Value |
|---|---|
| Region | **Mumbai (ap-south-1)** |
| Platform | Linux/Unix |
| Blueprint | **OS Only → Ubuntu 24.04 LTS** |
| Plan | **$12/month — 2 GB RAM, 2 vCPU, 60 GB SSD** |
| Name | `mathslive` |

Then **Networking → attach a static IP**. Without this the address changes on
restart and DNS silently rots. It is free while attached to a running instance.

> Not the $5 or $7 plan. 512 MB and 1 GB leave no headroom once Postgres is on
> the same box, and running out of memory is the exact failure that took the
> platform down for eight hours in August.

---

## 2. Get the code onto the box

SSH in from the Lightsail console (the browser terminal is fine).

The repo is private, so give the box a read-only key of its own:

```bash
ssh-keygen -t ed25519 -C "lightsail-mathslive" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that line into GitHub → the repo → **Settings → Deploy keys → Add deploy
key** (leave "Allow write access" **off**). Then:

```bash
sudo mkdir -p /opt/mathslive && sudo chown $USER:$USER /opt/mathslive
git clone git@github.com:varunupadhyay1669-gif/math-live-colab.git /opt/mathslive
cd /opt/mathslive
```

---

## 3. Bootstrap

```bash
sudo bash deploy/bootstrap.sh
```

Installs Node 22, PostgreSQL, Caddy; creates the database and service user;
opens only ports 22, 80, 443. Safe to run again if it stops halfway.

It prints where the generated database password went. Keep that terminal.

---

## 4. Configure

```bash
sudo cat /root/.mathslive-db-pass          # the DATABASE_URL password
cp deploy/mathslive.env.example deploy/mathslive.env
nano deploy/mathslive.env                   # fill every blank
sudo chown mathslive:mathslive deploy/mathslive.env
sudo chmod 600 deploy/mathslive.env
```

Copy the secret values across from **Railway → math-live → Variables** (the eye
icon reveals each one). Every value moves as-is except `ALLOWED_ORIGINS`, which
must list the new names.

> **The one that bites.** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are
> baked into the browser bundle at **build** time. If they are blank when step 5
> runs, sign-in does nothing at all and the console says nothing useful. Fill
> them before building, not after.

---

## 5. Build and start

```bash
sudo chown -R mathslive:mathslive /opt/mathslive
sudo -u mathslive bash -c 'cd /opt/mathslive && npm ci && npm run build'
sudo systemctl start mathslive
sudo systemctl status mathslive --no-pager
curl -s localhost:4000/api/healthz
```

Healthy looks like:

```json
{"ok":true,"uptime":3.1,"rooms":0,"durableRooms":true,...}
```

`durableRooms: true` means it reached Postgres. If it is `false`, the
`DATABASE_URL` is wrong — check the journal:

```bash
journalctl -u mathslive -n 50 --no-pager
```

---

## 6. Point the TEST name at it and prove it works

In Hostinger DNS, add an **A record**:

| Type | Name | Value |
|---|---|---|
| A | `aws` | *(the Lightsail static IP)* |

Wait for it to resolve (`nslookup aws.matheinstein.com`), then:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy fetches a certificate within a minute. Now **use it like a real class**
at `https://aws.matheinstein.com`:

- [ ] the passcode screen appears, the code works
- [ ] sign in — the magic-link email arrives and returns you signed in
- [ ] open a room as teacher, join as student in another browser
- [ ] run a lesson: the student sees it, and sees it **change** as you click
- [ ] draw on the whiteboard, and over a shared HTML — the student sees both
- [ ] start a video call and join it from the student side
- [ ] reload the teacher tab: the lesson comes back where it was
- [ ] `curl https://aws.matheinstein.com/api/healthz` → `durableRooms: true`

Any failure here costs nothing. Railway is still serving your real classes.

> Sign-in will fail until `aws.matheinstein.com` **and**
> `class.matheinstein.com` are both in Supabase → Authentication → URL
> Configuration → **Redirect URLs**. Add them now; the failure is silent.

---

## 7. Move the data, then cut over

Do this at a time with no class for a few hours.

**Copy the database.** Get `DATABASE_PUBLIC_URL` from Railway's Postgres
service → Variables, then on the box:

```bash
pg_dump "PASTE_RAILWAY_PUBLIC_URL" --no-owner --no-privileges -Fc -f /tmp/railway.dump
sudo -u postgres pg_restore -d mathslive --no-owner --clean --if-exists /tmp/railway.dump
sudo systemctl restart mathslive
curl -s localhost:4000/api/healthz
```

**Then flip DNS.** Uncomment the `class.matheinstein.com` block in
`/etc/caddy/Caddyfile`, `sudo systemctl reload caddy`, and in Hostinger change
`class` from the Railway CNAME to an **A record** pointing at the static IP.

Propagation is usually minutes. Verify:

```bash
curl -s https://class.matheinstein.com/api/healthz
```

**Leave Railway running for a week.** It costs a few dollars and it is your
rollback: if anything is wrong, point `class` back at the Railway CNAME and you
are restored in minutes. Delete it only once a full week of real classes has
gone by without incident.

---

## 8. The nightly dump — do not skip this

One box means one disk. This is what makes that acceptable.

```bash
sudo tee /etc/cron.daily/mathslive-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
d=/var/backups/mathslive
mkdir -p "$d"
sudo -u postgres pg_dump -Fc mathslive > "$d/mathslive-$(date +%F).dump"
find "$d" -name 'mathslive-*.dump' -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/mathslive-backup
sudo /etc/cron.daily/mathslive-backup && ls -lh /var/backups/mathslive
```

Also turn on **Lightsail → Snapshots → automatic snapshots** (a few cents a
month) — that restores the whole machine, not just the data.

A backup nobody has restored is a rumour. Once, restore the newest dump into a
scratch database and confirm the row counts match.

---

## Afterwards

**Deploying a change** becomes:

```bash
cd /opt/mathslive && sudo -u mathslive git pull \
  && sudo -u mathslive npm ci && sudo -u mathslive npm run build \
  && sudo systemctl restart mathslive
```

**Watching it**: `journalctl -u mathslive -f`

**When the credit runs out** (~12 months from account opening): pay ~$12/month
and change nothing, or move to Oracle Always Free or Hetzner. Every file in
this directory works unchanged on any Ubuntu box — the move is this runbook
again, plus the newest dump from step 8.
