// Who may do what, in one place.
//
// PLAN.md task 2.1. Until now the answer lived in four: `requireUser` in
// records.ts, an `isAdmin` query repeated in three modules, `requireTeacher`
// in server.ts, and `accessForTeacher` in billing.ts. Each was right; together
// they meant a new endpoint had to remember which of them applied, and the one
// that was forgotten is the one nobody notices — /api/admin/grant hands out
// paid time and records nothing about who granted it.
//
// The rule this file exists to keep: **the server decides, the browser only
// renders**. AdminView already says so in a comment ("the page hiding itself
// is a courtesy, not a control") and that is exactly right; this is where the
// control is.
//
// ── The transition, stated plainly ────────────────────────────────────────
// `platform_admins` is still authoritative. `users.role` is populated by
// migration 0002 and read here as well, so both agree today and the row-based
// answer can be removed in a later release once nothing depends on it.
// Reading both is not belt-and-braces, it is what lets the migration land in
// production without changing who can do anything.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { userFromRequest, type SessionUser } from './identity';

/**
 * Everything an admin or staff member can be allowed to do.
 *
 * Deliberately fine-grained even though only one person holds any of them
 * today: the point of a permission is to be able to give somebody ONE of
 * these, and a role called "staff" that means "everything except promoting"
 * is not a permission system, it is a second super-admin.
 */
export type Permission =
  | 'support.read'          // see accounts, sessions, live rooms
  | 'support.impersonate'   // "view as" for support
  | 'billing.confirm'       // confirm or reject a payment claim
  | 'billing.grant'         // grant time, VIP, change a plan, refund
  | 'content.curate'        // publish or unpublish a shared lesson
  | 'telemetry.read'        // the dashboard numbers
  | 'flags.write'           // turn a feature flag on or off
  | 'users.manage';         // suspend, delete, promote

export type Role = 'super_admin' | 'staff' | 'teacher';

/** A super_admin has every permission; staff have exactly what they are given. */
const ALL: Permission[] = [
  'support.read', 'support.impersonate', 'billing.confirm', 'billing.grant',
  'content.curate', 'telemetry.read', 'flags.write', 'users.manage',
];

export interface Actor {
  id: string;
  email: string;
  role: Role;
  permissions: Permission[];
  status: 'active' | 'suspended' | 'deleted';
  defaultWorkspaceId: string | null;
}

/**
 * Read the actor behind a request.
 *
 * Returns null for no session. A SUSPENDED user is returned rather than
 * hidden, so a caller can say "this account is suspended" instead of "not
 * signed in" — the second is what an account with a wrong password gets, and
 * telling a suspended teacher the wrong one wastes their evening and your
 * support time.
 */
export async function actorFrom(pool: Pool, req: Request, secret: string): Promise<Actor | null> {
  const session: SessionUser | null = userFromRequest(req, secret);
  if (!session) return null;
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.role, u.permissions, u.status, u.default_workspace_id,
              EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = u.email) AS legacy_admin
         FROM users u WHERE u.id = $1`,
      [session.id],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    // Either source makes you a super_admin while both exist. See the note at
    // the top: this is what lets 0002 land without changing anything.
    const role: Role = (row.legacy_admin || row.role === 'super_admin')
      ? 'super_admin'
      : (row.role === 'staff' ? 'staff' : 'teacher');
    return {
      id: row.id,
      email: row.email,
      role,
      permissions: Array.isArray(row.permissions) ? row.permissions as Permission[] : [],
      status: (row.status || 'active') as Actor['status'],
      defaultWorkspaceId: row.default_workspace_id ?? null,
    };
  } catch (err) {
    // Fails CLOSED, unlike the ownership and subscription checks. Those protect
    // a lesson and must never cancel one over a database hiccup; this protects
    // other people's data, and "the database is unwell" is not a reason to show
    // it to somebody.
    console.error('authz lookup failed (denying):', (err as Error).message);
    return null;
  }
}

/** Does this actor hold this permission? */
export function can(actor: Actor | null, permission: Permission): boolean {
  if (!actor || actor.status !== 'active') return false;
  if (actor.role === 'super_admin') return true;
  if (actor.role === 'staff') return actor.permissions.includes(permission);
  return false;
}

/** Every permission this actor holds — for the client to render with, only. */
export function permissionsOf(actor: Actor | null): Permission[] {
  if (!actor || actor.status !== 'active') return [];
  if (actor.role === 'super_admin') return [...ALL];
  if (actor.role === 'staff') return actor.permissions.filter(p => (ALL as string[]).includes(p));
  return [];
}

/**
 * Express guard. Answers the request itself when it refuses.
 *
 * A refusal is a 403 and says which permission was missing — to somebody who
 * is already signed in, that is a better error than "not authorised" and it
 * tells an attacker nothing they could not learn by trying.
 */
export function requirePermission(pool: Pool, secret: string, permission: Permission) {
  return async (req: Request, res: Response, next: () => void) => {
    const actor = await actorFrom(pool, req, secret);
    if (!actor) { res.status(401).json({ error: 'Not signed in' }); return; }
    if (actor.status === 'suspended') {
      res.status(403).json({ error: 'This account is suspended.', code: 'suspended' });
      return;
    }
    if (!can(actor, permission)) {
      res.status(403).json({ error: 'Not authorised.', code: 'forbidden', needs: permission });
      return;
    }
    (req as Request & { actor?: Actor }).actor = actor;
    next();
  };
}

export interface AuditEntry {
  actorUserId: string | null;
  actingAsUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Write down what an admin did.
 *
 * Never throws: a failure to record must not roll back the thing it was
 * recording — a teacher whose payment was confirmed and then un-confirmed
 * because the log was full is a worse outcome than a gap in the log. Where the
 * caller has a transaction, pass its client instead so the two land together.
 */
export async function audit(
  db: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  entry: AuditEntry,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO admin_audit_log
         (actor_user_id, acting_as_user_id, action, target_type, target_id, before, after, reason, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
      [
        entry.actorUserId, entry.actingAsUserId ?? null, entry.action,
        entry.targetType ?? null, entry.targetId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.reason ?? null, entry.ip ?? null, entry.userAgent ?? null,
      ],
    );
  } catch (err) {
    console.error(`audit write failed for "${entry.action}":`, (err as Error).message);
  }
}

/** The two fields every audit row wants from the request that caused it. */
export function auditContext(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: (req.ip || req.socket?.remoteAddress || null) as string | null,
    userAgent: (req.get?.('user-agent') || null) as string | null,
  };
}
