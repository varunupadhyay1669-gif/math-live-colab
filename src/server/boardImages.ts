// Whiteboard images live beside the room, not inside it.
//
// They used to be stored as data: URLs on the whiteboard objects, which are
// part of the room document. That made a room as big as every picture ever
// pasted into it — one measured 128 MB compressed, with 150 images and no
// lesson files at all. Opening it took the server's heap from 78 MB to 454 MB
// and killed the process, every two to four minutes, all day.
//
// The room now stores a short URL per image and nothing else. What that fixes:
//
//   * The in-memory room is small, so opening a class costs kilobytes.
//   * The persisted room is small, so saving does not write 128 MB repeatedly.
//   * The browser fetches each picture once and caches it forever, instead of
//     receiving all of them inside every room payload.
//
// The id IS the content hash, which makes the same photo pasted twice one row,
// and makes every URL immutable — so it can be cached hard and never revalidated.
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { userFromRequest } from './identity';

export const BOARD_IMAGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS board_images (
    id         text PRIMARY KEY,          -- sha256 of the bytes: same picture, one row
    mime       text NOT NULL,
    bytes      bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

/** 6MB of decoded image. The client downscales long before this; it is a floor
 *  under a bug, not a working limit. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED = /^image\/(png|jpeg|webp|gif)$/;

export interface StoredImage { url: string; }

/** Parse a data: URL into bytes. Returns null for anything unexpected. */
export function parseDataUrl(src: unknown): { mime: string; buf: Buffer } | null {
  if (typeof src !== 'string' || src.length < 32) return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i.exec(src);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED.test(mime)) return null;
  let buf: Buffer;
  try { buf = Buffer.from(src.slice(m[0].length), 'base64'); } catch { return null; }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  return { mime, buf };
}

/** Store bytes (deduplicated by content) and return the URL to reach them. */
export async function putImage(pool: Pool, mime: string, buf: Buffer): Promise<string> {
  const id = createHash('sha256').update(buf).digest('hex').slice(0, 32);
  await pool.query(
    `INSERT INTO board_images (id, mime, bytes) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, mime, buf],
  );
  return `/api/board-image/${id}`;
}

/**
 * Replace every data: URL on a whiteboard with a stored URL, in place.
 *
 * Returns how many were moved out, so the caller can say so. Anything that is
 * already a URL, or is not an image, is left exactly as it is — this must be
 * safe to run repeatedly over the same board.
 */
export async function externaliseBoardImages(pool: Pool, whiteboard: any): Promise<number> {
  const objects = whiteboard && Array.isArray(whiteboard.objects) ? whiteboard.objects : null;
  if (!objects) return 0;
  let moved = 0;
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    const parsed = parseDataUrl(obj.src);
    if (!parsed) continue;
    try {
      obj.src = await putImage(pool, parsed.mime, parsed.buf);
      moved++;
    } catch (err) {
      // Leave the data URL in place rather than losing the picture. A board
      // that is merely large still beats a board with a hole in it.
      console.error('Could not externalise a board image:', (err as Error).message);
    }
  }
  return moved;
}

export function mountBoardImageRoutes(app: any, pool: Pool, opts: { secret: string }) {
  // Upload one image, get back its URL. The client calls this before putting
  // the object on the board, so a data URL never reaches the room at all.
  //
  // SIGNED IN, since PLAN.md task 0.3. This route used to accept 6 MB from
  // anyone who could reach the server and write it to Postgres for ever, with
  // no account, no room membership and no way to attribute it — the cheapest
  // way there was to fill the disk of the box that also holds every lesson.
  //
  // The refusal is deliberately soft on the client: `Whiteboard.uploadImage`
  // keeps its data-URL fallback, so a picture pasted in an anonymous demo room
  // still appears on the board. It lands inside the room document instead of
  // the image store, which is the size problem that closed in August — but
  // that path is bounded (a demo room lives 30 minutes) and the conversion
  // runs anyway the next time the room is opened (`externaliseBoardImages`).
  // Losing a tutor's photo to a security fix would be the worse trade.
  app.post('/api/board-image', async (req: Request, res: Response) => {
    if (!userFromRequest(req, opts.secret)) {
      return res.status(401).json({
        error: 'Sign in to add pictures to the board.',
        code: 'sign_in_required',
      });
    }
    const parsed = parseDataUrl((req.body as any)?.src);
    if (!parsed) return res.status(400).json({ error: 'Not a supported image.' });
    try {
      res.json({ url: await putImage(pool, parsed.mime, parsed.buf) });
    } catch (err) {
      console.error('board-image upload failed:', (err as Error).message);
      res.status(500).json({ error: 'Could not store the image.' });
    }
  });

  app.get('/api/board-image/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    if (!/^[0-9a-f]{32}$/.test(id)) return res.status(400).end();
    try {
      const r = await pool.query('SELECT mime, bytes FROM board_images WHERE id = $1', [id]);
      if (r.rowCount === 0) return res.status(404).end();
      // The id is the content hash, so this bytes-for-bytes can never change.
      // Immutable caching means a student loads each picture once per device,
      // however many times the board is reopened.
      res.set('Content-Type', r.rows[0].mime);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(r.rows[0].bytes);
    } catch (err) {
      console.error('board-image read failed:', (err as Error).message);
      res.status(500).end();
    }
  });
}
