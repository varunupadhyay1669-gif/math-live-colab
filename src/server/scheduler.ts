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
// A lock is only as good as what it is keyed by. Until 14 Sep 2026 a warning
// was claimed for the day it went out, but a warning stays true for longer
// than a day, so every teacher whose access ended got each warning on two days
// running and "your access ended" on every day of grace. A warning is claimed
// for the end it is about now; the whole story is at warningClaim().
//
// THE RIGHT DAY. The server's clock is UTC and every teacher is in India. Ask
// "has today's mail gone?" in UTC and the answer flips at 5:30am IST, so a
// teacher can get yesterday's warning again over breakfast. Every date here is
// an IST date.
import type { Pool } from 'pg';
import {
  standingOf, businessFigures, BILLABLE_TEACHERS_SQL, PRICE_RUPEES, GRACE_DAYS,
  type Access, type BillableTeacher, type Standing,
} from './billing';
import { sendMail, ownerAddresses, siteUrl, istDay, istHour, niceDate } from './mailer';
import { sweepExpiredLessons, LESSON_TTL_HOURS } from './records';

export const MAIL_LOG_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mail_log (
    kind    text NOT NULL,          -- 'warn_2' | 'warn_1' | 'grace' | 'digest'
    target  text NOT NULL,          -- teacher id, or 'owner'
    day     date NOT NULL,          -- IST date: when a digest went out, or when the access a warning is about ends
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, target, day)
  );
`;

/** The hour in India at which the daily run happens. */
const SEND_HOUR_IST = 8;

const DAY_MS = 86_400_000;

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

/**
 * Give a claimed day back, so the next run tries again rather than the log
 * recording mail that never arrived.
 */
async function unclaim(pool: Pool, kind: string, target: string, day: string): Promise<void> {
  await pool.query('DELETE FROM mail_log WHERE kind=$1 AND target=$2 AND day=$3',
    [kind, target, day]).catch(() => {});
}

/** Sends one email the way sendMail() does. Passed in, so a test can be the inbox. */
type Send = typeof sendMail;

// ── Teacher-facing: nobody should be surprised by the paywall ──────────────

type WarningKind = 'warn_2' | 'warn_1' | 'grace';

const WARNING_KINDS: WarningKind[] = ['warn_2', 'warn_1', 'grace'];

function warningFor(state: string, daysLeft: number): WarningKind | null {
  if (state === 'grace') return 'grace';
  if (state === 'trial' || state === 'active') {
    if (daysLeft === 2) return 'warn_2';
    if (daysLeft === 1) return 'warn_1';
  }
  return null;
}

interface DueWarning { row: BillableTeacher; kind: WarningKind; access: Access; standing: Standing }

/**
 * Who is owed which warning.
 *
 * Decided from rows that carry their grants. From the dates alone a teacher on
 * free access is indistinguishable from a trial that ran out, and between 5
 * and 10 Sep 2026 that is how Vani's free-forever account was treated: two
 * "ends in 2 days", two "ends tomorrow", then four "your access ended".
 */
function warningsDue(rows: BillableTeacher[], now = new Date()): DueWarning[] {
  const due: DueWarning[] = [];
  for (const row of rows) {
    const { standing, access } = standingOf(row, now);
    const kind = warningFor(access.state, access.daysLeft);
    if (kind) due.push({ row, kind, access, standing });
  }
  return due;
}

/**
 * When each warning falls due, counted from the end it is about.
 *
 * Read off accessFrom(), whose daysLeft is a Math.ceil: "2" holds from two days
 * before the end until one day before, "1" from then until the end, and grace
 * from the end until grace runs out. Those are exactly the stretches in which
 * warningFor() names each kind.
 */
const DUE_FROM_END_MS: Record<WarningKind, number> = {
  warn_2: -2 * DAY_MS,
  warn_1: -DAY_MS,
  grace: 0,
};

/**
 * How far this process's clock and the database's may disagree.
 *
 * sent_at is stamped by Postgres and the decision is made here. They share a
 * box today; this is so it does not matter if one day they do not, and a row
 * stamped a moment before its warning fell due still counts as sent.
 */
const CLOCK_SLACK_MS = 5 * 60_000;

/** A warning already in mail_log, as sendExpiryWarnings() reads it back. */
export interface SentWarning {
  kind: string;
  /**
   * YYYY-MM-DD, selected with to_char. Left as a pg date it arrives as a Date
   * at local midnight, which toISOString() turns into the day before anywhere
   * east of UTC, India included.
   */
  day: string;
  sent_at: Date | string;
}

/** Whether a warning goes out, and the mail_log day it is claimed under. */
export type WarningClaim =
  | { send: true; day: string; reason: string }
  | { send: false; day: string | null; reason: string };

/**
 * Whether one teacher is sent one warning now, and the day to claim it under.
 *
 * 14 Sep 2026. The claim was (kind, teacher, the day it went out), and a
 * warning stays true for longer than a day. daysLeft is a Math.ceil, so access
 * ending at 16:18 IST reads "2 days left" from 16:18 two days before until 16:18
 * the day after: the afternoon run sent warn_2, and the next morning's run found
 * a new date with no row and sent it again. warn_1 did the same, and grace,
 * which is true for three days, went out on each of them. Rachel's mail_log:
 * warn_2 on 7 and 8 Sep, warn_1 on 8 and 9 Sep, grace on 9, 10, 11 and 12 Sep.
 *
 * So a warning is claimed under the END: (kind, teacher, the IST date the
 * access ends). However long it stays true, and however many runs and restarts
 * that spans, one end has one row of each kind. A payment or a grant moves the
 * end to another date, which has no rows yet, so the new end earns its own
 * warnings. The date rather than the instant because the email names the date:
 * two ends on the same day would be the same email twice.
 *
 * Rows written before that change carry the day they went out, which an
 * end-keyed claim never collides with — a warn_2 sent this morning would go out
 * again straight after the deploy. So a row also counts if it is the same kind
 * and was sent at any point since that kind fell due for this end. Short of the
 * end moving by a few hours, anything of that kind sent in that stretch was
 * about this end, however its row was keyed.
 *
 * Pure, with the rows handed in, so it is tested without a database. Two runs
 * racing each other are still settled by the INSERT in claim().
 */
function warningClaim(kind: WarningKind, access: Access, sent: SentWarning[]): WarningClaim {
  const ends = access.until ? new Date(access.until).getTime() : NaN;
  // Free forever has no end: nothing to warn about, and nothing to claim it by.
  if (!Number.isFinite(ends)) return { send: false, day: null, reason: 'the access has no end' };

  const day = istDay(new Date(ends));
  const dueFrom = ends + DUE_FROM_END_MS[kind];
  for (const s of sent) {
    if (s.kind !== kind) continue;
    if (s.day === day) {
      return { send: false, day, reason: `${kind} is already claimed for the end on ${day}` };
    }
    const at = new Date(s.sent_at).getTime();
    if (at >= dueFrom - CLOCK_SLACK_MS) {
      return { send: false, day,
        reason: `${kind} already went out on ${istDay(new Date(at))}, after it fell due for the end on ${day}` };
    }
  }
  return { send: true, day, reason: `no ${kind} yet for the end on ${day}` };
}

function warningMail(kind: WarningKind, a: Access, standing: Standing): { subject: string; body: string } {
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
  // A dated grant ends like anything else, but it was never a trial or a
  // subscription, and the email should not call it one.
  const what = standing === 'free' ? 'free access' : a.state === 'trial' ? 'free trial' : 'subscription';
  return {
    subject: `MathsLive — your access ends ${when}`,
    body: [
      `Your MathsLive ${what} ends ${when}, on ${niceDate(a.until)}.`,
      '',
      `To keep teaching, it is ₹${PRICE_RUPEES} a month. Scan the QR on the page below,`,
      'enter the reference number your UPI app gives you, and you are done.',
      '',
      pay,
      '',
      // Grace follows paid and trial time, not a grant: when a grant ends, the
      // seat goes by the dates underneath it. Promising days that will not
      // come is worse than not mentioning them.
      ...(standing === 'free' ? [] : [
        `If you miss the date there are ${GRACE_DAYS} days of grace, so a class already in`,
        'your diary will not be cancelled.',
        '',
      ]),
      safe,
    ].join('\n'),
  };
}

async function sendExpiryWarnings(pool: Pool, now: Date, send: Send): Promise<number> {
  const r = await pool.query<BillableTeacher>(BILLABLE_TEACHERS_SQL);
  const due = warningsDue(r.rows, now);
  if (due.length === 0) return 0;

  // What these teachers have already been sent, however it was keyed. Grace is
  // the longest any warning stays due, so nothing older than that, plus a
  // margin, can bear on warningClaim().
  const log = await pool.query<SentWarning & { target: string }>(
    `SELECT kind, target, to_char(day, 'YYYY-MM-DD') AS day, sent_at
       FROM mail_log
      WHERE kind = ANY($1::text[]) AND target = ANY($2::text[]) AND sent_at >= $3`,
    [WARNING_KINDS, due.map(d => d.row.id), new Date(now.getTime() - (GRACE_DAYS + 2) * DAY_MS)],
  );

  let sent = 0;
  for (const { row, kind, access, standing } of due) {
    const c = warningClaim(kind, access, log.rows.filter(s => s.target === row.id));
    if (!c.send || !await claim(pool, kind, row.id, c.day)) continue;
    const { subject, body } = warningMail(kind, access, standing);
    const res = await send([row.email], subject, body);
    if (res.ok) { sent++; console.log(`📧 ${kind} → ${row.email}`); }
    else {
      // Handed back under the same key, so the next run sends it after all.
      await unclaim(pool, kind, row.id, c.day);
      console.error(`Could not warn ${row.email}: ${res.reason}`);
    }
  }
  return sent;
}

// ── Owner-facing: the cockpit, delivered ───────────────────────────────────

interface DigestCounts {
  claims_pending: number;
  collected_month: number;
  lessons_yesterday: number;
  new_signups: number;
}

/**
 * What the owner reads. Pure, so a test can hand it teachers and check the
 * text, and counted through businessFigures() so it can never disagree with
 * /admin.
 */
function digestLines(teachers: BillableTeacher[], c: DigestCounts, now = new Date()): { subject: string; lines: string[] } {
  const f = businessFigures(teachers, now);
  const t = now.getTime();
  const standings = teachers.map(row => ({ row, ...standingOf(row, now) }));

  // Who needs a human this week: paid time, a trial or a dated grant ending.
  // A forever grant has no end date, so it can never appear here.
  const soon = standings
    .filter(s => s.standing === 'paying' || s.standing === 'trial' || s.standing === 'free')
    .map(s => ({ ...s, ends: s.access.until ? new Date(s.access.until).getTime() : NaN }))
    .filter(s => s.ends >= t && s.ends <= t + 7 * DAY_MS)
    .sort((a, b) => a.ends - b.ends);

  // Paying, but gone quiet — the shape churn takes before it is announced.
  const quiet = standings.filter(s => s.standing === 'paying'
    && (!s.row.last_lesson || new Date(s.row.last_lesson).getTime() <= t - 14 * DAY_MS));

  const lines = [
    `Paying ${f.paying}  ·  on trial ${f.trialing}  ·  free access ${f.free}  ·  ₹${f.mrr}/month`,
    `Collected this month: ₹${c.collected_month}`,
    '',
    `Lessons yesterday: ${c.lessons_yesterday}`,
    `New sign-ups: ${c.new_signups}`,
    '',
    c.claims_pending > 0
      ? `⚠ ${c.claims_pending} payment${c.claims_pending === 1 ? '' : 's'} waiting for you to confirm.`
      : 'No payments waiting.',
  ];
  if (soon.length > 0) {
    lines.push('', 'Running out within 7 days:');
    for (const s of soon) {
      lines.push(`  · ${s.row.email} — ${niceDate(s.access.until)}${s.standing === 'free' ? ' (free access)' : ''}`);
    }
  }
  if (quiet.length > 0) {
    lines.push('', 'Paying but no lesson in 14 days (worth a call):');
    for (const s of quiet) lines.push(`  · ${s.row.email}`);
  }
  lines.push('', `${siteUrl()}/admin`);

  return { subject: `MathsLive — ${f.paying} paying, ${c.claims_pending} to confirm`, lines };
}

async function sendOwnerDigest(pool: Pool, now: Date, send: Send): Promise<boolean> {
  const to = ownerAddresses();
  if (to.length === 0) return false;
  // Claimed under the day it goes out, unlike a warning: the digest is about
  // the day, so once a day is exactly what that key gives.
  const day = istDay(now);
  if (!await claim(pool, 'digest', 'owner', day)) return false;

  try {
    const teachers = await pool.query<BillableTeacher>(BILLABLE_TEACHERS_SQL);
    const q = await pool.query<DigestCounts>(
      `SELECT
         (SELECT count(*) FROM payment_claims
           WHERE confirmed_at IS NULL AND rejected_at IS NULL)::int                        AS claims_pending,
         (SELECT COALESCE(sum(amount_rupees),0) FROM payment_claims
           WHERE confirmed_at >= date_trunc('month', now()))::int                          AS collected_month,
         (SELECT count(*) FROM teaching_sessions
           WHERE started_at >= current_date - 1 AND started_at < current_date)::int        AS lessons_yesterday,
         (SELECT count(*) FROM users u
           WHERE NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = u.email)
             AND u.created_at > now() - INTERVAL '1 day')::int                              AS new_signups`,
    );
    const { subject, lines } = digestLines(teachers.rows, q.rows[0], now);
    const res = await send(to, subject, lines.join('\n'));
    if (!res.ok) {
      await unclaim(pool, 'digest', 'owner', day);
      return false;
    }
  } catch (err) {
    // The day is claimed before anything is read. A query that throws has to
    // hand it back, or one bad query silently costs the owner that day's digest.
    await unclaim(pool, 'digest', 'owner', day);
    throw err;
  }
  console.log('📧 owner digest sent');
  return true;
}

/**
 * Everything one run sends, once it is past the hour gate.
 *
 * The clock and the sender are parameters so a test can put a week of runs
 * through this, against a pretend mail_log, rather than through a copy of it.
 */
async function sendDailyMail(pool: Pool, now = new Date(), send: Send = sendMail): Promise<void> {
  await sendExpiryWarnings(pool, now, send);
  await sendOwnerDigest(pool, now, send);
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
    // Data expiry runs on EVERY tick, deliberately before the hour gate below.
    // The mail is a once-a-day thing and returns early for most of the day;
    // deleting yesterday's lessons is not, and hanging it off the mail schedule
    // would have meant it ran once a day at 9am or, on a day the process
    // restarted after that, never.
    try {
      await sweepExpiredLessons(pool);
    } catch (err) {
      console.error('Lesson sweep failed:', (err as Error).message);
    }
    try {
      if (istHour() < SEND_HOUR_IST) return;
      await sendDailyMail(pool);
    } catch (err) {
      // A failed run must never take the server with it; the next tick retries.
      console.error('Daily mail run failed:', (err as Error).message);
    }
  };
  setInterval(() => { void tick(); }, 15 * 60_000).unref?.();
  // One run shortly after boot, so a deploy at 9am still sends that day's mail.
  setTimeout(() => { void tick(); }, 60_000).unref?.();
  console.log(`📮 Daily mail: expiry warnings + owner digest, from ${SEND_HOUR_IST}:00 IST`);
  console.log(`🧹 Lesson sweep: older than ${LESSON_TTL_HOURS}h removed every 15 min, each class keeping its most recent`);
}

/** Exposed for tests: which warning, if any, a given state deserves. */
export const _warningFor = warningFor;
/** Exposed for tests: who is emailed, what they are told, and what the owner reads. */
export const _warningsDue = warningsDue;
export const _warningMail = warningMail;
export const _digestLines = digestLines;
/** Exposed for tests: whether a warning has already gone for its end, and one run of the mail against a pretend database. */
export const _warningClaim = warningClaim;
export const _sendDailyMail = sendDailyMail;
