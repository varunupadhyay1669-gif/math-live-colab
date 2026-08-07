-- MathsLive Admin — run once in Supabase → SQL Editor.
--
-- ⚠️  EDIT THE EMAIL IN STEP 2 BEFORE RUNNING. Nothing else needs changing.
--
-- The admin page shows every tutor's usage, which no tutor may see. The gate
-- for that is HERE, in the database, not in the browser: a page that merely
-- hides a button is not access control — anyone can call the same API the page
-- calls.
--
-- Deliberately no service-role key anywhere. That key bypasses row-level
-- security entirely, and putting one in the app or the server would mean a
-- single leak exposes every tutor's students. Instead these functions run
-- `security definer` — with the privileges of their owner — and refuse to
-- return anything unless the caller is a listed admin.


-- ── 1. Who the admins are ────────────────────────────────────────────
-- No RLS policies are created for this table, and RLS is on. In Postgres that
-- means NO client can read or write it at all — not even to find out whether
-- they are an admin. Only these security-definer functions and the SQL editor
-- can see inside.
create table if not exists public.platform_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;


-- ── 2. Make yourself the admin ───────────────────────────────────────
-- ⚠️  Replace this with the email you sign in to MathsLive with.
insert into public.platform_admins (user_id)
select id from auth.users
where lower(email) = lower('varunupadhyay.1669@gmail.com')
on conflict (user_id) do nothing;

-- If that inserted 0 rows, the email does not match an account. Check with:
--   select email from auth.users order by created_at;


-- ── 3. The gate ──────────────────────────────────────────────────────
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;


-- ── 4. Per-tutor usage ───────────────────────────────────────────────
-- Every tutor, busiest first. Refuses outright for anyone else — it does not
-- return an empty set, because "no data" and "not allowed" should not look the
-- same to whoever is calling.
create or replace function public.admin_tutor_usage()
returns table (
  user_id        uuid,
  email          text,
  signed_up      timestamptz,
  last_signed_in timestamptz,
  students       bigint,
  lessons        bigint,
  lessons_30d    bigint,
  lessons_7d     bigint,
  last_lesson    timestamptz,
  taught_seconds bigint
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  select
    u.id,
    u.email::text,
    u.created_at,
    u.last_sign_in_at,
    count(distinct c.id),
    count(s.id),
    count(s.id) filter (where s.started_at > now() - interval '30 days'),
    count(s.id) filter (where s.started_at > now() - interval '7 days'),
    max(s.started_at),
    -- Real teaching time (migration 003): seconds with a teacher and a student
    -- both in the room. Null on lessons taught before that existed, and
    -- summing nulls yields null rather than a misleading zero.
    sum(s.taught_seconds)::bigint
  from auth.users u
  left join public.classes  c on c.teacher_id = u.id
  left join public.sessions s on s.teacher_id = u.id
  group by u.id, u.email, u.created_at, u.last_sign_in_at
  order by count(s.id) filter (where s.started_at > now() - interval '30 days') desc,
           count(s.id) desc;
end;
$$;

revoke all on function public.admin_tutor_usage() from public;
grant execute on function public.admin_tutor_usage() to authenticated;


-- ── 5. Every student on the platform ─────────────────────────────────
create or replace function public.admin_student_usage()
returns table (
  tutor_email  text,
  student_name text,
  subject      text,
  room_code    text,
  added        timestamptz,
  lessons      bigint,
  last_lesson  timestamptz,
  taught_seconds bigint
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  select
    u.email::text, c.student_name, c.label, c.room_code, c.created_at,
    count(s.id), max(s.started_at), sum(s.taught_seconds)::bigint
  from public.classes c
  join auth.users u on u.id = c.teacher_id
  left join public.sessions s on s.class_id = c.id
  group by u.email, c.id, c.student_name, c.label, c.room_code, c.created_at
  order by max(s.started_at) desc nulls last;
end;
$$;

revoke all on function public.admin_student_usage() from public;
grant execute on function public.admin_student_usage() to authenticated;


-- ── Adding another admin later ───────────────────────────────────────
--   insert into public.platform_admins (user_id)
--   select id from auth.users where lower(email) = lower('them@example.com');
-- Removing one:
--   delete from public.platform_admins where user_id =
--     (select id from auth.users where lower(email) = lower('them@example.com'));
