-- 0001 — the indexes the owner's own dashboard has been missing.
--
-- The first migration is a real one rather than an empty marker, because a
-- mechanism nobody has watched work is a mechanism nobody should trust with
-- Phase 2's schema.
--
-- GET /api/admin/tutors (src/server/records.ts) runs FIVE correlated
-- subqueries against teaching_sessions per teacher — count all, count 30 days,
-- count 7 days, max(started_at), sum(taught_seconds) — each filtering on
-- teacher_id. The only index on that table is (class_id, started_at DESC),
-- created in identity.ts, which none of those five can use. So every load of
-- the Tutors tab is five sequential scans per teacher, on the same 1 GB box
-- that is serving lessons.
--
-- It is invisible today at 138 rows and would not stay invisible: the same
-- page is the one the owner opens most, and the table grows with every lesson
-- ever taught.
--
-- CREATE INDEX (not CONCURRENTLY) is deliberate. CONCURRENTLY cannot run
-- inside a transaction, and the runner puts every migration in one so that a
-- failure leaves nothing behind. On tables this size the lock is measured in
-- milliseconds; when a table here is big enough for that to matter, the
-- migration that touches it should say so and be run by hand at a quiet hour.

CREATE INDEX IF NOT EXISTS teaching_sessions_teacher_idx
    ON teaching_sessions (teacher_id, started_at DESC);

-- The admin claims list and the billing status page both look up a teacher's
-- claims by teacher_id; the only index on payment_claims is the partial one on
-- open claims by date (billing.ts).
CREATE INDEX IF NOT EXISTS payment_claims_teacher_idx
    ON payment_claims (teacher_id, claimed_at DESC);
