-- 0002 — who someone is, what they own, and a record of what an admin did.
--
-- PLAN.md tasks 2.1 and 2.3. Everything here is ADDITIVE and nothing reads it
-- yet: the columns and tables land first so the code that uses them can go out
-- in small pieces, and so this migration can be applied to production long
-- before any behaviour changes.
--
-- Two backfills at the end. Both are convergent — running them a second time
-- changes nothing, because their WHERE clauses no longer match — which is the
-- rule for every UPDATE in this directory, since there are no down-migrations.

-- ── Who someone is ─────────────────────────────────────────────────────────
-- `role` is deliberately a column and not a second table: platform_admins made
-- granting admin a visible, deliberate INSERT, and that was right when admin
-- was the only thing to be. With staff permissions and suspension arriving,
-- one row per person is the shape that answers "what may this person do".
ALTER TABLE users ADD COLUMN IF NOT EXISTS role        text    NOT NULL DEFAULT 'teacher';
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions text[]  NOT NULL DEFAULT '{}';

-- Suspension keeps the data and refuses the door. Deletion is a separate,
-- audited, two-step action and is not this.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status        text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_reason text;

-- Bumped by "sign out everywhere" and by suspension. The session cookie
-- carries it, so a stolen cookie stops working the moment this moves — today
-- a signed cookie is good for thirty days whatever happens to the account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 0;

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale       text NOT NULL DEFAULT 'en';
-- Per-teacher, because the daily mail currently decides "today" in IST for
-- everyone (src/server/mailer.ts says so). Defaulted to the value that is
-- already true rather than to UTC, so nothing changes for anyone today.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone     text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country      char(2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_workspace_id text;

-- ── What they own ──────────────────────────────────────────────────────────
-- Every teacher gets a personal workspace, not only the ones who will ever
-- have a team. One shape means every later query is written once; a schema
-- where half the rows hang off a user and half off a workspace is a schema
-- where every join has an exception.
CREATE TABLE IF NOT EXISTS workspaces (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  kind           text NOT NULL DEFAULT 'personal',   -- personal | team
  owner_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject        text,                               -- from the first-run question
  brand_name     text,
  brand_color    text,
  learner_footer boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_user_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member',       -- owner | admin | member
  seat_active  boolean NOT NULL DEFAULT true,
  invited_by   text,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

-- Owning columns on the things that will move into a workspace. Nullable and
-- unread for now; the code keeps using teacher_id until a later migration can
-- make them NOT NULL with confidence.
ALTER TABLE classes           ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS workspace_id text;

-- ── A record of what an admin did ──────────────────────────────────────────
-- There is none today. `payment_claims.confirmed_by` is the only trace of an
-- admin action anywhere, and /api/admin/grant — which hands out paid time —
-- records nothing at all about who granted it or why.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              bigserial PRIMARY KEY,
  actor_user_id   text,                    -- null for the system (a webhook, a job)
  acting_as_user_id text,                  -- set while impersonating
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  before          jsonb,
  after           jsonb,
  reason          text,
  ip              text,
  user_agent      text,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx  ON admin_audit_log (actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit_log (target_type, target_id, at DESC);

-- ── Backfills ──────────────────────────────────────────────────────────────
-- The existing admins keep being admins. platform_admins stays as it is and
-- stays authoritative for one more release: authz.ts reads BOTH, so this
-- migration can land in production without changing who can do anything.
UPDATE users SET role = 'super_admin'
 WHERE role = 'teacher'
   AND EXISTS (SELECT 1 FROM platform_admins p WHERE p.email = users.email);

-- One personal workspace per existing teacher, with a deterministic id so a
-- second run inserts nothing.
INSERT INTO workspaces (id, name, kind, owner_user_id)
SELECT 'ws_' || u.id, COALESCE(u.display_name, split_part(u.email, '@', 1)), 'personal', u.id
  FROM users u
 ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT 'ws_' || u.id, u.id, 'owner' FROM users u
 ON CONFLICT (workspace_id, user_id) DO NOTHING;

UPDATE users SET default_workspace_id = 'ws_' || id
 WHERE default_workspace_id IS NULL;

UPDATE classes c SET workspace_id = 'ws_' || c.teacher_id
 WHERE c.workspace_id IS NULL;

UPDATE teaching_sessions s SET workspace_id = 'ws_' || s.teacher_id
 WHERE s.workspace_id IS NULL;
