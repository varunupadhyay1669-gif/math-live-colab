// Classes, taught sessions, and the admin read — as server endpoints.
//
// Supabase let the BROWSER talk to the database directly, and row-level
// security is what made that safe. Moving off it means that guarantee has to
// live somewhere, and it lives here: every statement below is scoped by a
// teacher_id taken from the verified session cookie and NEVER from the request
// body. A caller can ask for another teacher's class; they will get nothing.
//
// That is the whole security model, stated once so it cannot drift: the client
// is not trusted to say who it is.
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import { userFromRequest, type SessionUser } from './identity';
import { accessForTeacher, accessFrom } from './billing';

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

/** Room codes must survive isValidRoomId on the socket side: <=20 chars. */
function slug(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 15);
}

/**
 * How many lessons of history a class keeps.
 *
 * The founder's rule, in his words: "as soon as the next class happens and it's
 * saved, the previous class data gets deleted… only if I'm joining that class
 * now, I should have the data of the last class."
 *
 * Two is the smallest number that keeps that promise. During today's lesson the
 * class holds today's row and the last one, so opening the room always shows
 * where you stopped; when tomorrow's lesson is saved, the one before last goes.
 * One would delete the previous lesson the moment today's began — which is
 * exactly the thing the teacher opens the room to look at.
 *
 * Configurable because it is a policy, not a fact, and because the honest cost
 * is real: a class's history stops at two lessons. That is a deliberate trade
 * of "what did we do in March" for a database that cannot grow without bound
 * on a 1 GB box. Raise it to 6 and a term of Saturdays survives; set it to 0
 * to keep everything, which is what the product did until today.
 */
export const LESSON_HISTORY_KEEP = Math.max(0, Number(process.env.LESSON_HISTORY_KEEP ?? 2));

/**
 * Delete a class's older lessons, keeping the newest LESSON_HISTORY_KEEP.
 *
 * Called after a NEW lesson row is created, which is once per class per day —
 * so pruning happens exactly when a new class begins, and never in the middle
 * of one. Scoped by teacher_id as well as class_id, like every other statement
 * in this file: the caller is never trusted to say whose data this is.
 *
 * Returns how many were removed. Never throws: losing the prune is a slightly
 * larger table, while failing the request would lose the lesson that was just
 * taught, and those are not the same size of mistake.
 */
export async function pruneLessonHistory(pool: Pool, classId: string, teacherId: string): Promise<number> {
  if (LESSON_HISTORY_KEEP === 0) return 0;
  try {
    const r = await pool.query(
      `DELETE FROM teaching_sessions
        WHERE class_id = $1 AND teacher_id = $2
          AND id NOT IN (
            SELECT id FROM teaching_sessions
             WHERE class_id = $1 AND teacher_id = $2
             -- id breaks a tie, so two rows sharing a timestamp can never both
             -- be "the newest" and leave the wrong one behind.
             ORDER BY started_at DESC, id DESC
             LIMIT $3
          )`,
      [classId, teacherId, LESSON_HISTORY_KEEP],
    );
    const n = r.rowCount ?? 0;
    if (n > 0) console.log(`🧹 class ${classId}: ${n} older lesson(s) removed, newest ${LESSON_HISTORY_KEEP} kept`);
    return n;
  } catch (err) {
    console.error(`Could not prune lesson history for ${classId}:`, (err as Error).message);
    return 0;
  }
}

export function mountRecordRoutes(app: any, pool: Pool, opts: { secret: string }) {
  const { secret } = opts;

  /** Every route below is behind this. No session, no data. */
  function requireUser(req: Request, res: Response): SessionUser | null {
    const user = userFromRequest(req, secret);
    if (!user) { res.status(401).json({ error: 'Not signed in' }); return null; }
    return user;
  }

  const fail = (res: Response, err: unknown, what: string) => {
    console.error(`${what} failed:`, (err as Error).message);
    res.status(500).json({ error: `Could not ${what}.` });
  };

  // ── Classes ────────────────────────────────────────────────────────────
  app.get('/api/classes', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      const r = await pool.query(
        `SELECT * FROM classes WHERE teacher_id = $1
          ORDER BY last_opened_at DESC NULLS LAST, created_at DESC`,
        [user.id],
      );
      res.json({ classes: r.rows });
    } catch (err) { fail(res, err, 'list your classes'); }
  });

  app.post('/api/classes', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const body = (req.body || {}) as { studentName?: string; label?: string };
    const studentName = String(body.studentName || '').trim().slice(0, 80);
    if (!studentName) return res.status(400).json({ error: 'A student name is required.' });
    try {
      // Adding students is a paid action; reading the ones you already have is
      // not. An expired teacher can still see their roster and pay — locking
      // them out of their own list would just make it harder to become a
      // customer again.
      const access = await accessForTeacher(pool, user.id);
      if (access.state === 'expired') {
        return res.status(402).json({
          error: 'Your free trial has ended. Subscribe to add more students.',
          code: 'subscription_expired',
        });
      }
      // Prefer the student's own name as the room code — a child can type it
      // from memory. Only fall back to a suffix when it is genuinely taken.
      const base = slug(studentName) || 'class';
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = attempt === 0
          ? base
          : `${base}-${randomBytes(3).toString('hex').slice(0, 4)}`;
        try {
          const r = await pool.query(
            `INSERT INTO classes (id, teacher_id, student_name, label, room_code)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [id('cls'), user.id, studentName, String(body.label || '').trim() || null, code],
          );
          return res.json({ class: r.rows[0] });
        } catch (e) {
          // 23505 = unique_violation: this code is taken, try the next shape.
          if ((e as { code?: string })?.code !== '23505') throw e;
        }
      }
      res.status(409).json({ error: 'Could not find a free room code — try a different name.' });
    } catch (err) { fail(res, err, 'create the class'); }
  });

  const CLASS_FIELDS = ['student_name', 'label', 'grade', 'level', 'goals', 'avatar', 'textbook'] as const;

  app.patch('/api/classes/:id', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const patch = (req.body || {}) as Record<string, unknown>;
    const cols = CLASS_FIELDS.filter(f => f in patch);
    if (cols.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
      const r = await pool.query(
        `UPDATE classes SET ${sets} WHERE id = $1 AND teacher_id = $2 RETURNING *`,
        [req.params.id, user.id, ...cols.map(c => patch[c] ?? null)],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'Class not found.' });
      res.json({ class: r.rows[0] });
    } catch (err) { fail(res, err, 'update the class'); }
  });

  app.delete('/api/classes/:id', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      const r = await pool.query(
        'DELETE FROM classes WHERE id = $1 AND teacher_id = $2', [req.params.id, user.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'Class not found.' });
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'delete the class'); }
  });

  /** Used when a room opens, to order the dashboard by recency. */
  app.post('/api/classes/by-code/:code/opened', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      await pool.query(
        'UPDATE classes SET last_opened_at = now() WHERE room_code = $1 AND teacher_id = $2',
        [req.params.code, user.id],
      );
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'record the visit'); }
  });

  app.get('/api/classes/by-code/:code', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      const r = await pool.query(
        'SELECT * FROM classes WHERE room_code = $1 AND teacher_id = $2',
        [req.params.code, user.id],
      );
      res.json({ class: r.rows[0] ?? null });
    } catch (err) { fail(res, err, 'find the class'); }
  });

  // ── Taught sessions ────────────────────────────────────────────────────
  app.get('/api/sessions', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const classId = String(req.query.classId || '');
    if (!classId) return res.status(400).json({ error: 'classId is required.' });
    try {
      const r = await pool.query(
        `SELECT * FROM teaching_sessions
          WHERE class_id = $1 AND teacher_id = $2
          ORDER BY started_at DESC LIMIT 50`,
        [classId, user.id],
      );
      res.json({ sessions: r.rows });
    } catch (err) { fail(res, err, 'list the sessions'); }
  });

  app.post('/api/sessions', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const b = (req.body || {}) as any;
    if (!b.classId) return res.status(400).json({ error: 'classId is required.' });
    try {
      // The class must belong to the caller. Without this a teacher could
      // write a session into someone else's class by guessing an id.
      const owns = await pool.query(
        'SELECT 1 FROM classes WHERE id = $1 AND teacher_id = $2',
        [b.classId, user.id],
      );
      if (owns.rowCount === 0) return res.status(404).json({ error: 'Class not found.' });

      const r = await pool.query(
        `INSERT INTO teaching_sessions
           (id, class_id, teacher_id, started_at, ended_at, topic, whiteboard_snapshot, html_used)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), now(), $5, $6::jsonb, $7)
      RETURNING *`,
        [
          id('ses'), b.classId, user.id, b.startedAt || null,
          (b.topic || '').trim() || null,
          b.whiteboard == null ? null : JSON.stringify(b.whiteboard),
          b.html ?? null,
        ],
      );
      const pruned = await pruneLessonHistory(pool, b.classId, user.id);
      res.json({ session: r.rows[0], pruned });
    } catch (err) { fail(res, err, 'save the session'); }
  });

  app.get('/api/sessions/:id', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      const r = await pool.query(
        'SELECT * FROM teaching_sessions WHERE id = $1 AND teacher_id = $2',
        [req.params.id, user.id],
      );
      res.json({ session: r.rows[0] ?? null });
    } catch (err) { fail(res, err, 'open the session'); }
  });

  const SESSION_FIELDS = ['topic', 'notes', 'html_used', 'taught_seconds', 'ended_at'] as const;

  app.patch('/api/sessions/:id', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    const patch = (req.body || {}) as Record<string, unknown>;
    const cols = SESSION_FIELDS.filter(f => f in patch);
    if (cols.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
      const r = await pool.query(
        `UPDATE teaching_sessions SET ${sets} WHERE id = $1 AND teacher_id = $2 RETURNING *`,
        [req.params.id, user.id, ...cols.map(c => patch[c] ?? null)],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'Session not found.' });
      res.json({ session: r.rows[0] });
    } catch (err) { fail(res, err, 'update the session'); }
  });

  app.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      const r = await pool.query(
        'DELETE FROM teaching_sessions WHERE id = $1 AND teacher_id = $2', [req.params.id, user.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'Session not found.' });
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'delete the session'); }
  });

  // ── Admin ──────────────────────────────────────────────────────────────
  // Supabase enforced this with `security definer` functions in the database.
  // The equivalent here is a membership check on every request; the browser
  // hiding the page remains a courtesy, not a control.
  async function isAdmin(user: SessionUser): Promise<boolean> {
    const r = await pool.query('SELECT 1 FROM platform_admins WHERE email = $1', [user.email]);
    return r.rowCount > 0;
  }

  app.get('/api/admin/is-admin', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try { res.json({ isAdmin: await isAdmin(user) }); }
    catch (err) { fail(res, err, 'check admin status'); }
  });

  app.get('/api/admin/tutors', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      if (!await isAdmin(user)) return res.status(403).json({ error: 'not authorised' });
      const r = await pool.query(`
        SELECT u.id AS user_id, u.email,
               u.created_at    AS signed_up,
               u.last_login_at AS last_signed_in,
               (SELECT count(*) FROM classes c WHERE c.teacher_id = u.id)::int AS students,
               (SELECT count(*) FROM teaching_sessions s WHERE s.teacher_id = u.id)::int AS lessons,
               (SELECT count(*) FROM teaching_sessions s WHERE s.teacher_id = u.id
                  AND s.started_at > now() - interval '30 days')::int AS lessons_30d,
               (SELECT count(*) FROM teaching_sessions s WHERE s.teacher_id = u.id
                  AND s.started_at > now() - interval '7 days')::int AS lessons_7d,
               (SELECT max(s.started_at) FROM teaching_sessions s WHERE s.teacher_id = u.id) AS last_lesson,
               (SELECT sum(s.taught_seconds) FROM teaching_sessions s WHERE s.teacher_id = u.id)::int AS taught_seconds,
               u.trial_started_at, u.paid_until,
               EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = u.email) AS is_admin
          FROM users u
      ORDER BY u.created_at DESC`);
      // Entitlement is decided in ONE place. The admin screen showing a
      // different answer from the socket gate would be worse than showing
      // nothing, so both go through accessFrom().
      const tutors = r.rows.map(t => ({
        ...t,
        billing: t.is_admin
          ? { state: 'admin' as const, until: null, daysLeft: null }
          : (() => { const a = accessFrom(t); return { state: a.state, until: a.until, daysLeft: a.daysLeft }; })(),
      }));
      res.json({ tutors });
    } catch (err) { fail(res, err, 'read tutor usage'); }
  });

  app.get('/api/admin/students', async (req: Request, res: Response) => {
    const user = requireUser(req, res); if (!user) return;
    try {
      if (!await isAdmin(user)) return res.status(403).json({ error: 'not authorised' });
      const r = await pool.query(`
        SELECT u.email AS tutor_email, c.student_name, c.label AS subject, c.room_code,
               c.created_at AS added,
               (SELECT count(*) FROM teaching_sessions s WHERE s.class_id = c.id)::int AS lessons,
               (SELECT max(s.started_at) FROM teaching_sessions s WHERE s.class_id = c.id) AS last_lesson,
               (SELECT sum(s.taught_seconds) FROM teaching_sessions s WHERE s.class_id = c.id)::int AS taught_seconds
          FROM classes c JOIN users u ON u.id = c.teacher_id
      ORDER BY c.created_at DESC`);
      res.json({ students: r.rows });
    } catch (err) { fail(res, err, 'read student usage'); }
  });
}
