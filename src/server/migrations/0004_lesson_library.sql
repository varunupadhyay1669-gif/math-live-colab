-- A home for lessons that is not a room.
--
-- Found on 9 Sep 2026, while looking at the "clear class data" button built
-- three days earlier: 33 lesson files were living inside 31 rooms, and the
-- lesson library is browser localStorage (SimulationLibrary.tsx). So the
-- database's only copy of "12_times_table_adventure", "Victor's Fact Vault"
-- and thirty-one others was inside the very rows that button deletes. Pressing
-- it would have destroyed a term of work, and the founder had asked for exactly
-- that delete.
--
-- Two problems, one table. Lessons stop dying with the room that happened to
-- run them, and they stop being trapped in one browser — a lesson written on
-- the laptop has never been openable on the iPad, which is PLAN.md task 2.4.

CREATE TABLE IF NOT EXISTS lessons (
  id          text PRIMARY KEY,
  teacher_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  html        text NOT NULL,
  -- md5 of the html. The same lesson was run in five different rooms; without
  -- this the rescue below would file five copies of it.
  content_key text NOT NULL,
  topic       text,
  -- Where it came from, kept because a rescued lesson has no other provenance
  -- and somebody will one day ask why it is in their library.
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, content_key)
);

CREATE INDEX IF NOT EXISTS lessons_teacher_idx ON lessons (teacher_id, updated_at DESC);

-- ── The rescue ────────────────────────────────────────────────────────────
--
-- Ownership comes from `classes`, joined on room_code. Fourteen of the files
-- are in rooms with no class — anonymous quick-deploy rooms (ids like
-- a2b904ea) and rooms whose class was deleted. Those are attributed to the
-- platform owner rather than dropped: they are lessons somebody built, the
-- alternative is deleting them, and `source` records that the attribution was
-- a guess rather than a fact.
--
-- Runs once. A second run inserts nothing, because ON CONFLICT matches on the
-- content key.
WITH fallback_owner AS (
  SELECT u.id
    FROM users u
    JOIN platform_admins a ON lower(a.email) = lower(u.email)
   ORDER BY u.created_at
   LIMIT 1
),
found AS (
  SELECT DISTINCT ON (owner_id, md5(html))
         owner_id,
         html,
         name,
         room_id,
         attributed
    FROM (
      SELECT COALESCE(c.teacher_id, (SELECT id FROM fallback_owner)) AS owner_id,
             f->>'html'                                              AS html,
             COALESCE(NULLIF(trim(f->>'name'), ''), 'Untitled lesson') AS name,
             r.room_id                                                AS room_id,
             (c.teacher_id IS NOT NULL)                               AS attributed
        FROM rooms r
        JOIN LATERAL jsonb_array_elements(r.data->'files') f ON true
        LEFT JOIN classes c ON c.room_code = r.room_id
       WHERE jsonb_typeof(r.data->'files') = 'array'
    ) x
   WHERE owner_id IS NOT NULL
     AND html IS NOT NULL
     AND length(html) > 0
   ORDER BY owner_id, md5(html), length(html) DESC
)
INSERT INTO lessons (id, teacher_id, name, html, content_key, source)
SELECT 'les-' || substr(md5(owner_id || md5(html)), 1, 16),
       owner_id,
       name,
       html,
       md5(html),
       CASE WHEN attributed
            THEN 'rescued from room ' || room_id
            ELSE 'rescued from room ' || room_id || ' (owner unknown — attributed to the platform owner)'
       END
  FROM found
ON CONFLICT (teacher_id, content_key) DO NOTHING;
