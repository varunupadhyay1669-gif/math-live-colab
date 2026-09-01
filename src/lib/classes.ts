import { api, NotSignedIn } from './api';

// A "class" is one student's permanent room: a stable room_code (the
// /live/<code> link) owned by the signed-in teacher.
//
// This used to query Supabase from the browser, with row-level security making
// that safe. It now calls this server's own API, and the equivalent guarantee
// is that every statement there is scoped by the session cookie — a teacher
// cannot ask for someone else's class, because the id is never something the
// browser gets to state.
export interface ClassRow {
  id: string;
  teacher_id: string;
  student_name: string;
  label: string | null;
  room_code: string;
  created_at: string;
  last_opened_at: string | null;
  grade?: string | null;
  level?: string | null;
  goals?: string | null;    // one goal per line
  avatar?: string | null;   // a single emoji; blank falls back to initials
  textbook?: string | null;
}

/**
 * Kept so callers that still catch it keep compiling.
 *
 * It can no longer be thrown: the profile columns are created by the same boot
 * DDL as the table itself, so "the migration has not been run" is not a state
 * this database can be in.
 */
export class ProfileColumnsMissing extends Error {
  constructor() {
    super('Your database does not have the student profile fields yet.');
    this.name = 'ProfileColumnsMissing';
  }
}

/** Signed out reads as "no classes" rather than an error on the dashboard. */
function emptyIfSignedOut<T>(err: unknown, fallback: T): T {
  if (err instanceof NotSignedIn) return fallback;
  throw err;
}

export async function listClasses(): Promise<ClassRow[]> {
  try {
    const { classes } = await api.get<{ classes: ClassRow[] }>('/api/classes');
    return classes ?? [];
  } catch (err) { return emptyIfSignedOut(err, []); }
}

export async function createClass(studentName: string, label?: string): Promise<ClassRow> {
  // The room code is chosen server-side: it has to be unique across every
  // teacher, and only the server can see that.
  const { class: row } = await api.post<{ class: ClassRow }>('/api/classes', { studentName, label });
  return row;
}

export async function updateClass(
  id: string,
  fields: {
    student_name?: string; label?: string | null;
    grade?: string | null; level?: string | null; goals?: string | null; avatar?: string | null;
    textbook?: string | null;
  },
): Promise<void> {
  await api.patch(`/api/classes/${encodeURIComponent(id)}`, fields);
}

/** One student by their room code. Resolves only for the owning teacher. */
export async function getClassByRoomCode(roomCode: string): Promise<ClassRow | null> {
  try {
    const { class: row } = await api.get<{ class: ClassRow | null }>(
      `/api/classes/by-code/${encodeURIComponent(roomCode)}`);
    return row ?? null;
  } catch (err) { return emptyIfSignedOut(err, null); }
}

export async function deleteClass(id: string): Promise<void> {
  await api.del(`/api/classes/${encodeURIComponent(id)}`);
}

/**
 * Best-effort "last opened" stamp so the dashboard sorts by recency.
 *
 * Never allowed to block opening a room: a tutor with a child waiting does not
 * care that the sort order is stale.
 */
export async function touchClass(roomCode: string): Promise<void> {
  try {
    await api.post(`/api/classes/by-code/${encodeURIComponent(roomCode)}/opened`);
  } catch { /* non-critical */ }
}


/** A student sitting in one of your rooms with nobody there to teach them. */
export interface WaitingRoom {
  roomCode: string;
  studentName: string;
  waitingNames: string[];
  waitingSince: number;
}

/**
 * Who is waiting for you right now.
 *
 * Scoped on the server to the signed-in teacher's own classes, so this can
 * never report someone else's room.
 */
export const listWaiting = () => api.get<{ waiting: WaitingRoom[] }>('/api/waiting');
