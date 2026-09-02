// Teacher identity, without a third party.
//
// This replaces Supabase Auth. The shape is deliberately the smallest thing
// that is actually safe:
//
//   1. teacher types an email        -> POST /api/auth/magic-link
//   2. a single-use token is emailed -> GET  /api/auth/callback?token=...
//   3. a signed cookie is set        -> GET  /api/auth/me returns the teacher
//
// Why not Cognito, Auth0 or another Supabase: the requirement is one tutor and
// a handful of colleagues signing in by email. The whole of that is a table, a
// hash, and an HMAC. Every hosted option costs a vendor, an outage surface and
// a migration; none of them removes work at this size.
//
// SECURITY NOTES, because auth written casually is auth written badly:
//
//   * The token is 32 random bytes. Only its SHA-256 goes in the database, so a
//     database leak does not hand over live login links.
//   * Tokens are single-use and expire in 15 minutes. Consuming one is an
//     atomic UPDATE ... WHERE used_at IS NULL RETURNING, so two clicks on the
//     same link cannot both succeed.
//   * The session cookie is HttpOnly, Secure, SameSite=Lax, and signed with
//     HMAC-SHA256. It carries no secret — just id, email and expiry — and is
//     verified with a constant-time compare on every request.
//   * Sign-in never says whether an address is known. "Check your email" is the
//     answer either way, so this cannot be used to enumerate teachers.
import type { Request, Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Pool } from 'pg';

export const IDENTITY_SCHEMA_SQL = `
  -- A teacher. Email is the identity; there is no password to leak.
  CREATE TABLE IF NOT EXISTS users (
    id            text PRIMARY KEY,
    email         text UNIQUE NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  );

  -- Outstanding magic links. Only the HASH of the token is stored.
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash text PRIMARY KEY,
    email      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
  );
  CREATE INDEX IF NOT EXISTS auth_tokens_expires_idx ON auth_tokens (expires_at);

  -- A class: one student's permanent room. Mirrors what Supabase held, minus
  -- row-level security — the equivalent guarantee is now that every query in
  -- records.ts is scoped by teacher_id taken from the verified session cookie,
  -- never from anything the browser sends.
  CREATE TABLE IF NOT EXISTS classes (
    id             text PRIMARY KEY,
    teacher_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    student_name   text NOT NULL,
    label          text,
    room_code      text UNIQUE NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_opened_at timestamptz,
    grade          text,
    level          text,
    goals          text,
    avatar         text,
    textbook       text
  );
  CREATE INDEX IF NOT EXISTS classes_teacher_idx ON classes (teacher_id, last_opened_at DESC NULLS LAST);

  -- A taught session. NOT called "sessions": the intelligence schema already
  -- owns that name for something else, and two tables with one name in one
  -- database is a bug waiting for a tired evening.
  CREATE TABLE IF NOT EXISTS teaching_sessions (
    id                  text PRIMARY KEY,
    class_id            text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    teacher_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at          timestamptz NOT NULL DEFAULT now(),
    ended_at            timestamptz,
    topic               text,
    notes               text,
    whiteboard_snapshot jsonb,
    html_used           text,
    taught_seconds      integer
  );
  CREATE INDEX IF NOT EXISTS teaching_sessions_class_idx ON teaching_sessions (class_id, started_at DESC);

  -- Who may read across every tutor. Deliberately a table rather than a flag on
  -- users: granting admin should be a visible, deliberate INSERT.
  CREATE TABLE IF NOT EXISTS blocked_emails (
    email      text PRIMARY KEY,
    blocked_at timestamptz NOT NULL DEFAULT now(),
    reason     text
  );

  CREATE TABLE IF NOT EXISTS platform_admins (
    email      text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

export interface SessionUser { id: string; email: string; }

const COOKIE = 'ml_session';
const SESSION_DAYS = 30;
const TOKEN_TTL_MS = 15 * 60 * 1000;

function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Sign a session payload. The result is `<payload>.<signature>`; the payload is
 * readable by anyone holding the cookie, which is fine — it contains only what
 * the holder already knows about themselves. The signature is what matters.
 */
function signSession(user: SessionUser, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify({
    uid: user.id,
    em: user.email,
    exp: Date.now() + SESSION_DAYS * 86400_000,
  })));
  const sig = b64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Verify and decode. Returns null for anything not exactly right. */
export function readSession(raw: string | undefined, secret: string): SessionUser | null {
  if (!raw || !secret) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = unb64url(raw.slice(dot + 1));
  const want = createHmac('sha256', secret).update(payload).digest();
  // Lengths must match before timingSafeEqual, which throws on a mismatch —
  // and an exception here would read as "no session" anyway, so check first.
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  try {
    const p = JSON.parse(unb64url(payload).toString());
    if (!p?.uid || !p?.em || typeof p.exp !== 'number' || Date.now() > p.exp) return null;
    return { id: p.uid, email: p.em };
  } catch { return null; }
}

/** Cookies without a dependency. One header, one map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function userFromRequest(req: Request, secret: string): SessionUser | null {
  return readSession(parseCookies(req.headers.cookie)[COOKIE], secret);
}

/** The same check for a Socket.IO handshake, which carries the cookie header. */
export function userFromCookieHeader(header: string | undefined, secret: string): SessionUser | null {
  return readSession(parseCookies(header)[COOKIE], secret);
}

function setSessionCookie(res: Response, value: string, secure: boolean) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` +
    (secure ? '; Secure' : ''));
}
function clearSessionCookie(res: Response, secure: boolean) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (secure ? '; Secure' : ''));
}

/**
 * Send the link. Resend if a key is configured; otherwise the link is logged
 * so local development needs no mail provider at all.
 *
 * Returns false only when a REAL send was attempted and failed, so the caller
 * can tell the teacher the truth instead of "check your email" forever.
 */
async function deliverMagicLink(email: string, link: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM || 'MathsLive <login@matheinstein.com>';
  if (!key) {
    console.log(`\n🔑 MAGIC LINK for ${email} (no RESEND_API_KEY set, so not emailed):\n   ${link}\n`);
    return true;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Your MathsLive sign-in link',
        html:
          `<p>Hello,</p>` +
          `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none">Sign in to MathsLive</a></p>` +
          `<p>Or paste this into your browser:<br><span style="font-family:monospace">${link}</span></p>` +
          `<p>The link works once and expires in 15 minutes. If you did not ask for it, ignore this email — nothing will happen.</p>`,
        text: `Sign in to MathsLive:\n\n${link}\n\nThe link works once and expires in 15 minutes.`,
      }),
    });
    if (!res.ok) {
      console.error('Resend refused the sign-in email:', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Could not send the sign-in email:', (err as Error).message);
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Wire the auth routes onto an Express app.
 *
 * `secret` signs sessions — it MUST be stable across restarts or every teacher
 * is signed out on deploy, and it must not be guessable.
 */
export function mountAuthRoutes(app: any, pool: Pool, opts: { secret: string; secure: boolean }) {
  const { secret, secure } = opts;

  // Ask for a link. Deliberately always answers the same way.
  app.post('/api/auth/magic-link', async (req: Request, res: Response) => {
    const email = String((req.body as any)?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    try {
      // Blocked for good. Refused here rather than at the callback so no link
      // is ever created or emailed — and answered with the same shape a normal
      // request gets, because telling someone their address is specifically
      // barred invites them to try another one.
      const blocked = await pool.query('SELECT 1 FROM blocked_emails WHERE email = $1', [email]);
      if ((blocked.rowCount ?? 0) > 0) {
        console.log(`⛔ sign-in refused for blocked address ${email}`);
        return res.json({ ok: true });
      }

      const raw = b64url(randomBytes(32));
      await pool.query(
        `INSERT INTO auth_tokens (token_hash, email, expires_at)
         VALUES ($1, $2, now() + interval '15 minutes')`,
        [sha256(raw), email],
      );
      // Housekeeping is cheap here and saves a cron job.
      pool.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'`).catch(() => {});

      const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '')
        || `${req.protocol}://${req.get('host')}`;
      const ok = await deliverMagicLink(email, `${base}/api/auth/callback?token=${raw}`);
      if (!ok) return res.status(502).json({ error: 'Could not send the email. Try again in a minute.' });
      res.json({ ok: true });
    } catch (err) {
      console.error('magic-link failed:', (err as Error).message);
      res.status(500).json({ error: 'Could not start sign-in.' });
    }
  });

  // Click the link. Consumes the token, creates the teacher if new, redirects.
  app.get('/api/auth/callback', async (req: Request, res: Response) => {
    const raw = String(req.query.token || '');
    const fail = (why: string) => res.redirect(`/?auth_error=${encodeURIComponent(why)}`);
    if (!raw) return fail('missing');
    try {
      // Single-use, atomically. Two clicks race here and exactly one wins.
      const claim = await pool.query(
        `UPDATE auth_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING email`,
        [sha256(raw)],
      );
      if (claim.rowCount === 0) return fail('expired');
      const email = claim.rows[0].email as string;

      // Checked a second time: a link issued before the block must not still
      // work. The token is already spent by the UPDATE above, so a refusal
      // here also burns it rather than leaving it reusable.
      const barred = await pool.query('SELECT 1 FROM blocked_emails WHERE email = $1', [email]);
      if ((barred.rowCount ?? 0) > 0) {
        console.log(`⛔ callback refused for blocked address ${email}`);
        return fail('blocked');
      }

      const id = `u_${b64url(randomBytes(9))}`;
      // `trial_started_at` is set HERE, at the moment the account is created.
      //
      // It used to be set only by the boot-time schema statement in billing.ts
      // ("UPDATE users SET trial_started_at = created_at WHERE ... IS NULL"),
      // which meant a teacher who signed up between two restarts had no trial
      // date at all. `accessFrom()` treats a row with neither a trial date nor
      // a payment as EXPIRED — deliberately, because "no record of you" is not
      // a reason to hand out the product — so the socket refused them the
      // teacher seat with "Your free trial has ended", on their first lesson,
      // before it had begun. The one message a new teacher must never see.
      //
      // ON CONFLICT deliberately does NOT touch it: signing in again must not
      // restart a trial that is already running, or ending.
      const user = await pool.query(
        `INSERT INTO users (id, email, last_login_at, trial_started_at)
              VALUES ($1, $2, now(), now())
         ON CONFLICT (email) DO UPDATE SET last_login_at = now()
      RETURNING id, email`,
        [id, email],
      );
      setSessionCookie(res, signSession({ id: user.rows[0].id, email }, secret), secure);
      res.redirect('/dashboard');
    } catch (err) {
      console.error('auth callback failed:', (err as Error).message);
      fail('server');
    }
  });

  app.get('/api/auth/me', (req: Request, res: Response) => {
    const user = userFromRequest(req, secret);
    res.json({ user: user ? { id: user.id, email: user.email } : null });
  });

  app.post('/api/auth/signout', (_req: Request, res: Response) => {
    clearSessionCookie(res, secure);
    res.json({ ok: true });
  });
}
