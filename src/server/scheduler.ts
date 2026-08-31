// Mail that has to go out on its own: expiry warnings, and the owner's digest.
//
// Two hard problems here, both solved the same way.
//
// EXACTLY ONCE. This runs inside the app process, so a restart, a second
// deploy, or two overlapping timers must not send a teacher the same warning
// twice — the fastest way to make a ₹500 product feel like a scam is to email
// someone three times about the same expiry. Every send first claims a row in
// mail_log; the INSERT is the lock, and it either returns a row (nobody sent
// this yet, go ahead) or it does not (someone did, stop). That makes the
// database the arbiter rather than any in-process flag, which is the only
// thing that survives a restart mid-run.
//
// THE RIGHT DAY. The server's clock is UTC and every teacher is in India. Ask
// "has today's mail gone?" in UTC and the answer flips at 5:30am IST, so a
// teacher can get yesterday's warning again over breakfast. Every date here is
// an IST date.
import type { Pool } from 'pg';
import { accessFrom, TRIAL_DAYS, PRICE_RUPEES, GRACE_DAYS } from './billing';
import { sendMail, ownerAddresses, siteUrl, istDay, istHour, niceDate } from './mailer';

export const MAIL_LOG_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mail_log (
    kind    text NOT NULL,          -- 'warn_2' | 'warn_1' | 'grace' | 'digest'
    target  text NOT NULL,          -- teacher id, or 'owner'
    day     date NOT NULL,          -- the IST date it was sent for
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, target, day)
  );
`;

/** The hour in India at which the daily run happens. */
const SEND_HOUR_IST = 8;

/**
 * Claim the right to send one email. Returns false if it has already gone.
 *
 * This is the whole exactly-once mechanism: an INSERT that either wins or
 * loses, with the primary key doing the arbitration.
 */
async function claim(pool: Pool, kind: string, target: string, day: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO mail_log (kind, target, day) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING 1`,
    [kind, target, day],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── Teacher-facing: nobody should be surprised by the paywall ──────────────

interface WarnRow {
  id: string; email: string;
  trial_started_at: string | null; paid_until: string | null;
}

function warningFor(state: string, daysLeft: number): 'warn_2' | 'warn_1' | 'grace' | null {
  if (state === 'grace') return 'grace';
  if (state === 'trial' || state === 'active') {
    if (daysLeft === 2) return 'warn_2';
    if (daysLeft === 1) return 'warn_1';
  }
  return null;
}

function warningMail(kind: string, a: ReturnType<typeof accessFrom>): { subject: string; body: string } {
  const pay = `Subscribe here: ${siteUrl()}/billing`;
  const safe = 'Whatever you decide, your students, classes and saved boards stay exactly as they are.';
  if (kind === 'grace') {
    return {
      subject: `MathsLive — your access ended, ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} of grace left`,
      body: [
        `Your MathsLive access ran out on ${niceDate(a.until)}.`,
        '',
        `You can still teach for ${a.daysLeft} more day${a.daysLeft === 1 ? '' : 's'} while you renew —`,
        'no lesson will be interrupted in the meantime.',
        '',
        `₹${PRICE_RUPEES} for the month.`,
        pay, '', safe,
      ].join('\n'),
    };
  }
  const when = kind === 'warn_1' ? 'tomorrow' : 'in 2 days';
  return {
    subject: `MathsLive — your access ends ${when}`,
    body: [
      `Your MathsLive ${a.state === 'trial' ? 'free trial' : 'subscription'} ends ${when}, on ${niceDate(a.until)}.`,
      '',
      `To keep teaching, it is ₹${PRICE_RUPEES} a month. Scan the QR on the page below,`,
      'enter the reference number your UPI app gives you, and you are done.',
      '',
      pay,
      '',
      `If you miss the date there are ${GRACE_DAYS} days of grace, so a class already in`,
      'your diary will not be cancelled.',
      '', safe,
    ].join('\n'),
  };
}

async function sendExpiryWarnings(pool: Pool, day: string): Promise<number> {
  // Admins are never billed, so they are never warned.
  const r = await pool.query<WarnRow>(
    `SELECT u.id, u.email, u.trial_started_at, u.paid_until
       FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = u.email)`,
  );
  let sent = 0;
  for (const row of r.rows) {
    const a = accessFrom(row);
    const kind = warningFor(a.state, a.daysLeft);
    if (!kind) continue;
    if (!await claim(pool, kind, row.id, day)) continue;
    const { subject, body } = warningMail(kind, a);
    const res = await sendMail([row.email], subject, body);
    if (res.ok) { sent++; console.log(`📧 ${kind} → ${row.email}`); }
    else {
      // Give the day back so the next run can try again, rather than
      // recording a warning that never arrived.
      await pool.query('DELETE FROM mail_log WHERE kind=$1 AND target=$2 AND day=$3',
        [kind, row.id, day]).catch(() => {});
      console.error(`Could not warn ${row.email}: ${res.reason}`);
    }
  }
  return sent;
}

// ── Owner-facing: the cockpit, delivered ───────────────────────────────────

async function sendOwnerDigest(pool: Pool, day: string): Promise<boolean> {
  const to = ownerAddresses();
  if (to.length === 0) return false;
  if (!await claim(pool, 'digest', 'owner', day)) return false;

  const NOT_ADMIN = `NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = u.email)`;
  const q = await pool.query(
    `SELECT
       (SELECT count(*) FROM users u WHERE ${NOT_ADMIN} AND u.paid_until > now())::int   AS paying,
       (SELECT COALESCE(sum(
          COALESCE((SELECT pc.amount_rupees::numeric / NULLIF(pc.months, 0)
                      FROM payment_claims pc
                     WHERE pc.teacher_id = u.id AND pc.confirmed_at IS NOT NULL
                     ORDER BY pc.confirmed_at DESC LIMIT 1), $2::numeric)
        ), 0)::int FROM users u
         WHERE ${NOT_ADMIN} AND u.paid_until > now())::int                               AS mrr,
       (SELECT count(*) FROM users u WHERE ${NOT_ADMIN}
          AND (u.paid_until IS NULL OR u.paid_until <= now())
          AND u.trial_started_at + ($1::int * INTERVAL '1 day') > now())::int            AS trialing,
       (SELECT count(*) FROM payment_claims
         WHERE confirmed_at IS NULL AND rejected_at IS NULL)::int                        AS claims_pending,
       (SELECT COALESCE(sum(amount_rupees),0) FROM payment_claims
         WHERE confirmed_at >= date_trunc('month', now()))::int                          AS collected_month,
       (SELECT count(*) FROM teaching_sessions
         WHERE started_at >= current_date - 1 AND started_at < current_date)::int        AS lessons_yesterday,
       (SELECT count(*) FROM users u WHERE ${NOT_ADMIN}
          AND u.created_at > now() - INTERVAL '1 day')::int                              AS new_signups`,
    [TRIAL_DAYS, PRICE_RUPEES],
  );
  const d = q.rows[0];

  // Who needs a human this week.
  const soon = await pool.query(
    `SELECT u.email,
            COALESCE(CASE WHEN u.paid_until > now() THEN u.paid_until END,
                     u.trial_started_at + ($1::int * INTERVAL '1 day')) AS ends_at
       FROM users u
      WHERE ${NOT_ADMIN}
        AND COALESCE(CASE WHEN u.paid_until > now() THEN u.paid_until END,
                     u.trial_started_at + ($1::int * INTERVAL '1 day'))
            BETWEEN now() AND now() + INTERVAL '7 days'
      ORDER BY ends_at`,
    [TRIAL_DAYS],
  );

  // Paying, but gone quiet — the shape churn takes before it is announced.
  const quiet = await pool.query(
    `SELECT u.email FROM users u
      WHERE ${NOT_ADMIN} AND u.paid_until > now()
        AND NOT EXISTS (SELECT 1 FROM teaching_sessions s
                         WHERE s.teacher_id = u.id AND s.started_at > now() - INTERVAL '14 days')`,
  );

  const lines = [
    `Paying ${d.paying}  ·  on trial ${d.trialing}  ·  ₹${d.mrr}/month`,
    `Collected this month: ₹${d.collected_month}`,
    '',
    `Lessons yesterday: ${d.lessons_yesterday}`,
    `New sign-ups: ${d.new_signups}`,
    '',
    d.claims_pending > 0
      ? `⚠ ${d.claims_pending} payment${d.claims_pending === 1 ? '' : 's'} waiting for you to confirm.`
      : 'No payments waiting.',
  ];
  if ((soon.rowCount ?? 0) > 0) {
    lines.push('', 'Running out within 7 days:');
    for (const r of soon.rows) lines.push(`  · ${r.email} — ${niceDate(r.ends_at)}`);
  }
  if ((quiet.rowCount ?? 0) > 0) {
    lines.push('', 'Paying but no lesson in 14 days (worth a call):');
    for (const r of quiet.rows) lines.push(`  · ${r.email}`);
  }
  lines.push('', `${siteUrl()}/admin`);

  const res = await sendMail(to, `MathsLive — ${d.paying} paying, ${d.claims_pending} to confirm`, lines.join('\n'));
  if (!res.ok) {
    await pool.query('DELETE FROM mail_log WHERE kind=$1 AND target=$2 AND day=$3',
      ['digest', 'owner', day]).catch(() => {});
    return false;
  }
  console.log('📧 owner digest sent');
  return true;
}

/**
 * Start the daily run.
 *
 * Checked every 15 minutes rather than scheduled precisely, because the
 * process restarts often enough that a once-a-day timer would simply be
 * missed. mail_log makes the frequent checking harmless.
 */
export function startDailyJobs(pool: Pool): void {
  const tick = async () => {
    try {
      if (istHour() < SEND_HOUR_IST) return;
      const day = istDay();
      await sendExpiryWarnings(pool, day);
      await sendOwnerDigest(pool, day);
    } catch (err) {
      // A failed run must never take the server with it; the next tick retries.
      console.error('Daily mail run failed:', (err as Error).message);
    }
  };
  setInterval(() => { void tick(); }, 15 * 60_000).unref?.();
  // One run shortly after boot, so a deploy at 9am still sends that day's mail.
  setTimeout(() => { void tick(); }, 60_000).unref?.();
  console.log(`📮 Daily mail: expiry warnings + owner digest, from ${SEND_HOUR_IST}:00 IST`);
}

/** Exposed for tests: which warning, if any, a given state deserves. */
export const _warningFor = warningFor;
