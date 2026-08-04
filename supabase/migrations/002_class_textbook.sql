-- The book the class works from — run once in Supabase → SQL Editor.
--
-- One line of free text per student: "NCERT Class 9 Maths", "Cambridge IGCSE
-- Extended (4th ed)", "Mixed — my own sheets". It goes into the class pack, so
-- a model asked to write the next worksheet matches the book the student
-- actually has in front of them instead of inventing a curriculum.
--
-- Same shape as 001: nullable, no default, safe to re-run, safe while live.
-- The app works before this is applied — the field reads empty, saving it
-- reports that the migration is still needed, and the pack records null rather
-- than guessing.

alter table public.classes add column if not exists textbook text;

comment on column public.classes.textbook is
  'Free text — the book or course this student follows. Written into the class pack.';

-- No RLS change needed: the existing "classes owned by teacher" policy is
-- table-wide, so the new column is covered by it automatically.
