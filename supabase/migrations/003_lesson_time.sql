-- Real teaching time — run once in Supabase → SQL Editor.
--
-- Until now "hours taught" could only be guessed from started_at..ended_at,
-- which is the span between the first and last SAVE of a lesson, not the
-- lesson. A tutor who saved twice in the first five minutes and never again
-- looked like a five-minute lesson.
--
-- This column holds seconds counted only while a teacher AND at least one
-- student were both in the room — the app accumulates it live and writes it
-- with the lesson. Nullable with no default, so existing rows read as
-- "unknown" rather than as zero-hour lessons, which would drag every average
-- down and look like a collapse in usage.

alter table public.sessions add column if not exists taught_seconds integer;

comment on column public.sessions.taught_seconds is
  'Seconds with a teacher and >=1 student both present. Null on rows saved before this existed — unknown, not zero.';
