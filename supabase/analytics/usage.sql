-- Who is actually using MathsLive.
--
-- Run these in Supabase → SQL Editor. They read across ALL tutors, which the
-- app itself cannot do: row-level security scopes classes and sessions to
-- `auth.uid() = teacher_id`, so each tutor's browser only ever sees their own
-- rows. The SQL editor runs as a privileged role, so it sees everything.
--
-- Nothing here needs to be installed. Paste and run whichever you want.
--
-- ONE HONEST CAVEAT about "hours": a session row's started_at is when the
-- lesson was first saved and ended_at is when it was last saved. That spans
-- the part of the lesson between saves, NOT the lesson. Treat the hours
-- columns as a floor, and see the note at the bottom for making them real.


-- ════════════════════════════════════════════════════════════════════
-- 1. THE ONE TO RUN FIRST — a row per tutor, busiest at the top
-- ════════════════════════════════════════════════════════════════════
select
  u.email,
  u.created_at::date                                     as signed_up,
  u.last_sign_in_at                                      as last_signed_in,
  case
    when u.last_sign_in_at is null then 'never signed in'
    when u.last_sign_in_at > now() - interval  '7 days' then 'active this week'
    when u.last_sign_in_at > now() - interval '30 days' then 'active this month'
    else 'dormant'
  end                                                    as status,
  count(distinct c.id)                                   as students,
  count(s.id)                                            as lessons,
  count(s.id) filter (where s.started_at > now() - interval '30 days') as lessons_30d,
  count(s.id) filter (where s.started_at > now() - interval  '7 days') as lessons_7d,
  max(s.started_at)                                      as last_lesson,
  -- See the caveat above: a floor, not true teaching time.
  round(sum(extract(epoch from (s.ended_at - s.started_at))) / 3600.0, 1) as recorded_hours
from auth.users u
left join public.classes  c on c.teacher_id = u.id
left join public.sessions s on s.teacher_id = u.id
group by u.id, u.email, u.created_at, u.last_sign_in_at
order by lessons_30d desc nulls last, lessons desc;


-- ════════════════════════════════════════════════════════════════════
-- 2. Signed up but never taught — who needs a nudge
-- ════════════════════════════════════════════════════════════════════
select
  u.email,
  u.created_at::date as signed_up,
  u.last_sign_in_at,
  count(distinct c.id) as students_added
from auth.users u
left join public.classes  c on c.teacher_id = u.id
left join public.sessions s on s.teacher_id = u.id
group by u.id, u.email, u.created_at, u.last_sign_in_at
having count(s.id) = 0
order by u.created_at desc;


-- ════════════════════════════════════════════════════════════════════
-- 3. Week by week — is usage growing or tailing off?
-- ════════════════════════════════════════════════════════════════════
select
  date_trunc('week', s.started_at)::date as week,
  u.email,
  count(*)                     as lessons,
  count(distinct s.class_id)   as students_taught
from public.sessions s
join auth.users u on u.id = s.teacher_id
where s.started_at > now() - interval '12 weeks'
group by 1, 2
order by week desc, lessons desc;


-- ════════════════════════════════════════════════════════════════════
-- 4. Every student on the platform, and when they were last taught
-- ════════════════════════════════════════════════════════════════════
select
  u.email                as tutor,
  c.student_name,
  c.label                as subject,
  c.room_code,
  c.created_at::date     as added,
  c.last_opened_at,
  count(s.id)            as lessons,
  max(s.started_at)      as last_lesson
from public.classes c
join auth.users u on u.id = c.teacher_id
left join public.sessions s on s.class_id = c.id
group by u.email, c.id, c.student_name, c.label, c.room_code, c.created_at, c.last_opened_at
order by u.email, last_lesson desc nulls last;


-- ════════════════════════════════════════════════════════════════════
-- 5. Sign-in history, not just the last one
-- ════════════════════════════════════════════════════════════════════
-- Supabase keeps an audit log. It is pruned over time, so this is recent
-- history rather than all of it.
select
  a.created_at as at,
  a.payload ->> 'actor_username' as email,
  a.payload ->> 'action'         as action
from auth.audit_log_entries a
where a.payload ->> 'action' in ('login', 'token_refreshed', 'user_signedup')
  and a.created_at > now() - interval '30 days'
order by a.created_at desc
limit 200;


-- ════════════════════════════════════════════════════════════════════
-- MAKING "hours" REAL
-- ════════════════════════════════════════════════════════════════════
-- The app writes started_at on the first save of a lesson and rewrites
-- ended_at on every later save, so the span covers saves rather than the
-- lesson. To measure teaching time properly the room would need to report
-- when a lesson begins and ends. Say the word and I will add it — one column
-- and a heartbeat from the room, and the hours above become accurate.
