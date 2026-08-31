// Move the teacher records out of Supabase and into this server's Postgres.
//
//   9 users · 138 classes · 131 saved sessions
//   sessions carry 517MB of whiteboard snapshots, which is the same base64-image
//   problem the rooms had — and almost certainly why the Supabase org is over
//   its 500MB quota and due to be restricted on 19 September.
//
// Run it on the box that has the destination database:
//
//   SUPABASE_DB_URL='postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres' \
//     node --import tsx scripts/migrate-from-supabase.mjs
//
// The connection string is only ever read from the environment, so the password
// stays in the shell that ran it.
//
// Three properties this needs and has:
//
//   RESUMABLE.  Every insert is ON CONFLICT DO NOTHING, so running it twice
//               changes nothing the second time. A migration that cannot be
//               retried is one you dare not start.
//   STREAMING.  Sessions are fetched ONE AT A TIME. Together they are half a
//               gigabyte, and the destination box has 1GB of RAM for
//               everything; pulling them as a set would kill it, which is
//               exactly the failure this whole exercise has been about.
//   SHRINKING.  Whiteboard images inside each snapshot are moved into
//               board_images on the way through, and deduplicated by content.
//               In the rooms this collapsed 1612 references to 33 pictures.
import pg from 'pg';
import { externaliseBoardImages } from '../src/server/boardImages.ts';

const { Pool } = pg;
const SRC = process.env.SUPABASE_DB_URL;
const DST = process.env.DATABASE_URL;
if (!SRC) { console.error('SUPABASE_DB_URL is not set.'); process.exit(1); }
if (!DST) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const src = new Pool({ connectionString: SRC, max: 2, ssl: { rejectUnauthorized: false } });
const dst = new Pool({ connectionString: DST, max: 2 });
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

let imagesMoved = 0;

// ── 1. Teachers ────────────────────────────────────────────────────────────
// The Supabase uuid is kept as the id, so classes and sessions keep pointing at
// the right person with no mapping table to get wrong.
const users = await src.query(
  `SELECT id::text, email, created_at, last_sign_in_at
     FROM auth.users WHERE email IS NOT NULL`);
for (const u of users.rows) {
  await dst.query(
    `INSERT INTO users (id, email, created_at, last_login_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
    [u.id, u.email, u.created_at, u.last_sign_in_at]);
}
console.log(`teachers   ${users.rowCount}`);

// ── 2. Classes ─────────────────────────────────────────────────────────────
// The student roster and their permanent room codes: the piece that would hurt
// most to lose, and the smallest to move.
const classes = await src.query(
  `SELECT id::text, teacher_id::text, student_name, label, room_code, created_at,
          last_opened_at, grade, level, goals, avatar, textbook
     FROM classes ORDER BY created_at`);
let classesIn = 0;
for (const c of classes.rows) {
  const r = await dst.query(
    `INSERT INTO classes (id, teacher_id, student_name, label, room_code, created_at,
                          last_opened_at, grade, level, goals, avatar, textbook)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO NOTHING`,
    [c.id, c.teacher_id, c.student_name, c.label, c.room_code, c.created_at,
     c.last_opened_at, c.grade, c.level, c.goals, c.avatar, c.textbook]);
  classesIn += r.rowCount;
}
console.log(`classes    ${classesIn} of ${classes.rowCount}`);

// ── 3. Sessions, one at a time ─────────────────────────────────────────────
// Ids first (cheap), then each row on its own. Never more than one snapshot in
// memory at once.
const ids = await src.query('SELECT id::text FROM sessions ORDER BY started_at');
console.log(`sessions   ${ids.rowCount} to move (one at a time)`);

let done = 0, failed = 0, bytesSeen = 0;
for (const { id } of ids.rows) {
  try {
    const r = await src.query(
      `SELECT id::text, class_id::text, teacher_id::text, started_at, ended_at,
              topic, notes, whiteboard_snapshot, html_used, taught_seconds
         FROM sessions WHERE id = $1`, [id]);
    if (r.rowCount === 0) continue;
    const s = r.rows[0];

    // The snapshot is where the half-gigabyte lives. Move its pictures out
    // BEFORE writing, so the destination never stores them inline.
    if (s.whiteboard_snapshot) {
      bytesSeen += JSON.stringify(s.whiteboard_snapshot).length;
      imagesMoved += await externaliseBoardImages(dst, s.whiteboard_snapshot);
    }

    await dst.query(
      `INSERT INTO teaching_sessions
         (id, class_id, teacher_id, started_at, ended_at, topic, notes,
          whiteboard_snapshot, html_used, taught_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.class_id, s.teacher_id, s.started_at, s.ended_at, s.topic, s.notes,
       s.whiteboard_snapshot ? JSON.stringify(s.whiteboard_snapshot) : null,
       s.html_used, s.taught_seconds]);
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${ids.rowCount}  (${mb(bytesSeen)} read, ${imagesMoved} images moved)`);
  } catch (err) {
    // One unmovable lesson must not cost the other 130.
    failed++;
    console.log(`  session ${id}: ${err.message}`);
  }
  if (global.gc) global.gc();
}

const after = await dst.query(`
  SELECT (SELECT count(*) FROM users)             AS users,
         (SELECT count(*) FROM classes)           AS classes,
         (SELECT count(*) FROM teaching_sessions) AS sessions,
         (SELECT count(*) FROM board_images)      AS pictures,
         (SELECT COALESCE(sum(length(bytes)),0) FROM board_images)::bigint AS picture_bytes`);
const a = after.rows[0];
console.log(`\nmoved ${done} session(s), ${failed} failed`);
console.log(`read ${mb(bytesSeen)} of snapshots; ${imagesMoved} image(s) externalised`);
console.log(`destination now: ${a.users} teachers, ${a.classes} classes, ` +
  `${a.sessions} sessions, ${a.pictures} pictures (${mb(Number(a.picture_bytes))})`);

await src.end();
await dst.end();
