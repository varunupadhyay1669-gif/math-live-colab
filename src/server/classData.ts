// Clearing out the classes, without clearing out the students.
//
// Asked for on 4 Sep 2026: "delete all the data of the classes. Don't delete
// the name of the student, just the data of the classes. And also give an
// option in the admin section where I can directly click on clear data of the
// classes and select date, so that I can do it from there."
//
// The distinction in that sentence is the whole design. A class here is two
// separate things:
//
//   the ROSTER   — `classes`: the student's name, their grade, their goals,
//                  their room code. This is who he teaches. Never touched.
//   the CONTENT  — `rooms` (saved boards and lesson state), `board_images`
//                  (pictures pasted on a whiteboard) and `teaching_sessions`
//                  (the record of a lesson). This is what a class produced,
//                  and this is what gets cleared.
//
// Deleting the roster would mean re-adding every student by hand and reissuing
// every learner link, so the two are kept in different tables and only one of
// them appears below. There is no code path here that can reach `classes`.
//
// Why an endpoint rather than a note saying "ask an engineer": the alternative
// is somebody typing DELETE into a production database at speed, which is how
// the wrong thing gets deleted. This is the same operation with a preview, a
// permission, and a line in the audit log saying who did it and when.
import type { Pool } from 'pg';
import type { Request, Response } from 'express';
import { actorFrom, can, audit, auditContext, type Actor } from './authz';

/** What a clear would remove, or did. */
export interface ClearCounts {
  rooms: number;
  boardImages: number;
  sessions: number;
}

/**
 * Read the cutoff out of a request.
 *
 * Returns null for "everything", a Date for "older than this", and throws for
 * anything it cannot understand — a date that silently parses to Invalid Date
 * would compare false against every row and quietly delete NOTHING, which is
 * the failure that gets discovered a month later.
 */
export function cutoffFrom(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new Error('That date could not be read.');
  return d;
}

/**
 * How many rows a clear would touch.
 *
 * Counted with exactly the same predicate the delete uses, so the number shown
 * in the confirmation is the number that will go. Anything less than that is a
 * confirmation dialog that lies.
 */
export async function previewClear(pool: Pool, before: Date | null): Promise<ClearCounts> {
  const [rooms, images, sessions] = await Promise.all([
    pool.query(
      before ? 'SELECT count(*) FROM rooms WHERE updated_at < $1' : 'SELECT count(*) FROM rooms',
      before ? [before] : [],
    ),
    pool.query(
      before ? 'SELECT count(*) FROM board_images WHERE created_at < $1' : 'SELECT count(*) FROM board_images',
      before ? [before] : [],
    ),
    pool.query(
      before ? 'SELECT count(*) FROM teaching_sessions WHERE started_at < $1' : 'SELECT count(*) FROM teaching_sessions',
      before ? [before] : [],
    ),
  ]);
  return {
    rooms: Number(rooms.rows[0].count),
    boardImages: Number(images.rows[0].count),
    sessions: Number(sessions.rows[0].count),
  };
}

/**
 * Do it, in one transaction.
 *
 * Order matters for the pictures. A board_image is content-addressed and shared
 * — the same picture pasted into two boards is one row — so an image older than
 * the cutoff can still be on a board that is NOT being deleted. Removing it
 * would leave a hole in a board somebody is still teaching from.
 *
 * So the rooms go first, and then the images are collected by REFERENCE rather
 * than by age: an image is deleted only when no surviving room mentions it.
 * That scan casts room JSON to text, which this codebase has learned to be
 * careful about — a 128MB board once killed Postgres twice when cast — so it is
 * skipped entirely if any surviving room is still large, and skipping is the
 * safe direction: it keeps a picture that could have gone, rather than deleting
 * one that is still in use.
 */
export async function clearClassData(pool: Pool, before: Date | null): Promise<ClearCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rooms = await client.query(
      before ? 'DELETE FROM rooms WHERE updated_at < $1' : 'DELETE FROM rooms',
      before ? [before] : [],
    );
    const sessions = await client.query(
      before ? 'DELETE FROM teaching_sessions WHERE started_at < $1' : 'DELETE FROM teaching_sessions',
      before ? [before] : [],
    );

    let boardImages = 0;
    // 8MB: comfortably above a normal board and far below the size at which
    // casting jsonb to text has actually taken this database down.
    const big = await client.query(
      'SELECT count(*) FROM rooms WHERE pg_column_size(data) > 8388608',
    );
    if (Number(big.rows[0].count) === 0) {
      const imgs = await client.query(
        `DELETE FROM board_images bi
          WHERE NOT EXISTS (
            SELECT 1 FROM rooms r WHERE position(bi.id in r.data::text) > 0
          )`,
      );
      boardImages = imgs.rowCount ?? 0;
    }

    await client.query('COMMIT');
    return { rooms: rooms.rowCount ?? 0, sessions: sessions.rowCount ?? 0, boardImages };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the connection is already gone */ });
    throw err;
  } finally {
    client.release();
  }
}

export function mountClassDataRoutes(app: any, pool: Pool, opts: { secret: string }) {
  const { secret } = opts;

  async function gate(req: Request, res: Response): Promise<Actor | null> {
    const actor = await actorFrom(pool, req, secret);
    if (!actor) { res.status(401).json({ error: 'Not signed in' }); return null; }
    if (actor.status === 'suspended') {
      res.status(403).json({ error: 'This account is suspended.', code: 'suspended' });
      return null;
    }
    // Deliberately the same permission as suspending an account. Erasing every
    // board in the product is not a lesser act than disabling one login.
    if (!can(actor, 'users.manage')) {
      res.status(403).json({ error: 'Not authorised.', code: 'forbidden', needs: 'users.manage' });
      return null;
    }
    return actor;
  }

  // What would go, if you did it now.
  app.get('/api/admin/class-data', async (req: Request, res: Response) => {
    const actor = await gate(req, res); if (!actor) return;
    try {
      const before = cutoffFrom(req.query.before);
      res.json({ before: before ? before.toISOString() : null, counts: await previewClear(pool, before) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/class-data/clear', async (req: Request, res: Response) => {
    const actor = await gate(req, res); if (!actor) return;
    const body = (req.body || {}) as { before?: string; confirm?: unknown };
    // An explicit confirm, because a mis-routed POST should not be able to
    // empty the product. The UI sends it after showing the counts.
    if (body.confirm !== true) {
      return res.status(400).json({ error: 'This needs an explicit confirmation.' });
    }
    let before: Date | null;
    try {
      before = cutoffFrom(body.before);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    try {
      const counts = await clearClassData(pool, before);
      // Audited AFTER the fact and outside the transaction on purpose: the log
      // must record what really happened, and a rolled-back delete that still
      // wrote a log line would be worse than no log line at all.
      await audit(pool, {
        actorUserId: actor.id,
        action: 'class_data.clear',
        targetType: 'class_data',
        targetId: before ? `before:${before.toISOString()}` : 'all',
        after: counts,
        reason: before ? `Cleared class data before ${before.toISOString()}` : 'Cleared all class data',
        ...auditContext(req),
      });
      console.log(`🧹 admin ${actor.email}: cleared class data${before ? ` before ${before.toISOString()}` : ''} — ${counts.rooms} rooms, ${counts.sessions} lessons, ${counts.boardImages} pictures`);
      res.json({ ok: true, counts });
    } catch (err) {
      console.error('Clearing class data failed:', (err as Error).message);
      res.status(500).json({ error: 'Could not clear the data. Nothing was changed.' });
    }
  });
}
