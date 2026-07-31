import { supabase } from './supabase';

// A "class" is one student's permanent room: a stable room_code (the
// /live/<code> link) owned by the signed-in teacher. Row-Level Security on the
// `classes` table (see SUPABASE.md) guarantees a teacher only ever sees their
// own rows — the teacher_id we send is re-checked server-side by the policy.
export interface ClassRow {
  id: string;
  teacher_id: string;
  student_name: string;
  label: string | null;
  room_code: string;
  created_at: string;
  last_opened_at: string | null;
  // ── Student profile (added by the migration in SUPABASE.md) ──
  // Optional on the type on purpose: a database that hasn't run the migration
  // yet simply doesn't return them, and every screen must still work. Reads go
  // through profileFrom() in lib/studentProfile, which normalises the absence.
  grade?: string | null;
  level?: string | null;
  goals?: string | null;    // one goal per line
  avatar?: string | null;   // a single emoji; blank falls back to initials
}

/** Thrown when the profile columns haven't been added to the database yet. */
export class ProfileColumnsMissing extends Error {
  constructor() {
    super('Your database does not have the student profile fields yet. Run the migration in SUPABASE.md (one SQL block), then try again.');
    this.name = 'ProfileColumnsMissing';
  }
}

/** Postgres 42703 = undefined_column — the un-migrated database. */
function isMissingColumn(e: unknown): boolean {
  return (e as { code?: string })?.code === '42703';
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    // Cap at 15 so the base PLUS a possible `-xxxx` collision suffix (5 chars)
    // never exceeds the server's MAX_ROOM_ID_LENGTH of 20. Longer codes were
    // rejected by isValidRoomId on join, producing permanently dead /live links.
    .slice(0, 15);
}

function randSuffix(): string {
  // 4 lowercase-alnum chars — enough entropy that collisions are rare, short
  // enough to keep the link tidy.
  return Math.random().toString(36).slice(2, 6);
}

export async function listClasses(): Promise<ClassRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('classes')
    .select('*')
    .order('last_opened_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ClassRow[];
}

export async function createClass(studentName: string, label?: string): Promise<ClassRow> {
  if (!supabase) throw new Error('Auth not configured');
  const { data: userData } = await supabase.auth.getUser();
  const teacher_id = userData.user?.id;
  if (!teacher_id) throw new Error('Not signed in');
  const base = slug(studentName) || 'class';
  // Prefer the student's plain name as the room code (memorable — the student
  // can just type their name to join). Only add a short suffix if that exact
  // code is already taken globally.
  for (let attempt = 0; attempt < 6; attempt++) {
    const room_code = attempt === 0 ? base : `${base}-${randSuffix()}`;
    const { data, error } = await supabase
      .from('classes')
      .insert({ teacher_id, student_name: studentName.trim(), label: label?.trim() || null, room_code })
      .select()
      .single();
    if (!error) return data as ClassRow;
    // 23505 = unique_violation → try a different code; anything else is real.
    if ((error as { code?: string }).code !== '23505') throw error;
  }
  throw new Error('Could not generate a unique room code — please try again.');
}

export async function updateClass(
  id: string,
  fields: {
    student_name?: string; label?: string | null;
    grade?: string | null; level?: string | null; goals?: string | null; avatar?: string | null;
  },
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('classes').update(fields).eq('id', id);
  if (error) throw isMissingColumn(error) ? new ProfileColumnsMissing() : error;
}

/** One student by their room code. RLS means this resolves only for the owner. */
export async function getClassByRoomCode(roomCode: string): Promise<ClassRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('classes').select('*').eq('room_code', roomCode).maybeSingle();
  if (error) throw error;
  return (data as ClassRow) ?? null;
}

export async function deleteClass(id: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('classes').delete().eq('id', id);
  if (error) throw error;
}

// Best-effort "last opened" stamp so the dashboard can sort by recency. Never
// blocks opening the room if it fails.
export async function touchClass(roomCode: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('classes').update({ last_opened_at: new Date().toISOString() }).eq('room_code', roomCode);
  } catch {
    /* non-critical */
  }
}
