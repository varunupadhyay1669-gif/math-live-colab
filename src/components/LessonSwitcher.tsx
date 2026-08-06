import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClassRow } from '../lib/classes';
import type { SessionRow } from '../lib/sessions';
import { avatarFor } from '../lib/studentProfile';
import { lessonLabel, lessonIsToday, labelSessions } from '../lib/lessonNav';

// Who you are teaching, and which lesson you are looking at.
//
// Both of these lived only on the dashboard, which meant leaving the room to
// change either. A tutor teaching back-to-back students had to go out to the
// dashboard and back in; a tutor wanting last week's board to remind a student
// what they did had no way to reach it at all.

interface Props {
  student: string;
  classes: ClassRow[];
  sessions: SessionRow[];
  /** Which lesson is on the board — null means today's, unsaved. */
  currentSessionId: string | null;
  busy: boolean;
  onPickStudent: (row: ClassRow) => void;
  onPickLesson: (row: SessionRow) => void;
  onNewLesson: () => void;
}

function useOutsideClose(onClose: () => void, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export default function LessonSwitcher({
  student, classes, sessions, currentSessionId, busy,
  onPickStudent, onPickLesson, onNewLesson,
}: Props) {
  const [open, setOpen] = useState<null | 'student' | 'lesson'>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const studentBtn = useRef<HTMLButtonElement>(null);
  const lessonBtn = useRef<HTMLButtonElement>(null);

  useOutsideClose(() => setOpen(null), open !== null);

  // Anchored through a portal, like the other toolbar menus: the header has
  // overflow clipping and a plain absolute menu is cut off by it.
  const anchor = (el: HTMLElement | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), top: r.bottom + 6 };
  };

  const current = sessions.find(s => s.id === currentSessionId);
  const avatar = avatarFor(student);

  return (
    <div className="ml-switcher">
      <button
        ref={studentBtn}
        className="ml-switcher-btn"
        disabled={busy}
        onClick={() => { setPos(anchor(studentBtn.current)); setOpen(o => (o === 'student' ? null : 'student')); }}
        title="Switch to another student"
        aria-haspopup="menu"
        aria-expanded={open === 'student'}
      >
        <span className="ml-switcher-avatar" style={{ background: avatar.bg, color: avatar.fg }}>{avatar.label}</span>
        <span className="ml-switcher-name">{student}</span>
        <span className="ml-switcher-caret" aria-hidden="true">⌄</span>
      </button>

      <button
        ref={lessonBtn}
        className="ml-switcher-btn is-lesson"
        disabled={busy}
        onClick={() => { setPos(anchor(lessonBtn.current)); setOpen(o => (o === 'lesson' ? null : 'lesson')); }}
        title="Switch to another lesson"
        aria-haspopup="menu"
        aria-expanded={open === 'lesson'}
      >
        {busy ? 'Loading…' : current ? lessonLabel(current) : 'Today'}
        <span className="ml-switcher-caret" aria-hidden="true">⌄</span>
      </button>

      {open && pos && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: 59 }} onClick={() => setOpen(null)} />
          <div className="ml-switcher-menu" role="menu"
            style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 60 }}>
            {open === 'student' ? (
              <>
                <div className="ml-switcher-head">Switch students</div>
                {classes.length === 0 && <div className="ml-switcher-empty">No other students yet.</div>}
                {classes.map(c => {
                  const a = avatarFor(c.student_name, c.avatar ?? undefined);
                  return (
                    <button key={c.id} role="menuitem" className="ml-switcher-item"
                      onClick={() => { setOpen(null); onPickStudent(c); }}>
                      <span className="ml-switcher-avatar" style={{ background: a.bg, color: a.fg }}>{a.label}</span>
                      <span className="ml-switcher-item-name">{c.student_name}</span>
                      {c.label && <span className="ml-switcher-sub">{c.label}</span>}
                    </button>
                  );
                })}
              </>
            ) : (
              <>
                <div className="ml-switcher-head">Select a lesson</div>
                <button role="menuitem" className="ml-switcher-item is-new"
                  onClick={() => { setOpen(null); onNewLesson(); }}>
                  ✦ Start a new lesson
                </button>
                {sessions.length === 0 && <div className="ml-switcher-empty">Nothing saved for this student yet.</div>}
                {labelSessions(sessions).map(({ row: s, label }) => (
                  <button key={s.id} role="menuitem"
                    className={`ml-switcher-item ${s.id === currentSessionId ? 'is-current' : ''}`}
                    onClick={() => { setOpen(null); onPickLesson(s); }}>
                    <span className="ml-switcher-check" aria-hidden="true">{s.id === currentSessionId ? '✓' : ''}</span>
                    <span className="ml-switcher-item-name">{label}</span>
                    {lessonIsToday(s) && <span className="ml-switcher-sub">today</span>}
                  </button>
                ))}
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
