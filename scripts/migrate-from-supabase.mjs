// Move the teacher records out of Supabase and into this server's Postgres.
//
//   9 users · 138 classes · 131 saved sessions
//   sessions carry 517MB of whiteboard snapshots, which is the same base64-image
//   problem the rooms had — and almost certainly why the Supabase org is over
//   its 500MB quota and due to be restricted on 19 September.
//
// ── Which credential to give it ────────────────────────────────────────────
//
// Either one works. Both are read from the environment ONLY, so the secret
// stays in the shell that ran the command and is never written down here.
//
//   A. SUPABASE_SERVICE_ROLE_KEY  (easiest — a copy-paste, nothing is changed)
//        Supabase → Project Settings → API keys → service_role → Reveal.
//        Also set SUPABASE_URL, e.g. https://<ref>.supabase.co
//
//   B. SUPABASE_DB_URL            (faster for the 517MB, needs the DB password)
//        Supabase → Project Settings → Database → Connection string.
//        If the password is unknown it must be reset there first. That is safe
//        now: nothing in this app connects to Supabase any more.
//        Prefer the "Session pooler" string if the direct one will not resolve —
//        direct db.<ref>.supabase.co is IPv6-only on newer projects.
//
//   node --import tsx scripts/migrate-from-supabase.mjs
//
// ── Three properties this needs and has ────────────────────────────────────
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
const DB_URL   = process.env.SUPABASE_DB_URL;
const REST_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const REST_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DST      = process.env.DATABASE_URL;

if (!DST) { console.error('DATABASE_URL is not set (the destination).'); process.exit(1); }
if (!DB_URL && !(REST_URL && REST_KEY)) {
  console.error([
    'Nothing to read from. Set ONE of:',
    '',
    '  SUPABASE_SERVICE_ROLE_KEY (+ SUPABASE_URL)',
    '      Supabase -> Project Settings -> API keys -> service_role -> Reveal.',
    '      Nothing is changed by copying it.',
    '',
    '  SUPABASE_DB_URL',
    '      Supabase -> Project Settings -> Database -> Connection string.',
    '      Needs the database password; reset it there if unknown.',
  ].join('\n'));
  process.exit(1);
}

// ── Source adapters ────────────────────────────────────────────────────────
// Two ways in, one shape out, so the migration below does not care which
// credential was supplied.

function makeRestSource() {
  const headers = { apikey: REST_KEY, Authorization: 'Bearer ' + REST_KEY };
  const get = async (path) => {
    const res = await fetch(REST_URL + path, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path.split('?')[0]}`);
    return res.json();
  };
  return {
    kind: 'REST API (service_role)',
    async users() {
      // auth.users is not a REST table; the admin endpoint is how it is read.
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const body = await get(`/auth/v1/admin/users?page=${page}&per_page=200`);
        const batch = body.users || [];
        out.push(...batch.map(u => ({
          id: u.id, email: u.email,
          created_at: u.created_at, last_sign_in_at: u.last_sign_in_at,
        })));
        if (batch.length < 200) break;
      }
      return out.filter(u => u.email);
    },
    classes: () => get('/rest/v1/classes?select=*&order=created_at&limit=5000'),
    sessionIds: async () =>
      (await get('/rest/v1/sessions?select=id&order=started_at&limit=5000')).map(r => r.id),
    session: async (id) =>
      (await get(`/rest/v1/sessions?select=*&id=eq.${encodeURIComponent(id)}`))[0] || null,
    close: async () => {},
  };
}

function makePgSource() {
  const src = new Pool({ connectionString: DB_URL, max: 2, ssl: { rejectUnauthorized: false } });
  return {
    kind: 'direct Postgres',
    users: async () => (await src.query(
      `SELECT id::text, email, created_at, last_sign_in_at
         FROM auth.users WHERE email IS NOT NULL`)).rows,
    classes: async () => (await src.query(
      `SELECT id::text, teacher_id::text, student_name, label, room_code, created_at,
              last_opened_at, grade, level, goals, avatar, textbook
         FROM classes ORDER BY created_at`)).rows,
    sessionIds: async () =>
      (await src.query('SELECT id::text FROM sessions ORDER BY started_at')).rows.map(r => r.id),
    session: async (id) => (await src.query(
      `SELECT id::text, class_id::text, teacher_id::text, started_at, ended_at,
              topic, notes, whiteboard_snapshot, html_used, taught_seconds
         FROM sessions WHERE id = $1`, [id])).rows[0] || null,
    close: () => src.end(),
  };
}

const source = DB_URL ? makePgSource() : makeRestSource();
const dst = new Pool({ connectionString: DST, max: 2 });
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
console.log(`reading via ${source.kind}\n`);

let imagesMoved = 0;

// ── 1. Teachers ────────────────────────────────────────────────────────────
// The Supabase uuid is kept as the id, so classes and sessions keep pointing at
// the right person with no mapping table to get wrong.
const users = await source.users();
for (const u of users) {
  await dst.query(
    `INSERT INTO users (id, email, created_at, last_login_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
    [u.id, u.email, u.created_at, u.last_sign_in_at]);
}
console.log(`teachers   ${users.length}`);

// ── 2. Classes ─────────────────────────────────────────────────────────────
// The student roster and their permanent room codes: the piece that would hurt
// most to lose, and the smallest to move.
const classes = await source.classes();
let classesIn = 0;
for (const c of classes) {
  const r = await dst.query(
    `INSERT INTO classes (id, teacher_id, student_name, label, room_code, created_at,
                          last_opened_at, grade, level, goals, avatar, textbook)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO NOTHING`,
    [c.id, c.teacher_id, c.student_name, c.label, c.room_code, c.created_at,
     c.last_opened_at, c.grade, c.level, c.goals, c.avatar, c.textbook]);
  classesIn += r.rowCount;
}
console.log(`classes    ${classesIn} of ${classes.length}`);

// ── 3. Sessions, one at a time ─────────────────────────────────────────────
// Ids first (cheap), then each row on its own. Never more than one snapshot in
// memory at once.
const ids = await source.sessionIds();
console.log(`sessions   ${ids.length} to move (one at a time)`);

let done = 0, failed = 0, bytesSeen = 0;
for (const id of ids) {
  try {
    const s = await source.session(id);
    if (!s) continue;

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
    if (done % 10 === 0) {
      console.log(`  ${done}/${ids.length}  (${mb(bytesSeen)} read, ${imagesMoved} images moved)`);
    }
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

await source.close();
await dst.end();
