import { getSupabase } from './supabase';
import { classifyAdminError } from './adminLabels';

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

/**
 * Why the admin page is or is not available.
 *
 * This used to be a boolean, so "the database functions were never installed"
 * rendered as "this account does not have access" — telling the owner they
 * lacked permission to their own platform, and sending them looking for a
 * permissions bug that did not exist. Three different situations need three
 * different sentences.
 */
export type AdminAccess = 'admin' | 'denied' | 'not-installed' | 'no-auth' | 'error';

export async function checkAdminAccess(): Promise<AdminAccess> {
  const supabase = await getSupabase();
  if (!supabase) return 'no-auth';
  const { data, error } = await supabase.rpc('is_platform_admin');
  if (error) return classifyAdminError(error);
  return data === true ? 'admin' : 'denied';
}

/** Kept for callers that only need yes/no. */
export async function isPlatformAdmin(): Promise<boolean> {
  return (await checkAdminAccess()) === 'admin';
}

export async function fetchTutorUsage(): Promise<TutorUsage[]> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Auth is not configured');
  const { data, error } = await supabase.rpc('admin_tutor_usage');
  if (error) {
    const kind = classifyAdminError(error);
    if (kind === 'not-installed') throw new AdminNotInstalled();
    if (kind === 'denied') throw new Error('Not authorised.');
    throw error;
  }
  return (data ?? []) as TutorUsage[];
}

export async function fetchStudentUsage(): Promise<StudentUsage[]> {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Auth is not configured');
  const { data, error } = await supabase.rpc('admin_student_usage');
  if (error) {
    const kind = classifyAdminError(error);
    if (kind === 'not-installed') throw new AdminNotInstalled();
    if (kind === 'denied') throw new Error('Not authorised.');
    throw error;
  }
  return (data ?? []) as StudentUsage[];
}

// Presentation helpers are re-exported from lib/adminLabels, which imports
// nothing — so a test of "is this tutor dormant" does not have to construct a
// Supabase client to find out.
export { activityStatus, agoLabel, classifyAdminError, type ActivityStatus } from './adminLabels';
