# Putting MathsLive on matheinstein.com

## Read this first

`matheinstein.com` is **already live and serving your business site from
Vercel**. Verified:

```
matheinstein.com        A       216.198.79.1          (Vercel)   → HTTP 200
www.matheinstein.com    CNAME   cname.vercel-dns.com  (Vercel)   → HTTP 200
nameservers             ns1.dns-parking.com / ns2.dns-parking.com  (Hostinger)
```

**Do not point the apex (`matheinstein.com`) or `www` at MathsLive.** That
would take your website down. Every instruction below uses a *subdomain*, which
leaves the site untouched.

DNS is managed at **Hostinger** (the `dns-parking.com` nameservers are theirs),
so all records go in the Hostinger DNS editor — not in Vercel.

## The subdomain

`class.matheinstein.com` is free (checked — it does not resolve). So are
`live.` and `app.`. Pick one; the rest of this assumes `class`.

A student link then reads:

```
https://class.matheinstein.com/live/<room-code>
```

## What to point it at

The record depends on where the app is actually running. **The Cloudflare quick
tunnel currently in use cannot be given a custom domain** — it gets a random
`*.trycloudflare.com` name that changes on every restart. It is a stopgap, not
a destination.

### Option A — the Oracle Always Free VM (recommended)

Permanent, free, and the app already has a script for it
(`deploy/oracle-setup.sh`).

1. Create the VM, note its **public IP**.
2. In Hostinger → DNS:

   | Type | Name    | Value            | TTL  |
   |------|---------|------------------|------|
   | A    | `class` | `<VM public IP>` | 3600 |

3. Wait for it to resolve (usually minutes):
   `nslookup class.matheinstein.com 8.8.8.8`
4. On the VM:

   ```bash
   sudo DOMAIN=class.matheinstein.com bash oracle-setup.sh
   ```

   Caddy fetches a Let's Encrypt certificate by itself. Nothing else to do.

### Option B — Render, once it is unsuspended

1. Render dashboard → the service → **Settings → Custom Domains → Add**.
2. Render shows a target like `math-live-colab.onrender.com`.
3. In Hostinger → DNS:

   | Type  | Name    | Value                            | TTL  |
   |-------|---------|----------------------------------|------|
   | CNAME | `class` | `math-live-colab.onrender.com`   | 3600 |

Render issues the certificate once it sees the record. Remember the free tier's
750 monthly hours still apply — set `KEEP_WARM=off` or the same suspension
follows.

## Why it must be HTTPS

Not cosmetic. Browsers block `getUserMedia` and `getDisplayMedia` on plain
`http://`, so on an unencrypted address the video call, the microphone
narration and both directions of screen sharing all silently fail. Both options
above give a real certificate; a bare IP address does not.

## Nothing to change in the app

Socket CORS is open unless `ALLOWED_ORIGINS` is set, so a new hostname works
immediately. If you later want to lock it down:

```
ALLOWED_ORIGINS=https://class.matheinstein.com
```

Set that only once the domain is live — an origin list that does not include
the address people actually use blocks every socket, and the symptom is a room
that connects and then does nothing.

## Checks after the DNS change

```bash
nslookup class.matheinstein.com 8.8.8.8        # points where you expect
curl -I https://class.matheinstein.com/healthz  # 200, and a valid certificate
curl -I https://matheinstein.com                # STILL 200 — the site is fine
```

That last one is the one people forget. Run it.
