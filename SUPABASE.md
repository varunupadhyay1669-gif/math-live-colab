# SUPABASE.md — Teacher accounts & records

Math Live can run in two modes:

- **No-login (default).** If the Supabase env vars are absent, the app behaves
  exactly as it always has: anyone opens `/room/<code>` as teacher, students
  join `/live/<code>`. Nothing below is required.
- **Teacher accounts (opt-in).** Set the two `VITE_` env vars and teachers must
  sign in with Google to create/manage rooms. Each teacher gets a private list
  of classes (one per student) and per-student session history. **Students
  never sign in** — they still just open the link you share.

This doc is the setup + data-model contract. Read it before touching auth.

---

## The model

| Actor   | Auth            | Owns                                             |
|---------|-----------------|--------------------------------------------------|
| Teacher | Google sign-in  | Their `classes` rows and `sessions` rows (RLS).  |
| Student | None (link only)| Nothing — joins `/live/<room_code>` as today.    |

Live room state (whiteboard/HTML) stays in the durable room store (Upstash —
see the room store in `server.ts`). Supabase holds **accounts + the class
registry + session history**, not the live socket state.

---

## One-time setup (≈10 min)

### 1. Create the project
1. Go to <https://supabase.com> → **New project**. Pick a region near your
   students. Wait for it to provision.

### 2. Create the database schema
Open **SQL Editor** → paste and run the block in [§ Schema](#schema) below.
This creates the `classes` and `sessions` tables and the Row-Level Security
policies that ensure each teacher only ever sees their own rows.

### 3. Sign-in: email magic-link (no extra provider setup)
The app uses passwordless **email magic-links**, which are enabled by default
on every Supabase project — no Google Cloud / OAuth client needed. You only
have to allowlist where the link is allowed to land:

1. Supabase → **Authentication → URL Configuration**:
   - **Site URL** = your app URL (e.g. `https://math-live-colab.onrender.com`).
   - **Redirect URLs** = add `<your app URL>/dashboard` (the link lands the
     teacher on their dashboard) and, for local dev, `http://localhost:3000/dashboard`.
2. (Optional) Authentication → Providers → **Email** is on by default. The
   built-in mailer is fine for testing; for production volume, configure your
   own SMTP under Authentication → Emails so links always deliver.

> Want Google one-click later instead? Create a Google OAuth client, paste it
> into Auth → Providers → Google, and swap `signInWithEmail` for
> `signInWithOAuth({ provider: 'google' })` in `src/lib/auth.tsx`.

### 4. Set environment variables

**Client (required to turn auth on) — set in Render *before* the build, and in
a local `.env` for dev:**

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon/public key>
```

> These are the *public* anon keys — safe in the browser. RLS is what protects
> the data. Vite inlines `VITE_*` at build time, so on Render they must exist
> **before** `npm run build` runs (set them, then redeploy).

**Server (enables ownership enforcement — Stage 3):** set these three on
Render so a registered class can only be DRIVEN by its owning teacher. All
gated — absent → no enforcement (legacy name-based behaviour, no regression).

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon/publishable key>       # used to verify the teacher's token
SUPABASE_SERVICE_ROLE_KEY=<service-role key>   # server-only, NEVER in client — reads class owner
```

Find these in Supabase → Project Settings → API. The service-role key is a
full-access secret — keep it server-side only (it is never sent to the
browser). After setting them, redeploy; the server logs
`🔒 Teacher ownership enforcement: ON`.

### 5. Redeploy
Once `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are set and the app
rebuilds, the teacher path on the home screen shows **Sign in with Google**.
With the vars absent, it shows the original name form. No code change either
way.

---

## Schema

```sql
-- Teachers are Supabase auth.users; everything is keyed by auth.uid().

create table if not exists public.classes (
  id             uuid primary key default gen_random_uuid(),
  teacher_id     uuid not null references auth.users(id) on delete cascade,
  student_name   text not null,
  label          text,
  room_code      text not null unique,         -- the permanent /live/<code> link
  created_at     timestamptz not null default now(),
  last_opened_at timestamptz
);
create index if not exists classes_teacher_idx on public.classes(teacher_id);

create table if not exists public.sessions (
  id                  uuid primary key default gen_random_uuid(),
  class_id            uuid not null references public.classes(id) on delete cascade,
  teacher_id          uuid not null references auth.users(id) on delete cascade,
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  topic               text,         -- "what was taught"
  notes               text,
  whiteboard_snapshot jsonb,        -- saved board for reopening later
  html_used           text
);
create index if not exists sessions_class_idx   on public.sessions(class_id);
create index if not exists sessions_teacher_idx on public.sessions(teacher_id);

-- Row-Level Security: a teacher can only read/write their own rows.
alter table public.classes  enable row level security;
alter table public.sessions enable row level security;

create policy "classes owned by teacher" on public.classes
  for all using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);

create policy "sessions owned by teacher" on public.sessions
  for all using (auth.uid() = teacher_id) with check (auth.uid() = teacher_id);
```

---

## Build status & plan

- [x] **Foundation (shipped):** Supabase client, `AuthProvider`/`useAuth`,
      email magic-link sign-in gate on the teacher path, feature-flagged so the
      no-login app is unchanged. SDK is lazy-loaded only when auth is enabled.
- [x] **Teacher dashboard (shipped):** `/dashboard` lists classes (one per
      student) + their permanent links; create / delete a class (generates a
      unique `room_code`); open the room; copy link. CRUD via supabase-js under
      RLS.
- [x] **Ownership enforcement (shipped):** on join, the teacher's Supabase
      token is verified via Supabase's own endpoints and checked against the
      `classes` owner; a non-owner is rejected from a registered class. Ad-hoc
      rooms keep legacy behaviour. Activate with the three server env vars
      above.
- [x] **Session history (shipped):** in a room, "💾 Save to history" writes a
      `sessions` row (date, topic, whiteboard snapshot, HTML used) for that
      student's class. The dashboard shows each student's past sessions and
      "Reopen" re-seeds a room with that saved HTML + whiteboard
      (`/room/<code>?session=<id>`).

To build the dashboard I need the project live: do steps 1–4 above, then share
your **`VITE_SUPABASE_URL`** and **`VITE_SUPABASE_ANON_KEY`** (these are public)
so I can wire and test the screens against your real project.
