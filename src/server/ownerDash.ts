// The owner's cockpit — running the business from one screen.
//
// /admin already answered "who uses this?". It could not answer the question
// that decides whether there is a business: "who is paying, who is about to
// stop, and who do I need to call today?" All of that has been in the database
// since billing shipped; nothing read it.
//
// Three reads, deliberately separate because they answer different questions
// and fail independently — a broken live panel must not blank out the revenue
// figures:
//
//   overview   the numbers that describe the business right now
//   renewals   the collections calendar: who lapses, and when
//   live       who is teaching at this moment (memory, not the database)
//
// Everything here is READ-ONLY. The only endpoints that change money are in
// billing.ts, so there is exactly one place to audit when asking "how could a
// teacher have been given time?".
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { userFromRequest, type SessionUser } from './identity';
import { TRIAL_DAYS, PRICE_RUPEES, GRACE_DAYS } from './billing';

/** One room, as the admin screen sees it. Built from the live rooms map. */
export interface LiveRoom {
  roomId: string;
  teacher: string | null;
  students: string[];
  /** Stable per-browser ids. A name is typed; this identifies the machine. */
  teacherDevice: string | null;
  studentDevices: string[];
  /** Students present with nobody in the teacher seat. */
  waiting: boolean;
  startedAt: number;
  lastActivityAt: number;
  paused: boolean;
}

export interface OwnerDashOptions {
  secret: string;
  /** Snapshot of the in-memory rooms. Lives in server.ts, so it is passed in. */
  liveRooms: () => LiveRoom[];
}

/** What a teacher is told is happening in their own rooms. */
export interface WaitingRoom {
  roomCode: string;
  studentName: string;
  waitingNames: string[];
  waitingSince: number;
}

export function mountOwnerDashRoutes(app: any, pool: Pool, opts: OwnerDashOptions) {
  const { secret, liveRooms } = opts;

  function requireUser(req: Request, res: Response): SessionUser | null {
    const user = userFromRequest(req, secret);
    if (!user) { res.status(401).json({ error: 'Not signed in' }); return null; }
    return user;
  }

  async function isAdmin(user: SessionUser): Promise<boolean> {
    const r = await pool.query('SELECT 1 FROM platform_admins WHERE email = $1', [user.email]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Every route here is admin-only, checked against the database every time. */
  async function gate(req: Request, res: Response): Promise<SessionUser | null> {
    const user = requireUser(req, res);
    if (!user) return null;
    if (!await isAdmin(user)) { res.status(403).json({ error: 'Not an admin.' }); return null; }
    return user;
  }

  const fail = (res: Response, err: unknown, what: string) => {
    console.error(`${what} failed:`, (err as Error).message);
    res.status(500).json({ error: `Could not ${what}.` });
  };

  // A teacher counts as "paying" only on paid_until. Admins are excluded from
  // every commercial number here — counting the owner as a customer would
  // inflate the one figure the whole plan is steered by.
  const NOT_ADMIN = `NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = u.email)`;

  // ── The numbers ──────────────────────────────────────────────────────────
  app.get('/api/admin/overview', async (req: Request, res: Response) => {
    if (!await gate(req, res)) return;
    try {
      const r = await pool.query(
        `SELECT
           (SELECT count(*) FROM users u
             WHERE ${NOT_ADMIN} AND u.paid_until > now())::int                          AS paying,
           (SELECT count(*) FROM users u
             WHERE ${NOT_ADMIN} AND (u.paid_until IS NULL OR u.paid_until <= now())
               AND u.trial_started_at + ($1::int * INTERVAL '1 day') > now())::int      AS trialing,
           (SELECT count(*) FROM users u
             WHERE ${NOT_ADMIN} AND (u.paid_until IS NULL OR u.paid_until <= now())
               AND (u.trial_started_at IS NULL
                    OR u.trial_started_at + (($1::int + $2::int) * INTERVAL '1 day') <= now()))::int AS expired,
           -- Past the end but still teaching on grace. Counting these as
           -- "lapsed" would overstate the damage and hide the ones who can
           -- still be saved with a phone call today.
           (SELECT count(*) FROM users u
             WHERE ${NOT_ADMIN} AND (u.paid_until IS NULL OR u.paid_until <= now())
               AND u.trial_started_at + ($1::int * INTERVAL '1 day') <= now()
               AND u.trial_started_at + (($1::int + $2::int) * INTERVAL '1 day') > now())::int AS in_grace,
           (SELECT count(*) FROM users u
             WHERE ${NOT_ADMIN} AND u.paid_until > now()
               AND u.paid_until < now() + INTERVAL '7 days')::int                       AS expiring_7d,
           (SELECT count(*) FROM users u
             WHERE ${NOT_ADMIN} AND (u.paid_until IS NULL OR u.paid_until <= now())
               AND u.trial_started_at + ($1::int * INTERVAL '1 day') > now()
               AND u.trial_started_at + ($1::int * INTERVAL '1 day')
                   < now() + INTERVAL '3 days')::int                                    AS trials_ending_3d,
           (SELECT count(*) FROM payment_claims
             WHERE confirmed_at IS NULL AND rejected_at IS NULL)::int                   AS claims_pending,
           (SELECT COALESCE(sum(amount_rupees), 0) FROM payment_claims
             WHERE confirmed_at IS NOT NULL)::int                                       AS collected_total,
           (SELECT COALESCE(sum(amount_rupees), 0) FROM payment_claims
             WHERE confirmed_at >= date_trunc('month', now()))::int                     AS collected_month,
           (SELECT count(*) FROM classes)::int                                          AS students,
           (SELECT count(*) FROM teaching_sessions
             WHERE started_at >= current_date)::int                                     AS lessons_today,
           (SELECT count(*) FROM teaching_sessions
             WHERE started_at > now() - INTERVAL '7 days')::int                         AS lessons_7d,
           (SELECT count(DISTINCT teacher_id) FROM teaching_sessions
             WHERE started_at > now() - INTERVAL '7 days')::int                         AS teachers_active_7d,
           -- Real monthly run-rate. A teacher on the yearly plan bills ₹400 a
           -- month, not ₹500, so counting everyone at list price would
           -- overstate the single number this whole plan is steered by. Taken
           -- from each teacher's most recent confirmed payment; teachers given
           -- access by hand, with no payment, count at list.
           (SELECT COALESCE(sum(
              COALESCE(
                (SELECT pc.amount_rupees::numeric / NULLIF(pc.months, 0)
                   FROM payment_claims pc
                  WHERE pc.teacher_id = u.id AND pc.confirmed_at IS NOT NULL
                  ORDER BY pc.confirmed_at DESC LIMIT 1),
                $3::numeric)
            ), 0)::int
              FROM users u
             WHERE ${NOT_ADMIN} AND u.paid_until > now())::int                          AS mrr`,
        [TRIAL_DAYS, GRACE_DAYS, PRICE_RUPEES],
      );
      const o = r.rows[0];
      res.json({
        ...o,
        priceRupees: PRICE_RUPEES,
        trialDays: TRIAL_DAYS,
        graceDays: GRACE_DAYS,
        liveRooms: liveRooms().length,
      });
    } catch (err) { fail(res, err, 'read the business overview'); }
  });

  // ── The collections calendar ─────────────────────────────────────────────
  //
  // One row per teacher with a date attached: when their trial runs out, or
  // when their subscription does. Sorted by that date, which is the order the
  // owner should actually work through them in.
  app.get('/api/admin/renewals', async (req: Request, res: Response) => {
    if (!await gate(req, res)) return;
    try {
      const r = await pool.query(
        `SELECT u.id, u.email,
                u.paid_until, u.trial_started_at,
                CASE WHEN u.paid_until > now() THEN 'paid' ELSE 'trial' END AS kind,
                COALESCE(
                  CASE WHEN u.paid_until > now() THEN u.paid_until END,
                  u.trial_started_at + ($1::int * INTERVAL '1 day')
                ) AS ends_at,
                (SELECT count(*) FROM classes c WHERE c.teacher_id = u.id)::int AS students,
                (SELECT max(s.started_at) FROM teaching_sessions s
                  WHERE s.teacher_id = u.id) AS last_lesson,
                (SELECT count(*) FROM payment_claims pc
                  WHERE pc.teacher_id = u.id AND pc.confirmed_at IS NOT NULL)::int AS payments,
                EXISTS (SELECT 1 FROM payment_claims pc
                  WHERE pc.teacher_id = u.id AND pc.confirmed_at IS NULL
                    AND pc.rejected_at IS NULL) AS claim_pending
           FROM users u
          WHERE ${NOT_ADMIN}
          ORDER BY ends_at ASC NULLS LAST`,
        [TRIAL_DAYS],
      );
      res.json({ renewals: r.rows, trialDays: TRIAL_DAYS, graceDays: GRACE_DAYS });
    } catch (err) { fail(res, err, 'read the renewals calendar'); }
  });

  // ── Is anyone waiting for ME? ────────────────────────────────────────────
  //
  // A student who taps their link early sits in an empty room, and the tutor
  // has no way to know unless they happen to open it. That is a lesson that
  // starts late or not at all, and it is invisible to everyone who could fix
  // it. This is the one teacher-facing read on this file, and it is
  // deliberately scoped to the caller's own classes — a teacher can never see
  // who is waiting in someone else's room.
  app.get('/api/waiting', async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const live = liveRooms().filter(r => r.waiting);
      if (live.length === 0) return res.json({ waiting: [] });

      // Only rooms that are this teacher's registered classes. An ad-hoc room
      // belongs to nobody, so nobody is told about it.
      const mine = await pool.query(
        `SELECT room_code, student_name FROM classes
          WHERE teacher_id = $1 AND room_code = ANY($2::text[])`,
        [user.id, live.map(r => r.roomId)],
      );
      const byCode = new Map<string, string>(
        mine.rows.map((r: any) => [r.room_code, r.student_name]),
      );

      const waiting: WaitingRoom[] = live
        .filter(r => byCode.has(r.roomId))
        .map(r => ({
          roomCode: r.roomId,
          studentName: byCode.get(r.roomId)!,
          waitingNames: r.students,
          waitingSince: r.lastActivityAt,
        }));
      res.json({ waiting });
    } catch (err) { fail(res, err, 'check who is waiting'); }
  });

  // ── Who is teaching right now ────────────────────────────────────────────
  //
  // Read straight from memory, so it costs nothing and is exactly as true as
  // the server's own state. No database involved: if Postgres were down this
  // is the one panel that would still answer.
  app.get('/api/admin/live', async (req: Request, res: Response) => {
    if (!await gate(req, res)) return;
    try {
      res.json({ rooms: liveRooms(), at: Date.now() });
    } catch (err) { fail(res, err, 'read the live rooms'); }
  });
}
