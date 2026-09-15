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
// A teacher's LIBRARY is neither, and is never cleared either: `lessons`
// (0004) and `board_templates` (0005) are what he teaches FROM, not what a
// class produced. The one place they meet this file is pictures — a template
// keeps its pictures in board_images like any board — so a picture a saved
// template uses counts as in use, exactly like one on a board that stays.
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
 * Who is asking which rooms are still standing after a clear.
 *
 * The delete asks once the doomed rooms are already gone, so every room left
 * in the table is standing. The preview asks before anything has gone, so it
 * has to name them: the rooms the delete's `updated_at < $1` does not match —
 * `updated_at >= $1`, since the column is NOT NULL — and none at all when
 * everything is going.
 */
export type ClearStep = 'preview' | 'delete';

function standingRoom(before: Date | null, step: ClearStep): string {
  if (step === 'delete') return 'true';
  return before ? 'r.updated_at >= $1' : 'false';
}

/**
 * The one definition of a picture nobody needs.
 *
 * The preview counts with it and the delete deletes with it, so the number in
 * the confirmation is the number that goes. Until 14 Sep 2026 they did not
 * share one: the preview counted pictures by age while the delete chose them by
 * reference, so the dialog could promise a number the delete never matched.
 *
 * A picture goes only when all three hold:
 *
 *   - It is older than the cutoff, when there is one. New to the delete on
 *     14 Sep 2026, and the safe direction: a picture pasted after the cutoff may
 *     be on a live board that has not been saved since, and "clear before this
 *     date" never meant anything newer.
 *   - No standing board mentions it.
 *   - No saved template mentions it, on its board or as its thumbnail. Added
 *     with board templates (PLAN.md task 2.5): clearing a term of class data
 *     must not punch holes in the boards a teacher starts next term from. The
 *     scan is bounded — templates.ts refuses a snapshot over 2MB — unlike the
 *     room scan, which is why only rooms need the size guard below.
 */
export function unusedPictureWhere(before: Date | null, step: ClearStep): string {
  return [
    before ? 'bi.created_at < $1' : 'true',
    `bi.id NOT IN (${mentionedPicturesSql(before, step)})`,
  ].join('\n       AND ');
}

/**
 * Every picture id a standing board or a saved template mentions, gathered once.
 *
 * The first version asked, for EACH picture, whether any standing room's text
 * contained it: pictures × rooms × size, on the Postgres that serves live
 * classes, and the admin panel asks again on every change of date (found in
 * review, 15 Sep 2026). This reads each standing room and each template once and
 * collects every token that could be a picture id, so the cost is the size of
 * the boards rather than that times the number of pictures. NOT IN over a
 * subquery that never correlates is hashed once.
 *
 * A picture id is 32 lower-case hex characters (boardImages.ts). Any standalone
 * run of exactly that counts as a mention, whatever surrounds it: a superset of
 * the real links, so a coincidence can only keep a picture that could have gone,
 * never delete one still in use. No branch yields NULL, which NOT IN needs.
 */
function mentionedPicturesSql(before: Date | null, step: ClearStep): string {
  const token = `'(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])'`;
  return [
    `SELECT m[1] FROM rooms r, regexp_matches(r.data::text, ${token}, 'g') AS m WHERE ${standingRoom(before, step)}`,
    `SELECT m[1] FROM board_templates t, regexp_matches(t.snapshot::text, ${token}, 'g') AS m`,
    'SELECT t.preview_image_id FROM board_templates t WHERE t.preview_image_id IS NOT NULL',
  ].join('\n         UNION ');
}

/** Standing boards too large to scan safely; any at all and no picture goes. */
export function largeStandingRoomsSql(before: Date | null, step: ClearStep): string {
  // 8MB: comfortably above a normal board and far below the size at which
  // casting jsonb to text has actually taken this database down.
  return `SELECT count(*) FROM rooms r WHERE ${standingRoom(before, step)} AND pg_column_size(data) > 8388608`;
}

/** Exactly the parameters a statement uses — Postgres refuses a bind with one to spare. */
function paramsFor(sql: string, before: Date | null): Date[] {
  return before && /\$1(?!\d)/.test(sql) ? [before] : [];
}

/**
 * How many rows a clear would touch.
 *
 * Counted with exactly the same predicate the delete uses, so the number shown
 * in the confirmation is the number that will go. Anything less than that is a
 * confirmation dialog that lies.
 */
export async function previewClear(pool: Pool, before: Date | null): Promise<ClearCounts> {
  const bigSql = largeStandingRoomsSql(before, 'preview');
  const [rooms, sessions, big] = await Promise.all([
    pool.query(
      before ? 'SELECT count(*) FROM rooms WHERE updated_at < $1' : 'SELECT count(*) FROM rooms',
      before ? [before] : [],
    ),
    pool.query(
      before ? 'SELECT count(*) FROM teaching_sessions WHERE started_at < $1' : 'SELECT count(*) FROM teaching_sessions',
      before ? [before] : [],
    ),
    pool.query(bigSql, paramsFor(bigSql, before)),
  ]);

  // The delete skips pictures entirely while a standing board is too big to
  // scan, so in that case none will go and none are counted.
  let boardImages = 0;
  if (Number(big.rows[0].count) === 0) {
    const imagesSql = `SELECT count(*) FROM board_images bi WHERE ${unusedPictureWhere(before, 'preview')}`;
    const images = await pool.query(imagesSql, paramsFor(imagesSql, before));
    boardImages = Number(images.rows[0].count);
  }

  return {
    rooms: Number(rooms.rows[0].count),
    boardImages,
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
 * than by age alone: an image is deleted only when no surviving room and no
 * saved template mentions it (unusedPictureWhere). That scan casts room JSON to
 * text, which this codebase has learned to be careful about — a 128MB board
 * once killed Postgres twice when cast — so it is skipped entirely if any
 * surviving room is still large, and skipping is the safe direction: it keeps a
 * picture that could have gone, rather than deleting one that is still in use.
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
    const bigSql = largeStandingRoomsSql(before, 'delete');
    const big = await client.query(bigSql, paramsFor(bigSql, before));
    if (Number(big.rows[0].count) === 0) {
      const imagesSql = `DELETE FROM board_images bi WHERE ${unusedPictureWhere(before, 'delete')}`;
      const imgs = await client.query(imagesSql, paramsFor(imagesSql, before));
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
