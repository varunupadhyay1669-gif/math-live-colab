// One-off: move whiteboard pictures out of the rooms that already exist.
//
// The server converts a board when it is opened, but converting requires
// loading the room once — and the room that caused this (128MB compressed, 150
// pasted images) is precisely the one that cannot be loaded inside the server's
// heap. So it is done here instead, in a short-lived process that can be given
// as much room as it needs, one room at a time, largest last.
//
//   sudo -u mathslive node --max-old-space-size=1200 scripts/migrate-board-images.mjs
//
// Safe to run more than once: a board whose pictures are already URLs is
// skipped. Nothing is deleted; a room is only written back when it got smaller.
import pg from 'pg';
import { externaliseBoardImages } from '../src/server/boardImages.ts';

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const pool = new Pool({ connectionString: url, max: 2 });
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

// Smallest first: if something is going to go wrong, it should go wrong on the
// cheap room while the process is fresh, not on the 128MB one.
const list = await pool.query(
  `SELECT room_id, pg_column_size(data) AS bytes
     FROM rooms ORDER BY pg_column_size(data) ASC`,
);
console.log(`${list.rowCount} room(s) to check\n`);

let totalMoved = 0;
for (const { room_id, bytes } of list.rows) {
  const before = Number(bytes);
  process.stdout.write(`${room_id}  ${mb(before).padStart(8)}  `);
  try {
    const r = await pool.query('SELECT data FROM rooms WHERE room_id = $1', [room_id]);
    if (r.rowCount === 0) { console.log('gone'); continue; }
    const data = r.rows[0].data;

    const moved = await externaliseBoardImages(pool, data?.whiteboard);
    if (moved === 0) { console.log('nothing to move'); continue; }

    await pool.query('UPDATE rooms SET data = $2::jsonb WHERE room_id = $1',
      [room_id, JSON.stringify(data)]);
    const after = await pool.query(
      'SELECT pg_column_size(data) AS bytes FROM rooms WHERE room_id = $1', [room_id]);
    totalMoved += moved;
    console.log(`moved ${moved} image(s) -> ${mb(Number(after.rows[0].bytes))}`);
  } catch (err) {
    // Never let one bad room stop the rest. The room is untouched on failure.
    console.log(`FAILED: ${err.message}`);
  }
  // Let the previous room's memory go before picking up the next one.
  if (global.gc) global.gc();
}

const stored = await pool.query(
  'SELECT count(*)::int AS n, COALESCE(sum(length(bytes)), 0)::bigint AS b FROM board_images');
console.log(`\nmoved ${totalMoved} image(s); board_images now holds ` +
  `${stored.rows[0].n} picture(s), ${mb(Number(stored.rows[0].b))}`);
await pool.end();
