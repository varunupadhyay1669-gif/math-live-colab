-- 0003 — free forever, and the note beside it.
--
-- PLAN.md task 2.2. From the founder's brief: "I and anyone I hand-pick get
-- full access free forever." Today the only way to do that is to be in
-- platform_admins — which also hands over every other teacher's data — or to
-- keep pushing paid_until forward by hand, which is what was done for Vani on
-- 2 Sep as a stopgap and is what this replaces.
--
-- A grant is a ROW, not a flag, for the same reason platform_admins was a table
-- rather than a boolean: giving somebody the product for nothing should be a
-- deliberate, visible, dated act with a reason attached and a way to take it
-- back. A flag records the state and forgets the decision.

CREATE TABLE IF NOT EXISTS plan_grants (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code     text NOT NULL DEFAULT 'pro',
  -- NULL means forever. The whole point of the table.
  until         timestamptz,
  reason        text,
  granted_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    text,
  revoked_reason text
);

-- The lookup on the hot path: "does this teacher have a live grant?" is asked
-- every time somebody takes a teacher seat, so it must not be a table scan.
CREATE INDEX IF NOT EXISTS plan_grants_live_idx
    ON plan_grants (user_id)
 WHERE revoked_at IS NULL;

-- Support history. Not the audit log: that records what was DONE, this records
-- what was understood. Both are worth having and neither substitutes.
CREATE TABLE IF NOT EXISTS admin_notes (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note       text NOT NULL,
  author_id  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_notes_user_idx ON admin_notes (user_id, created_at DESC);

-- Vani's stopgap becomes the real thing.
--
-- On 2 Sep her paid_until was pushed twelve months out by hand, so she would
-- not be locked out on the 7th while the grant table did not exist. This turns
-- that into a grant with no end and a reason, which is what it always was.
-- Convergent: the WHERE clause stops matching once the row exists.
INSERT INTO plan_grants (id, user_id, plan_code, until, reason, granted_by)
SELECT 'grant_vani_2026_09', u.id, 'pro', NULL,
       'Founder''s partner and the only other regular teacher. Replaces the manual paid_until bridge of 2 Sep 2026.',
       'migration:0003'
  FROM users u
 WHERE u.email = 'vaaniadvait@gmail.com'
 ON CONFLICT (id) DO NOTHING;
