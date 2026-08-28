import { api, NotSignedIn, ApiError } from './api';
import { classifyAdminError } from './adminLabels';

// MathsLive Admin — reading across every tutor.
//
// The real gate is on the server: every /api/admin route re-checks the caller
// against the platform_admins table before it reads a row, and answers 403
// otherwise. Everything here is convenience on top of that. Hiding the page
// from non-admins in the browser is a courtesy, not a control — anyone can
// call the same endpoint by hand, which is exactly why the check lives on the
// server.
//
// Membership is a row in platform_admins, so granting admin is a visible,
// deliberate INSERT rather than a flag someone can flip by accident.

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
    super('Admin access is not set up on this server yet. Add your email to the platform_admins table.');
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
  try {
    const { isAdmin } = await api.get<{ isAdmin: boolean }>('/api/admin/is-admin');
    return isAdmin ? 'admin' : 'denied';
  } catch (err) {
    if (err instanceof NotSignedIn) return 'no-auth';
    return 'error';
  }
}

/** Kept for callers that only need yes/no. */
export async function isPlatformAdmin(): Promise<boolean> {
  return (await checkAdminAccess()) === 'admin';
}

export async function fetchTutorUsage(): Promise<TutorUsage[]> {
  try {
    const { tutors } = await api.get<{ tutors: TutorUsage[] }>('/api/admin/tutors');
    return tutors ?? [];
  } catch (err) {
    if (err instanceof NotSignedIn) throw new Error('Sign in first.');
    if (err instanceof ApiError && err.status === 403) throw new Error('Not authorised.');
    throw err;
  }
}

export async function fetchStudentUsage(): Promise<StudentUsage[]> {
  try {
    const { students } = await api.get<{ students: StudentUsage[] }>('/api/admin/students');
    return students ?? [];
  } catch (err) {
    if (err instanceof NotSignedIn) throw new Error('Sign in first.');
    if (err instanceof ApiError && err.status === 403) throw new Error('Not authorised.');
    throw err;
  }
}

// Presentation helpers are re-exported from lib/adminLabels, which imports
// nothing — so a test of "is this tutor dormant" does not have to construct an
// API client to find out.
export { activityStatus, agoLabel, classifyAdminError, type ActivityStatus } from './adminLabels';
