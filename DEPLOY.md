# DEPLOY.md — Production deployment

Math Live needs a long-lived Node process (Socket.IO + Express + Vite SSR
serve). It cannot run on a static-only host (Netlify, Vercel static, GitHub
Pages). Use any Node-capable host.

The repo ships ready-to-deploy on **Render** out of the box. Same code runs
unchanged on Railway, Fly.io, or any VPS.

---

## Option A — Render (recommended, free tier works)

The repo includes `render.yaml` (Blueprint).

1. Push the repo to GitHub (already done).
2. Go to https://dashboard.render.com → **New +** → **Blueprint**.
3. Connect your GitHub account, select the `math-live-colab` repo, branch
   `main`.
4. Render reads `render.yaml`, shows one service called `math-live`. Click
   **Apply**.
5. First build takes ~3 minutes. When it goes green, open the URL Render gives
   you (this repo deploys at `https://math-live-colab.onrender.com`).

### Environment variables (optional features)
Set these in Render → your service → **Environment**, then **Manual Deploy →
Clear build cache & deploy** (the `VITE_*` vars are inlined at *build* time, so
they only take effect on a rebuild — setting them without redeploying does
nothing):

| Var | Enables | Notes |
|-----|---------|-------|
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | Teacher accounts (login + dashboard) | Public keys. Without them the app runs in no-login mode. See `SUPABASE.md`. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Durable rooms across restarts | Without them rooms persist to `.rooms/` only (wiped on free-tier restart). |
| `GEMINI_API_KEY` | "✨ AI Lesson" — generate interactive lessons from a prompt | Server-side only (never sent to the browser). Get a key at aistudio.google.com. Without it the AI button shows a "not configured" message. |

### Free-plan caveats
- Service **sleeps after 15 min of inactivity**. First request after sleep
  takes ~30 s to cold-start. For a real classroom, upgrade to Starter ($7/mo)
  to keep it warm.
- `.rooms/` persistence is **in-memory only** on free plan (no disk).
  Sessions reset on restart. Fine for trials and short demos.
- To enable persistence: upgrade plan, then uncomment the `disk:` block in
  `render.yaml` and re-deploy.

---

## Option B — Railway

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**.
2. Pick `math-live-colab`. Railway auto-detects Node.
3. Set environment variable:
   - `NODE_ENV` = `production`
4. Override start command if needed: `npm run build && npm start`.
5. Add a public domain in **Settings → Networking → Generate Domain**.

---

## Option C — Fly.io

```bash
flyctl launch --no-deploy   # accept defaults, region near your users
flyctl deploy
```

`flyctl launch` will generate `fly.toml` and a `Dockerfile`. Use these defaults:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
```

In `fly.toml` set `internal_port = 3000` and add a volume for `.rooms/` if you
want persistence.

---

## Option D — Any VPS with Docker

```bash
# On the server
git clone <repo>
cd collaborative-sandbox
docker build -t math-live .
docker run -d --name math-live -p 80:3000 \
  -v $(pwd)/.rooms:/app/.rooms \
  -e NODE_ENV=production \
  --restart unless-stopped \
  math-live
```

Then point your domain at the server and front it with Caddy/Nginx for HTTPS.

---

## Production checklist

- [ ] `npm run build` succeeds locally.
- [ ] `node node_modules/typescript/bin/tsc --noEmit` passes.
- [ ] `NODE_ENV` set to `production` on the host.
- [ ] Host supports WebSockets (Render/Railway/Fly all do; some PaaS proxies
      need explicit websocket enablement).
- [ ] Persistent volume mounted at `.rooms/` if you want sessions to survive
      restarts (optional).
- [ ] `PORT` env var respected — server reads `process.env.PORT`.
- [ ] CORS — `server.ts` currently uses `cors: { origin: '*' }`. Tighten this
      to your real domain before going to production:

      ```ts
      const io = new Server(httpServer, {
        cors: { origin: ['https://yourdomain.com'] },
      });
      ```

---

## Verifying a deploy

1. Open `https://<your-host>/` — should show the redesigned home page.
2. **Teacher tab:** create a session, upload an HTML simulation.
3. **Second tab/incognito:** join with the room code as a student.
4. Confirm:
   - student sees the simulation immediately (canonical `session_state` works)
   - teacher scroll/click is mirrored
   - whiteboard strokes/images sync
   - reconnect (toggle student wifi) — student rejoins and re-syncs

If any of those fail, check `SYNC.md` and the server logs (look for
`scope: "sync"` JSON lines).
