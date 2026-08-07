import { supabase } from './supabase';

// MathsLive Admin — reading across every tutor.
//
// The real gate is in Postgres (migration 004): these RPCs run `security
// definer` and raise 'not authorised' for anyone who is not a listed admin.
// Everything here is convenience on top of that. Hiding the page from
// non-admins in the browser is a courtesy, not a control — anyone can call the
// same RPC by hand, which is exactly why the check lives in the database.
//
// There is deliberately no service-role key in this app. That key bypasses
// row-level security completely, so one leak would expose every tutor's
// students.

export interface TutorUsage {
  user_id: string;
  email: string;
  signed_up: string;
  last_signed_in: string | null;
  students: number;
  lessons: number;
  lessons_30d: number;
  lessons_7d: number;
  last_lesson: string | null;
  taught_seconds: number | null;
}

export interface StudentUsage {
  tutor_email: string;
  student_name: string;
  subject: string | null;
  room_code: string;
  added: string;
  lessons: number;
  last_lesson: string | null;
  taught_seconds: number | null;
}

/** Thrown when the admin migration has not been run yet. */
export class AdminNotInstalled extends Error {
  constructor() {
    super('The admin functions are not in this database yet. Run supabase/migrations/004_platform_admin.sql in the SQL editor.');
    this.name = 'AdminNotInstalled';
  }
}

/** Postgres 42883 = undefined_function — migration 004 has not been run. */
function notInstalled(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message || '';
  return code === '42883' || /could not find the function|does not exist/i.test(msg);
}

/** 42501 = insufficient_privilege — signed in, but not an admin. */
function notAllowed(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message || '';
  return code === '42501' || /not authorised|not authorized/i.test(msg);
}

/**
 * Is the signed-in user an admin?
 *
 * False for "no", for "not signed in", and for "the migration is not installed"
 * — all three mean the same thing to the page: do not show it.
 */
export async function isPlatformAdmin(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('is_platform_admin');
  if (error) return false;
  return data === true;
}

export async function fetchTutorUsage(): Promise<TutorUsage[]> {
  if (!supabase) throw new Error('Auth is not configured');
  const { data, error } = await supabase.rpc('admin_tutor_usage');
  if (error) {
    if (notInstalled(error)) throw new AdminNotInstalled();
    if (notAllowed(error)) throw new Error('Not authorised.');
    throw error;
  }
  return (data ?? []) as TutorUsage[];
}

export async function fetchStudentUsage(): Promise<StudentUsage[]> {
  if (!supabase) throw new Error('Auth is not configured');
  const { data, error } = await supabase.rpc('admin_student_usage');
  if (error) {
    if (notInstalled(error)) throw new AdminNotInstalled();
    if (notAllowed(error)) throw new Error('Not authorised.');
    throw error;
  }
  return (data ?? []) as StudentUsage[];
}

// Presentation helpers are re-exported from lib/adminLabels, which imports
// nothing — so a test of "is this tutor dormant" does not have to construct a
// Supabase client to find out.
export { activityStatus, agoLabel, type ActivityStatus } from './adminLabels';
