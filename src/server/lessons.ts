// The lesson library, in the account rather than in one browser.
//
// Two failures it ends, and they turned out to be the same failure.
//
// A lesson written on the laptop could not be opened on the iPad, because the
// library was localStorage (SimulationLibrary.tsx) — PLAN.md task 2.4, and the
// reason the founder's answer to "what should I build next" mattered.
//
// And on 9 Sep 2026 that stopped being a convenience problem. 33 lesson files
// were living inside 31 rooms, and the "clear class data" button deletes rooms.
// The database's only copy of a term of work was inside the rows the founder
// had asked to erase. Migration 0004 lifts them out; this is how he gets them
// back.
//
// Scoped by teacher_id on every statement, like every other route in this
// codebase: the caller is never trusted to say whose lesson this is.
import type { Pool } from 'pg';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { userFromCookieHeader } from './identity';

/** 2MB, the same ceiling the room's own file upload uses. */
const MAX_LESSON_BYTES = 2 * 1024 * 1024;
/** Enough for years of teaching; a floor under a runaway, not a working limit. */
const MAX_LESSONS_PER_TEACHER = 500;

const contentKey = (html: string) => createHash('md5').update(html).digest('hex');

export function mountLessonRoutes(app: any, pool: Pool, opts: { secret: string }) {
  const { secret } = opts;

  function who(req: Request): { id: string } | null {
    const u = userFromCookieHeader(req.headers.cookie, secret);
    return u ? { id: u.id } : null;
  }

  // The list, WITHOUT the html. A teacher with fifty lessons would otherwise
  // download every one of them to render a list of names — and on the iPad
  // that is the difference between a library that opens and one that hangs.
  app.get('/api/lessons', async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to see your library.' });
    try {
      const r = await pool.query(
        `SELECT id, name, topic, source, length(html) AS bytes, updated_at
           FROM lessons WHERE teacher_id = $1 ORDER BY updated_at DESC`,
        [user.id],
      );
      res.json({ lessons: r.rows });
    } catch (err) {
      console.error('Could not list lessons:', (err as Error).message);
      res.status(500).json({ error: 'Could not read your library.' });
    }
  });

  // One lesson, with its html. Fetched when a teacher actually opens it.
  app.get('/api/lessons/:id', async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to see your library.' });
    try {
      const r = await pool.query(
        'SELECT id, name, topic, html, source, updated_at FROM lessons WHERE id = $1 AND teacher_id = $2',
        [String(req.params.id), user.id],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'No such lesson.' });
      res.json({ lesson: r.rows[0] });
    } catch (err) {
      console.error('Could not read lesson:', (err as Error).message);
      res.status(500).json({ error: 'Could not read that lesson.' });
    }
  });

  app.post('/api/lessons', async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to save to your library.' });
    const body = (req.body || {}) as { name?: string; html?: string; topic?: string };
    const html = typeof body.html === 'string' ? body.html : '';
    const name = String(body.name || '').trim().slice(0, 120) || 'Untitled lesson';
    if (!html) return res.status(400).json({ error: 'There is nothing to save.' });
    if (html.length > MAX_LESSON_BYTES) {
      return res.status(413).json({ error: 'That lesson is too large to save (2MB limit).' });
    }
    try {
      const count = await pool.query('SELECT count(*) FROM lessons WHERE teacher_id = $1', [user.id]);
      if (Number(count.rows[0].count) >= MAX_LESSONS_PER_TEACHER) {
        return res.status(409).json({ error: `Your library holds ${MAX_LESSONS_PER_TEACHER} lessons — delete one first.` });
      }
      const key = contentKey(html);
      // Saving the same lesson twice renames it rather than filing it twice.
      // A tutor pressing Save again after a tweak to the title means "this
      // one", not "another one" — and the rescue in migration 0004 leans on
      // the same key to avoid five copies of a lesson taught in five rooms.
      const r = await pool.query(
        `INSERT INTO lessons (id, teacher_id, name, html, content_key, topic, source)
              VALUES ($1, $2, $3, $4, $5, $6, 'saved from the board')
         ON CONFLICT (teacher_id, content_key)
         DO UPDATE SET name = EXCLUDED.name, topic = EXCLUDED.topic, updated_at = now()
           RETURNING id, name, topic, updated_at`,
        [`les-${contentKey(user.id + key).slice(0, 16)}`, user.id, name, html, key, body.topic || null],
      );
      res.json({ lesson: r.rows[0] });
    } catch (err) {
      console.error('Could not save lesson:', (err as Error).message);
      res.status(500).json({ error: 'Could not save that lesson.' });
    }
  });

  app.delete('/api/lessons/:id', async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to change your library.' });
    try {
      const r = await pool.query(
        'DELETE FROM lessons WHERE id = $1 AND teacher_id = $2',
        [String(req.params.id), user.id],
      );
      res.json({ ok: true, deleted: r.rowCount ?? 0 });
    } catch (err) {
      console.error('Could not delete lesson:', (err as Error).message);
      res.status(500).json({ error: 'Could not delete that lesson.' });
    }
  });
}
