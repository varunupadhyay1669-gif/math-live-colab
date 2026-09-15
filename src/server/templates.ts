// Board templates, in the account rather than in one browser.
//
// PLAN.md task 2.5, and the same failure 2.4 ended for lessons. The founder
// teaches from a laptop and an iPad; a template saved on the laptop lived in
// that browser's localStorage and did not exist on the iPad. Since 9 Sep 2026 a
// lesson follows the teacher between devices (lessons.ts); this makes a board
// template do the same. Migration 0005 is the table.
//
// The rules are the lesson library's rules:
//
//   * Every statement is scoped by owner_user_id, taken from the verified
//     session cookie. The caller is never asked, and never believed, about
//     whose template something is.
//   * Size and count are capped, and every refusal says what to do next in a
//     sentence a tutor can act on mid-class.
//
// And one rule of its own. A stored template never holds an inline data: URL.
// Pictures pasted as data URLs are what made one room 128MB and crash-looped
// the server on 3-4 Sep 2026; they have lived in board_images since. A template
// arriving with inline pictures (an old browser copy being imported, or a board
// whose upload fell back to a data URL) has them moved out with the same helper
// the room uses when it opens. Anything that cannot be moved out is refused,
// because the alternative is storing exactly the thing that took the site down.
import express from 'express';
import type { Pool } from 'pg';
import type { Request, Response } from 'express';
import { randomInt } from 'crypto';
import { userFromCookieHeader } from './identity';
import { externaliseBoardImages, parseDataUrl } from './boardImages';
import { rateLimit } from './rateLimit';

/**
 * 2MB of board, measured AFTER the pictures have moved out — the same ceiling
 * the lesson library and the room's own file upload use. What is left is
 * strokes, shapes, text and rulers; a board that still passes this is one to
 * clear some ink from, not one to store.
 */
export const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;

/**
 * Four times what a browser could ever hold (prefs.ts kept 25). A floor under a
 * runaway, not a working limit.
 */
export const MAX_TEMPLATES_PER_TEACHER = 100;

/**
 * The body of a template save comes under a media type of its own.
 *
 * server.ts parses JSON for every route at the 100kB default, and this module
 * is mounted after that parser, so the larger parser a template needs cannot be
 * put in front of it from here — the routes that needed one (/api/publish,
 * /api/board-image, /api/sessions) were each registered above the global
 * parser by hand. A board with a few hundred strokes passes 100kB without
 * trying (server.ts says so about saved lessons), and a browser copy being
 * imported can still carry its pictures inline until they are moved out below.
 * The global parser only claims application/json, so a body sent as this type
 * reaches the parser sized for it instead of a bare 413.
 */
export const TEMPLATE_MEDIA_TYPE = 'application/vnd.mathslive.template+json';

/** The saved-lesson ceiling in server.ts: room for a legacy copy whose pictures are still inline. */
const TEMPLATE_BODY_LIMIT = '8mb';

/** The alphabet prefs.ts has minted template ids from since templates shipped: no 0/o or 1/i/l. */
export const TEMPLATE_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * A template id a link can carry: /room/X?template=abc234.
 *
 * Wider than the alphabet on purpose — any six lower-case letters or digits —
 * so no id a browser ever minted is refused on import. The table's CHECK is the
 * same pattern, so nothing unlinkable can be stored by any other route either.
 */
const TEMPLATE_ID = /^[a-z0-9]{6}$/;

export function isTemplateId(id: unknown): id is string {
  return typeof id === 'string' && TEMPLATE_ID.test(id);
}

export function newTemplateId(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += TEMPLATE_ID_ALPHABET[randomInt(TEMPLATE_ID_ALPHABET.length)];
  return s;
}

/**
 * An inline picture inside a string: `data:`, an optional media type and
 * parameters, then the comma where the data starts.
 *
 * Not anchored to the start, because a picture inside a style string is still a
 * picture in the table. The media type is optional because it is optional in a
 * data URL: `data:;base64,iVBOR…` is a PNG to every browser, and the first
 * version of this pattern, which required the type, let exactly that through
 * and stored it inline (found in review, 15 Sep 2026). Still narrow enough that
 * a teacher writing "data: 3, 5, 8" on the board is not mistaken for one: that
 * has a space where the type or the comma would be.
 */
const INLINE_DATA_URL = /\bdata:(?:[a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.+-]+)*,/i;

export interface InlinePicture { path: string; value: string; }

/**
 * Every string in a snapshot that carries an inline data: URL, with where it is.
 *
 * Walks with an explicit stack rather than recursion: the body is whatever a
 * caller posted, and a deeply nested one must not be able to overflow the stack
 * of the process that is also running every lesson.
 */
export function findInlineDataUrls(root: unknown, limit = 20): InlinePicture[] {
  const found: InlinePicture[] = [];
  const stack: Array<[unknown, string]> = [[root, '']];
  while (stack.length > 0 && found.length < limit) {
    const [value, path] = stack.pop()!;
    if (typeof value === 'string') {
      if (INLINE_DATA_URL.test(value)) found.push({ path: path || '(snapshot)', value });
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push([value[i], `${path}[${i}]`]);
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        stack.push([(value as Record<string, unknown>)[key], path ? `${path}.${key}` : key]);
      }
    }
  }
  return found;
}

const BOARD_LISTS = ['objects', 'strokes', 'shapes', 'texts', 'instruments'] as const;

/** Why this is not a whiteboard snapshot, or null when it is one. */
export function snapshotProblem(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return 'There is no board to save.';
  }
  for (const key of BOARD_LISTS) {
    const list = (snapshot as Record<string, unknown>)[key];
    if (list !== undefined && !Array.isArray(list)) return 'That board could not be read, so it was not saved.';
  }
  return null;
}

export function templateName(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 120) || 'Untitled template';
}

/**
 * When the teacher saved it.
 *
 * An imported browser copy says when it was saved, and keeping that is what
 * stops a template from June reading "saved just now" on the iPad. A time before
 * 2020 or in the future is a wrong clock or a corrupt copy, not a save, and
 * gets the present instead.
 */
export function savedAtFrom(raw: unknown, now = Date.now()): Date {
  const ms = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms) || ms < Date.UTC(2020, 0, 1) || ms > now + 5 * 60_000) return new Date(now);
  return new Date(ms);
}

/** The one place a picture can be moved out of a snapshot: see externaliseBoardImages. */
const MOVABLE_PICTURE = /^objects\[\d+\]\.src$/;

export function mountTemplateRoutes(app: any, pool: Pool, opts: { secret: string }) {
  const { secret } = opts;

  function who(req: Request): { id: string } | null {
    const u = userFromCookieHeader(req.headers.cookie, secret);
    return u ? { id: u.id } : null;
  }

  // The list, WITHOUT the snapshots. The home page needs names and dates; a
  // teacher with forty templates should not download forty boards to read them,
  // least of all on the iPad.
  app.get('/api/templates', async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to see the templates in your account.' });
    try {
      const r = await pool.query(
        `SELECT id, name, bytes, saved_at
           FROM board_templates WHERE owner_user_id = $1 ORDER BY saved_at DESC`,
        [user.id],
      );
      res.json({ templates: r.rows });
    } catch (err) {
      console.error('Could not list board templates:', (err as Error).message);
      res.status(500).json({ error: 'Could not read your templates.' });
    }
  });

  // One template, with its board. Fetched when a class is started from it.
  app.get('/api/templates/:id', async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to use the templates in your account.' });
    const id = String(req.params.id || '');
    if (!isTemplateId(id)) return res.status(404).json({ error: 'No such template.' });
    try {
      const r = await pool.query(
        'SELECT id, name, snapshot, saved_at FROM board_templates WHERE owner_user_id = $1 AND id = $2',
        [user.id, id],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'No such template.' });
      res.json({ template: r.rows[0] });
    } catch (err) {
      console.error('Could not read board template:', (err as Error).message);
      res.status(500).json({ error: 'Could not open that template.' });
    }
  });

  // Ahead of the body parser, so a flood is refused before 8MB of it is read.
  // Twenty a minute: the same as the 8MB saved-lesson route in server.ts, which
  // calls 8MB at an unbounded rate a memory attack on a 1 GB box. A browser's
  // worth of templates (25) moves over two visits instead of one; the client
  // stops at the first refusal and tries the rest next time.
  const writeLimit = rateLimit({
    name: 'template-write', windowMs: 60_000,
    max: Number(process.env.TEMPLATE_WRITES_PER_MIN) || 20,
  });
  // And nobody's 8MB is read before we know whose it is. The session is a
  // cookie, so asking costs nothing, and a caller with no account never reaches
  // the parser. The first version parsed first and asked after (found in review,
  // 15 Sep 2026).
  const signedInFirst = (req: Request, res: Response, next: () => void) => {
    if (who(req)) return next();
    res.status(401).json({ error: 'Sign in to save templates to your account.' });
  };
  const templateBody = express.json({ type: TEMPLATE_MEDIA_TYPE, limit: TEMPLATE_BODY_LIMIT });
  // Express's own answer to a parser failure is an HTML page the client cannot
  // read, which is how a save turns into a silent nothing.
  const bodyRefused = (err: any, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if (!err) return next();
    const tooBig = err.type === 'entity.too.large' || err.status === 413;
    res.status(tooBig ? 413 : 400).json({
      error: tooBig
        ? 'That board is too large to save as a template.'
        : 'That template could not be read, so it was not saved.',
    });
  };

  app.post('/api/templates', writeLimit, signedInFirst, templateBody, async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to save templates to your account.' });
    const body = (req.body || {}) as { id?: unknown; name?: unknown; snapshot?: unknown; savedAt?: unknown };

    const problem = snapshotProblem(body.snapshot);
    if (problem) return res.status(400).json({ error: problem });
    const snapshot = body.snapshot as Record<string, unknown>;

    // An id means THIS template: the import keeps a browser copy's id so the
    // links already made with it keep opening, and saving under it again
    // replaces it. No id means a new template with a fresh one.
    const wanted = body.id === undefined || body.id === null || body.id === '' ? null : body.id;
    if (wanted !== null && !isTemplateId(wanted)) {
      return res.status(400).json({ error: 'That template id cannot be used in a link, so it was not saved.' });
    }

    try {
      // Counted first, before any picture is stored for a save that is going to
      // be refused. Replacing a template the teacher already has never counts.
      const have = await pool.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE id = $2)::int AS same
           FROM board_templates WHERE owner_user_id = $1`,
        [user.id, wanted],
      );
      const n = Number(have.rows[0]?.n ?? 0);
      const same = Number(have.rows[0]?.same ?? 0);
      if (same === 0 && n >= MAX_TEMPLATES_PER_TEACHER) {
        return res.status(409).json({
          error: `Your account holds ${MAX_TEMPLATES_PER_TEACHER} templates — delete one to save another.`,
          code: 'template_limit',
        });
      }

      // Refused before anything is stored. A save that was going to fail used to
      // move its pictures into board_images first and leave them there with
      // nothing using them (found in review, 15 Sep 2026). So a picture nobody
      // could move out is refused now, and the board is measured as it will be
      // stored, each inline picture counted at the length of the link that
      // will replace it.
      const unkeepable = findInlineDataUrls(snapshot, 1000)
        .some(p => !(MOVABLE_PICTURE.test(p.path) && parseDataUrl(p.value) !== null));
      if (unkeepable) {
        return res.status(422).json({
          error: 'This board has a picture a template cannot keep — only PNG, JPEG, WebP or GIF pictures under 6MB. Remove it and save again.',
          code: 'inline_picture',
        });
      }
      const PICTURE_LINK = '/api/board-image/00000000000000000000000000000000';
      const expected = Buffer.byteLength(
        JSON.stringify(snapshot, (_key, v) => (typeof v === 'string' && INLINE_DATA_URL.test(v) ? PICTURE_LINK : v)),
        'utf8',
      );
      if (expected > MAX_TEMPLATE_BYTES) {
        return res.status(413).json({
          error: 'That board is too large to save as a template (2MB limit). Clearing some ink usually brings it under.',
        });
      }

      // Pictures out, then measure what is actually going to be stored.
      const picturesMoved = await externaliseBoardImages(pool, snapshot);
      const inline = findInlineDataUrls(snapshot);
      if (inline.length > 0) {
        // externaliseBoardImages leaves a picture in place when it cannot store
        // it — right for a live board, where the alternative is a hole in it.
        // Here the alternative is keeping it inline in this table, which is the
        // one thing the table must never do. So refuse, and say whose problem
        // it is: a picture we could have stored means try again; one we never
        // could means take it off the board.
        const ours = inline.some(p => MOVABLE_PICTURE.test(p.path) && parseDataUrl(p.value) !== null);
        if (ours) {
          return res.status(503).json({ error: 'Could not store the pictures on this board just now. Try again in a minute.' });
        }
        return res.status(422).json({
          error: 'This board has a picture a template cannot keep — only PNG, JPEG, WebP or GIF pictures under 6MB. Remove it and save again.',
          code: 'inline_picture',
        });
      }

      const json = JSON.stringify(snapshot);
      const bytes = Buffer.byteLength(json, 'utf8');
      if (bytes > MAX_TEMPLATE_BYTES) {
        return res.status(413).json({
          error: 'That board is too large to save as a template (2MB limit). Clearing some ink usually brings it under.',
        });
      }
      const name = templateName(body.name);
      const savedAt = savedAtFrom(body.savedAt);

      let row: Record<string, unknown> | null = null;
      if (wanted !== null) {
        const r = await pool.query(
          `INSERT INTO board_templates (id, owner_user_id, workspace_id, name, snapshot, bytes, saved_at)
                VALUES ($1, $2, (SELECT default_workspace_id FROM users WHERE id = $2), $3, $4::jsonb, $5, $6)
           ON CONFLICT (owner_user_id, id)
           DO UPDATE SET name = EXCLUDED.name, snapshot = EXCLUDED.snapshot,
                         bytes = EXCLUDED.bytes, saved_at = EXCLUDED.saved_at
             RETURNING id, name, bytes, saved_at`,
          [wanted, user.id, name, json, bytes, savedAt],
        );
        row = r.rows[0] ?? null;
      } else {
        // A fresh id must never land on one of this teacher's own: a collision
        // means "draw another", not "replace that template".
        for (let attempt = 0; attempt < 5 && !row; attempt++) {
          const r = await pool.query(
            `INSERT INTO board_templates (id, owner_user_id, workspace_id, name, snapshot, bytes, saved_at)
                  VALUES ($1, $2, (SELECT default_workspace_id FROM users WHERE id = $2), $3, $4::jsonb, $5, $6)
             ON CONFLICT (owner_user_id, id) DO NOTHING
               RETURNING id, name, bytes, saved_at`,
            [newTemplateId(), user.id, name, json, bytes, savedAt],
          );
          row = r.rows[0] ?? null;
        }
      }
      if (!row) return res.status(503).json({ error: 'Could not save that template. Try again.' });
      res.json({ template: row, picturesMoved });
    } catch (err) {
      console.error('Could not save board template:', (err as Error).message);
      res.status(500).json({ error: 'Could not save that template.' });
    }
  }, bodyRefused);

  app.delete('/api/templates/:id', async (req: Request, res: Response) => {
    const user = who(req);
    if (!user) return res.status(401).json({ error: 'Sign in to change the templates in your account.' });
    const id = String(req.params.id || '');
    if (!isTemplateId(id)) return res.json({ ok: true, deleted: 0 });
    try {
      const r = await pool.query(
        'DELETE FROM board_templates WHERE owner_user_id = $1 AND id = $2',
        [user.id, id],
      );
      res.json({ ok: true, deleted: r.rowCount ?? 0 });
    } catch (err) {
      console.error('Could not delete board template:', (err as Error).message);
      res.status(500).json({ error: 'Could not delete that template.' });
    }
  });
}
