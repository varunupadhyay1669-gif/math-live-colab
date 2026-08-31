// Free trial, subscription, and the manual Paytm confirmation loop.
//
// The money flow here is deliberately NOT automated. A teacher scans a QR
// code, pays by UPI, and tells us they paid; Varun confirms it by hand. That
// is a real design decision, not a shortcut:
//
//   * No payment-gateway account, KYC, settlement account or per-transaction
//     fee is needed to start charging. UPI already works on every phone in
//     India, and ₹500 through a payment gateway loses ~2% plus GST.
//   * Nothing here ever touches card details, a bank account, or a payment
//     API. The server stores a teacher-typed reference string and a boolean.
//     There is no value in this table to steal.
//
// The cost is that a human is in the loop, so a payment is not instant. That
// is why a claim notifies the owner immediately (WhatsApp and email) instead
// of waiting to be noticed, and why confirming is one click on /admin.
//
// If this ever outgrows manual confirmation, the seam is `confirmPayment()` —
// a gateway webhook would call exactly that and nothing else would change.
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import type { Pool } from 'pg';
import { userFromRequest, type SessionUser } from './identity';

/** How long a new teacher may use everything before paying. */
export const TRIAL_DAYS = 7;
/** The monthly price, in rupees. Shown on the payment page and stored per claim. */
export const PRICE_RUPEES = 500;

export const BILLING_SCHEMA_SQL = `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_until       timestamptz;

  -- Existing teachers keep the account age they already had rather than being
  -- handed a fresh trial at deploy time. Idempotent: only ever fills a NULL.
  UPDATE users SET trial_started_at = created_at WHERE trial_started_at IS NULL;

  CREATE TABLE IF NOT EXISTS payment_claims (
    id            text PRIMARY KEY,
    teacher_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_rupees int  NOT NULL,
    months        int  NOT NULL DEFAULT 1,
    reference     text,                      -- the UPI reference the teacher typed
    note          text,
    claimed_at    timestamptz NOT NULL DEFAULT now(),
    confirmed_at  timestamptz,
    confirmed_by  text,
    rejected_at   timestamptz,
    rejected_note text
  );

  CREATE INDEX IF NOT EXISTS payment_claims_open_idx
    ON payment_claims (claimed_at DESC)
    WHERE confirmed_at IS NULL AND rejected_at IS NULL;
`;

export type AccessState = 'trial' | 'active' | 'expired';

export interface Access {
  state: AccessState;
  /** When the current entitlement runs out. Null only if there is no trial date. */
  until: string | null;
  /** Whole days remaining, floored at 0. */
  daysLeft: number;
  priceRupees: number;
  trialDays: number;
}

interface BillingRow {
  trial_started_at: Date | string | null;
  paid_until: Date | string | null;
}

const DAY_MS = 86_400_000;

/**
 * Decide what a teacher is entitled to right now.
 *
 * Paid time always wins over trial time, so confirming a payment during a
 * trial does not shorten anything — the teacher gets the later of the two.
 */
export function accessFrom(row: BillingRow | null | undefined, now = new Date()): Access {
  const base = { priceRupees: PRICE_RUPEES, trialDays: TRIAL_DAYS };
  const t = now.getTime();

  const paid = row?.paid_until ? new Date(row.paid_until).getTime() : null;
  const started = row?.trial_started_at ? new Date(row.trial_started_at).getTime() : null;
  const trialEnds = started === null || !Number.isFinite(started)
    ? null
    : started + TRIAL_DAYS * DAY_MS;

  // Whichever entitlement runs out LATER is the one that governs. Paid time is
  // added alongside trial time, never in place of it — if paid time simply won,
  // a teacher who subscribed on day one of their trial would watch six free
  // days vanish the moment they paid, which is the worst possible lesson to
  // teach someone about paying you early.
  const ends = Math.max(
    paid !== null && Number.isFinite(paid) ? paid : -Infinity,
    trialEnds !== null ? trialEnds : -Infinity,
  );

  // No trial date and no payment: treat as expired rather than granting
  // unlimited access. Every other check in this system fails OPEN so a glitch
  // cannot cancel a lesson; this one fails CLOSED, because "we have no record
  // of you" is not a reason to hand out the product.
  if (!Number.isFinite(ends)) return { ...base, state: 'expired', until: null, daysLeft: 0 };
  if (ends <= t) {
    return { ...base, state: 'expired', until: new Date(ends).toISOString(), daysLeft: 0 };
  }

  return {
    ...base,
    state: paid !== null && paid > t ? 'active' : 'trial',
    until: new Date(ends).toISOString(),
    daysLeft: Math.ceil((ends - t) / DAY_MS),
  };
}

/**
 * Read one teacher's entitlement straight from the database.
 *
 * Platform admins are never billed. Without this the owner's own trial would
 * expire seven days after deploy and lock him out of his own platform — a
 * failure that would look exactly like a broken paywall and arrive at the
 * worst possible moment.
 */
export async function accessForTeacher(pool: Pool, teacherId: string): Promise<Access> {
  const r = await pool.query(
    `SELECT u.trial_started_at, u.paid_until,
            EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = u.email) AS is_admin
       FROM users u WHERE u.id = $1`,
    [teacherId],
  );
  const row = r.rows[0];
  if (row?.is_admin) {
    return { state: 'active', until: null, daysLeft: Number.MAX_SAFE_INTEGER,
      priceRupees: PRICE_RUPEES, trialDays: TRIAL_DAYS };
  }
  return accessFrom(row);
}

/**
 * Extend a teacher's paid period. The single seam through which access is
 * ever granted — a payment gateway webhook would call this and nothing else.
 *
 * Extends from whichever is later, now or the existing expiry, so paying
 * early never costs the teacher the days they already had.
 */
export async function confirmPayment(pool: Pool, teacherId: string, months: number): Promise<string> {
  // Extend from the latest of: now, any existing paid period, and the end of
  // the free trial. Counting from `now` alone would silently eat the trial days
  // a teacher had left when they paid — the same bug accessFrom() guards
  // against, fixed here too so the STORED value is right and not merely
  // displayed correctly.
  const r = await pool.query(
    `UPDATE users
        SET paid_until = GREATEST(
              now(),
              COALESCE(paid_until, to_timestamp(0)),
              COALESCE(trial_started_at + ($3::int * INTERVAL '1 day'), to_timestamp(0))
            ) + ($2::int * INTERVAL '1 month')
      WHERE id = $1
  RETURNING paid_until`,
    [teacherId, months, TRIAL_DAYS],
  );
  return r.rows[0]?.paid_until;
}

// ── Telling the owner a payment arrived ────────────────────────────────────
//
// Two channels, because they fail differently. Email is reliable but easy to
// miss; WhatsApp is impossible to miss but Meta only allows a free-form
// message inside 24 hours of the recipient messaging the business number.
// Sending both means a claim is never silently lost.

async function sendWhatsApp(text: string): Promise<boolean> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const to = process.env.OWNER_WHATSAPP;
  if (!token || !phoneId || !to) return false;
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    });
    if (!res.ok) {
      console.error('WhatsApp refused the alert:', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('WhatsApp alert failed:', (err as Error).message);
    return false;
  }
}

async function sendOwnerEmail(subject: string, body: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.OWNER_EMAIL;
  if (!key || !to) return false;
  const from = process.env.AUTH_EMAIL_FROM || 'MathsLive <login@matheinstein.com>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });
    if (!res.ok) {
      console.error('Resend refused the owner alert:', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Owner email failed:', (err as Error).message);
    return false;
  }
}

/** Both channels, plus the log — which is the one that never fails. */
async function notifyOwner(subject: string, body: string): Promise<void> {
  console.log(`💰 ${subject}\n${body}`);
  const [wa, mail] = await Promise.all([sendWhatsApp(`${subject}\n\n${body}`), sendOwnerEmail(subject, body)]);
  if (!wa && !mail) {
    console.warn('⚠️  Payment alert reached NO channel — set OWNER_EMAIL (and optionally WHATSAPP_TOKEN / WHATSAPP_PHONE_ID / OWNER_WHATSAPP).');
  }
}

function id(): string {
  return `pay_${randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

export function mountBillingRoutes(app: any, pool: Pool, opts: { secret: string }) {
  const { secret } = opts;

  function requireUser(req: Request, res: Response): SessionUser | null {
    const user = userFromRequest(req, secret);
    if (!user) { res.status(401).json({ error: 'Not signed in' }); return null; }
    return user;
  }

  const fail = (res: Response, err: unknown, what: string) => {
    console.error(`${what} failed:`, (err as Error).message);
    res.status(500).json({ error: `Could not ${what}.` });
  };

  async function isAdmin(user: SessionUser): Promise<boolean> {
    const r = await pool.query('SELECT 1 FROM platform_admins WHERE email = $1', [user.email]);
    return (r.rowCount ?? 0) > 0;
  }

  // ── The teacher's own view of their subscription ─────────────────────────
  app.get('/api/billing/status', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      const access = await accessForTeacher(pool, user.id);
      const open = await pool.query(
        `SELECT id, amount_rupees, months, reference, claimed_at
           FROM payment_claims
          WHERE teacher_id = $1 AND confirmed_at IS NULL AND rejected_at IS NULL
          ORDER BY claimed_at DESC LIMIT 1`,
        [user.id],
      );
      res.json({
        ...access,
        admin: await isAdmin(user),
        pendingClaim: open.rows[0] ?? null,
        upiId: process.env.PAYTM_UPI_ID || null,
        payeeName: process.env.PAYTM_PAYEE_NAME || 'MathsLive',
      });
    } catch (err) { fail(res, err, 'check your subscription'); }
  });

  // The QR image itself, kept on disk rather than in the bundle so it can be
  // replaced without a rebuild.
  app.get('/api/billing/qr', async (_req: Request, res: Response) => {
    const file = process.env.PAYTM_QR_PATH || path.join(process.cwd(), 'deploy', 'paytm-qr.png');
    try {
      const bytes = await readFile(file);
      const ext = path.extname(file).toLowerCase();
      res.set('Content-Type', ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png');
      // Short cache: the QR should be replaceable without users holding a stale one.
      res.set('Cache-Control', 'public, max-age=300');
      res.send(bytes);
    } catch {
      res.status(404).json({ error: 'No payment QR has been installed yet.' });
    }
  });

  // ── "I have paid" ────────────────────────────────────────────────────────
  app.post('/api/billing/claim', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const b = (req.body || {}) as { reference?: string; note?: string; months?: number };
    const reference = String(b.reference || '').trim().slice(0, 120);
    const note = String(b.note || '').trim().slice(0, 500);
    const months = Math.min(12, Math.max(1, Number(b.months) || 1));
    if (!reference) {
      return res.status(400).json({ error: 'Please enter the UPI reference number from your payment.' });
    }
    try {
      // One open claim at a time. A teacher tapping twice must not create two
      // rows for Varun to confirm — that is how someone gets two months.
      const existing = await pool.query(
        `SELECT id FROM payment_claims
          WHERE teacher_id = $1 AND confirmed_at IS NULL AND rejected_at IS NULL`,
        [user.id],
      );
      if ((existing.rowCount ?? 0) > 0) {
        return res.status(409).json({ error: 'You already have a payment awaiting confirmation.' });
      }

      const r = await pool.query(
        `INSERT INTO payment_claims (id, teacher_id, amount_rupees, months, reference, note)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, claimed_at`,
        [id(), user.id, PRICE_RUPEES * months, months, reference, note || null],
      );

      void notifyOwner(
        `MathsLive: ${user.email} says they paid ₹${PRICE_RUPEES * months}`,
        [
          `Teacher : ${user.email}`,
          `Amount  : ₹${PRICE_RUPEES * months} (${months} month${months === 1 ? '' : 's'})`,
          `Ref     : ${reference}`,
          note ? `Note    : ${note}` : '',
          '',
          'Check the money arrived, then confirm at:',
          `${process.env.PUBLIC_URL || ''}/admin`,
        ].filter(Boolean).join('\n'),
      );

      res.json({ ok: true, claim: r.rows[0] });
    } catch (err) { fail(res, err, 'record your payment'); }
  });

  // ── Owner side: see and confirm claims ───────────────────────────────────
  app.get('/api/admin/claims', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      if (!await isAdmin(user)) return res.status(403).json({ error: 'Not an admin.' });
      const r = await pool.query(
        `SELECT c.*, u.email AS teacher_email, u.paid_until
           FROM payment_claims c JOIN users u ON u.id = c.teacher_id
          ORDER BY (c.confirmed_at IS NULL AND c.rejected_at IS NULL) DESC,
                   c.claimed_at DESC
          LIMIT 200`);
      res.json({ claims: r.rows });
    } catch (err) { fail(res, err, 'list payment claims'); }
  });

  app.post('/api/admin/claims/:id/confirm', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      if (!await isAdmin(user)) return res.status(403).json({ error: 'Not an admin.' });
      // Claim it first, and only if it is still open. Two admin tabs clicking
      // Confirm must extend the subscription once, not twice.
      const claim = await pool.query(
        `UPDATE payment_claims
            SET confirmed_at = now(), confirmed_by = $2
          WHERE id = $1 AND confirmed_at IS NULL AND rejected_at IS NULL
      RETURNING teacher_id, months`,
        [req.params.id, user.email],
      );
      if (claim.rowCount === 0) {
        return res.status(404).json({ error: 'That claim is not open — it may already be confirmed.' });
      }
      const { teacher_id, months } = claim.rows[0];
      const paidUntil = await confirmPayment(pool, teacher_id, months);
      res.json({ ok: true, paidUntil });
    } catch (err) { fail(res, err, 'confirm the payment'); }
  });

  app.post('/api/admin/claims/:id/reject', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const note = String((req.body || {}).note || '').trim().slice(0, 300);
    try {
      if (!await isAdmin(user)) return res.status(403).json({ error: 'Not an admin.' });
      const r = await pool.query(
        `UPDATE payment_claims SET rejected_at = now(), rejected_note = $2, confirmed_by = $3
          WHERE id = $1 AND confirmed_at IS NULL AND rejected_at IS NULL`,
        [req.params.id, note || null, user.email],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'That claim is not open.' });
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'reject the payment'); }
  });

  /** Grant time by hand — for a bank transfer, a refund, or a goodwill month. */
  app.post('/api/admin/grant', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const b = (req.body || {}) as { email?: string; months?: number };
    const months = Math.min(24, Math.max(1, Number(b.months) || 1));
    try {
      if (!await isAdmin(user)) return res.status(403).json({ error: 'Not an admin.' });
      const t = await pool.query('SELECT id FROM users WHERE email = $1', [String(b.email || '').trim()]);
      if (t.rowCount === 0) return res.status(404).json({ error: 'No teacher with that email.' });
      const paidUntil = await confirmPayment(pool, t.rows[0].id, months);
      res.json({ ok: true, paidUntil });
    } catch (err) { fail(res, err, 'grant access'); }
  });
}
