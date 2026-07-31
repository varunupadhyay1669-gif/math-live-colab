-- Student profile fields — run once in Supabase → SQL Editor.
--
-- Adds the things a tutor holds in their head between lessons to the row that
-- already represents one student. Safe to run more than once, and safe to run
-- while the app is live: every column is nullable with no default, so existing
-- rows are untouched and nothing is rewritten.
--
-- The app works before this is applied — the profile fields simply read empty
-- and saving them reports that the migration is still needed. Nothing else on
-- the dashboard depends on it.

alter table public.classes add column if not exists grade  text;
alter table public.classes add column if not exists level  text;
alter table public.classes add column if not exists goals  text;  -- one goal per line
alter table public.classes add column if not exists avatar text;  -- a single emoji

comment on column public.classes.grade  is 'Free text — "Year 8", "Grade 6", "Class 9 ICSE".';
comment on column public.classes.level  is 'Free text — the tutor''s own words: "Higher", "Foundation", "Olympiad prep".';
comment on column public.classes.goals  is 'What this student is working towards; one goal per line.';
comment on column public.classes.avatar is 'A single emoji. Blank falls back to initials on a derived colour.';

-- No RLS change needed: the existing "classes owned by teacher" policy is
-- table-wide (for all using auth.uid() = teacher_id), so the new columns are
-- covered by it automatically.
