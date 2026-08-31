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
  /** Decided by the server, never recomputed here — one answer, one place. */
  billing: {
    state: 'trial' | 'active' | 'expired' | 'admin';
    until: string | null;
    daysLeft: number | null;
  };
}

/** The business, in numbers. */
export interface Overview {
  paying: number;
  trialing: number;
  expired: number;
  expiring_7d: number;
  trials_ending_3d: number;
  claims_pending: number;
  collected_total: number;
  collected_month: number;
  students: number;
  lessons_today: number;
  lessons_7d: number;
  teachers_active_7d: number;
  mrr: number;
  priceRupees: number;
  trialDays: number;
  liveRooms: number;
}

/** One teacher on the collections calendar. */
export interface Renewal {
  id: string;
  email: string;
  kind: 'paid' | 'trial';
  ends_at: string | null;
  paid_until: string | null;
  trial_started_at: string | null;
  students: number;
  last_lesson: string | null;
  payments: number;
  claim_pending: boolean;
}

/** A room with people in it, right now. */
export interface LiveRoom {
  roomId: string;
  teacher: string | null;
  students: string[];
  startedAt: number;
  lastActivityAt: number;
  paused: boolean;
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


// ── The owner's cockpit ────────────────────────────────────────────────────
// Three separate calls on purpose: a failure in one panel must not blank the
// others. The revenue figures matter more than the live view, and should not
// disappear because a room lookup threw.
export const getOverview = () => api.get<Overview>('/api/admin/overview');
export const getRenewals = () => api.get<{ renewals: Renewal[]; trialDays: number }>('/api/admin/renewals');
export const getLiveRooms = () => api.get<{ rooms: LiveRoom[]; at: number }>('/api/admin/live');

/** "in 3 days", "today", "6 days ago" — for a date that may be in either direction. */
export function untilLabel(iso: string | null): { text: string; days: number | null; urgent: boolean } {
  if (!iso) return { text: '—', days: null, urgent: false };
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return { text: '—', days: null, urgent: false };
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d ago`, days, urgent: true };
  if (days === 0) return { text: 'today', days, urgent: true };
  if (days === 1) return { text: 'tomorrow', days, urgent: true };
  return { text: `in ${days}d`, days, urgent: days <= 7 };
}
