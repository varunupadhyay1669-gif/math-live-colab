// The user-management half of the owner's console.
//
// PLAN.md task 2.10, and the part of the founder's original brief that has
// never existed: "I need a super-admin role with a sophisticated live
// dashboard… I and anyone I hand-pick get full access free forever."
//
// /admin could already answer "who uses this" and "who is about to lapse". It
// could not DO anything: every action — give somebody free access, stop an
// account, write down why — meant SQL on the box. Which is how Vani's access
// got extended by hand on 2 Sep, and how the only record of that decision
// ended up being a line in a chat log.
//
// Three rules, all of them enforced here rather than in the page:
//
//   1. Every route requires a permission (src/server/authz.ts), checked in the
//      database on every request. The page hiding a button is a courtesy.
//   2. Every action that changes anything is written to admin_audit_log in the
//      SAME transaction, so there is no way to do the thing and lose the note.
//   3. Nothing here can take money, refund money, or delete a person. Those
//      are Phase 3 and need a gateway and a lawyer respectively.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { actorFrom, can, audit, auditContext, permissionsOf, type Actor } from './authz';
import { accessFrom } from './billing';

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

export function mountPeopleRoutes(app: any, pool: Pool, opts: { secret: string }) {
  const { secret } = opts;

  /** Resolve the actor, or answer the request. Returns null once answered. */
  async function gate(req: Request, res: Response, permission: Parameters<typeof can>[1]): Promise<Actor | null> {
    const actor = await actorFrom(pool, req, secret);
    if (!actor) { res.status(401).json({ error: 'Not signed in' }); return null; }
    if (actor.status === 'suspended') {
      res.status(403).json({ error: 'This account is suspended.', code: 'suspended' });
      return null;
    }
    if (!can(actor, permission)) {
      res.status(403).json({ error: 'Not authorised.', code: 'forbidden', needs: permission });
      return null;
    }
    return actor;
  }

  const fail = (res: Response, err: unknown, what: string) => {
    console.error(`${what} failed:`, (err as Error).message);
    res.status(500).json({ error: `Could not ${what}.` });
  };

  /** What the page may render. Lets the client hide what it cannot do. */
  app.get('/api/admin/me', async (req: Request, res: Response) => {
    const actor = await actorFrom(pool, req, secret);
    res.json({
      role: actor?.role ?? null,
      status: actor?.status ?? null,
      permissions: permissionsOf(actor),
    });
  });

  // ── The list ─────────────────────────────────────────────────────────────
  app.get('/api/admin/people', async (req: Request, res: Response) => {
    if (!await gate(req, res, 'support.read')) return;
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 120);
    try {
      const r = await pool.query(
        `SELECT u.id, u.email, u.role, u.status, u.created_at, u.last_login_at,
                u.trial_started_at, u.paid_until,
                (SELECT count(*) FROM classes c WHERE c.teacher_id = u.id)::int AS learners,
                (SELECT count(*) FROM teaching_sessions s WHERE s.teacher_id = u.id)::int AS lessons,
                (SELECT max(s.started_at) FROM teaching_sessions s WHERE s.teacher_id = u.id) AS last_lesson,
                g.id IS NOT NULL AS grant_active,
                g.until AS grant_until,
                g.reason AS grant_reason
           FROM users u
           LEFT JOIN LATERAL (
             SELECT id, until, reason FROM plan_grants
              WHERE user_id = u.id AND revoked_at IS NULL
                AND (until IS NULL OR until > now())
              ORDER BY until DESC NULLS FIRST LIMIT 1
           ) g ON true
          WHERE ($1 = '' OR lower(u.email) LIKE '%' || $1 || '%')
          ORDER BY u.last_login_at DESC NULLS LAST, u.created_at DESC
          LIMIT 200`,
        [q],
      );
      // Entitlement is decided in ONE place. The console showing a different
      // answer from the socket gate would be worse than showing nothing.
      res.json({
        people: r.rows.map(p => ({
          ...p,
          access: p.role === 'super_admin'
            ? { state: 'admin', until: null, daysLeft: null }
            : (() => { const a = accessFrom(p); return { state: a.state, until: a.until, daysLeft: a.daysLeft }; })(),
        })),
      });
    } catch (err) { fail(res, err, 'list people'); }
  });

  // ── One person, in full ──────────────────────────────────────────────────
  app.get('/api/admin/people/:id', async (req: Request, res: Response) => {
    if (!await gate(req, res, 'support.read')) return;
    const uid = String(req.params.id);
    try {
      const [user, classes, grants, notes, payments, log] = await Promise.all([
        pool.query('SELECT id, email, role, permissions, status, status_reason, created_at, last_login_at, trial_started_at, paid_until, timezone FROM users WHERE id = $1', [uid]),
        pool.query('SELECT id, student_name, label, room_code, created_at, last_opened_at FROM classes WHERE teacher_id = $1 ORDER BY last_opened_at DESC NULLS LAST LIMIT 100', [uid]),
        pool.query('SELECT id, plan_code, until, reason, granted_by, created_at, revoked_at, revoked_by FROM plan_grants WHERE user_id = $1 ORDER BY created_at DESC', [uid]),
        pool.query('SELECT id, note, author_id, created_at FROM admin_notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [uid]),
        pool.query('SELECT id, amount_rupees, months, reference, claimed_at, confirmed_at, rejected_at FROM payment_claims WHERE teacher_id = $1 ORDER BY claimed_at DESC LIMIT 50', [uid]),
        pool.query('SELECT id, actor_user_id, action, before, after, reason, at FROM admin_audit_log WHERE target_type = $1 AND target_id = $2 ORDER BY at DESC LIMIT 50', ['user', uid]),
      ]);
      if (user.rowCount === 0) return res.status(404).json({ error: 'No such account.' });
      res.json({
        user: user.rows[0], classes: classes.rows, grants: grants.rows,
        notes: notes.rows, payments: payments.rows, audit: log.rows,
      });
    } catch (err) { fail(res, err, 'read the account'); }
  });

  // ── Free forever ─────────────────────────────────────────────────────────
  app.post('/api/admin/people/:id/grant', async (req: Request, res: Response) => {
    const actor = await gate(req, res, 'billing.grant'); if (!actor) return;
    const uid = String(req.params.id);
    const body = (req.body || {}) as { reason?: string; untilIso?: string | null };
    const reason = String(body.reason || '').trim().slice(0, 500);
    if (!reason) {
      // Required, not optional. A grant with no reason is the one nobody can
      // explain in six months, and the reason is the only part of this that
      // cannot be reconstructed later.
      return res.status(400).json({ error: 'Say why. A free-forever grant with no reason is one nobody can explain later.' });
    }
    const until = body.untilIso ? new Date(body.untilIso) : null;
    if (until && Number.isNaN(until.getTime())) return res.status(400).json({ error: 'That date is not a date.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = await client.query('SELECT id, email FROM users WHERE id = $1', [uid]);
      if (t.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such account.' }); }
      const gid = id('grant');
      await client.query(
        `INSERT INTO plan_grants (id, user_id, plan_code, until, reason, granted_by)
         VALUES ($1, $2, 'pro', $3, $4, $5)`,
        [gid, uid, until, reason, actor.id],
      );
      // Same transaction as the grant: there is no way to give somebody the
      // product for nothing and lose the note that says who did.
      await audit(client, {
        actorUserId: actor.id, action: 'grant.create',
        targetType: 'user', targetId: uid,
        after: { grantId: gid, until: until ? until.toISOString() : null, plan: 'pro' },
        reason, ...auditContext(req),
      });
      await client.query('COMMIT');
      res.json({ ok: true, grantId: gid, until: until ? until.toISOString() : null });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* going back to the pool anyway */ }
      fail(res, err, 'grant free access');
    } finally { client.release(); }
  });

  app.post('/api/admin/people/:id/revoke-grant', async (req: Request, res: Response) => {
    const actor = await gate(req, res, 'billing.grant'); if (!actor) return;
    const uid = String(req.params.id);
    const reason = String((req.body as { reason?: string } | undefined)?.reason || '').trim().slice(0, 500);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `UPDATE plan_grants SET revoked_at = now(), revoked_by = $2, revoked_reason = $3
          WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [uid, actor.id, reason || null],
      );
      await audit(client, {
        actorUserId: actor.id, action: 'grant.revoke',
        targetType: 'user', targetId: uid,
        after: { revoked: r.rows.map((x: { id: string }) => x.id) },
        reason: reason || null, ...auditContext(req),
      });
      await client.query('COMMIT');
      res.json({ ok: true, revoked: r.rowCount ?? 0 });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      fail(res, err, 'revoke the grant');
    } finally { client.release(); }
  });

  // ── Stop an account, without losing it ───────────────────────────────────
  app.post('/api/admin/people/:id/status', async (req: Request, res: Response) => {
    const actor = await gate(req, res, 'users.manage'); if (!actor) return;
    const uid = String(req.params.id);
    const body = (req.body || {}) as { status?: string; reason?: string };
    const next = body.status === 'suspended' ? 'suspended' : 'active';
    const reason = String(body.reason || '').trim().slice(0, 500);
    if (next === 'suspended' && !reason) {
      return res.status(400).json({ error: 'Say why you are suspending this account.' });
    }
    if (uid === actor.id) {
      // Cheap, and it has happened to better systems than this one.
      return res.status(400).json({ error: 'You cannot suspend yourself.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT status, session_epoch FROM users WHERE id = $1', [uid]);
      if (before.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such account.' }); }
      // The epoch bump is what makes suspension take effect NOW. Without it a
      // signed session cookie stays valid for thirty days, so a suspended
      // account keeps working until it happens to sign out.
      await client.query(
        `UPDATE users SET status = $2, status_reason = $3,
                session_epoch = session_epoch + CASE WHEN $2 = 'suspended' THEN 1 ELSE 0 END
          WHERE id = $1`,
        [uid, next, reason || null],
      );
      await audit(client, {
        actorUserId: actor.id, action: next === 'suspended' ? 'user.suspend' : 'user.unsuspend',
        targetType: 'user', targetId: uid,
        before: { status: before.rows[0].status }, after: { status: next },
        reason: reason || null, ...auditContext(req),
      });
      await client.query('COMMIT');
      res.json({ ok: true, status: next });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      fail(res, err, 'change the account status');
    } finally { client.release(); }
  });

  // ── What you understood at the time ──────────────────────────────────────
  app.post('/api/admin/people/:id/note', async (req: Request, res: Response) => {
    const actor = await gate(req, res, 'support.read'); if (!actor) return;
    const note = String((req.body as { note?: string } | undefined)?.note || '').trim().slice(0, 2000);
    if (!note) return res.status(400).json({ error: 'Nothing to save.' });
    try {
      const r = await pool.query(
        'INSERT INTO admin_notes (user_id, note, author_id) VALUES ($1, $2, $3) RETURNING id, note, author_id, created_at',
        [String(req.params.id), note, actor.id],
      );
      res.json({ ok: true, note: r.rows[0] });
    } catch (err) { fail(res, err, 'save the note'); }
  });

  // ── Everything that has been done ────────────────────────────────────────
  app.get('/api/admin/audit', async (req: Request, res: Response) => {
    if (!await gate(req, res, 'support.read')) return;
    try {
      const r = await pool.query(
        `SELECT a.id, a.actor_user_id, u.email AS actor_email, a.acting_as_user_id,
                a.action, a.target_type, a.target_id, t.email AS target_email,
                a.before, a.after, a.reason, a.at
           FROM admin_audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
           LEFT JOIN users t ON t.id = a.target_id AND a.target_type = 'user'
          ORDER BY a.at DESC LIMIT 200`,
      );
      res.json({ entries: r.rows });
    } catch (err) { fail(res, err, 'read the audit log'); }
  });
}
