import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

type RecentRoom = { id: string; name: string; date: string };

export default function Home() {
  const navigate = useNavigate();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem("mathslive_teacher_name") || "");
  const [studentName, setStudentName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("mathslive_recent_rooms");
      if (stored) setRecentRooms(JSON.parse(stored));
    } catch {}
  }, []);

  const createRoom = () => {
    const name = teacherName.trim();
    if (!name) return;
    localStorage.setItem("mathslive_teacher_name", name);
    const newRoomId = uuidv4().slice(0, 8);
    const updated: RecentRoom[] = [
      { id: newRoomId, name, date: new Date().toLocaleString() },
      ...recentRooms.filter(r => r.id !== newRoomId),
    ].slice(0, 5);
    localStorage.setItem("mathslive_recent_rooms", JSON.stringify(updated));
    navigate(`/room/${newRoomId}?name=${encodeURIComponent(name)}`);
  };

  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCode.trim();
    const name = studentName.trim();
    if (code && name) {
      navigate(`/live/${code}?name=${encodeURIComponent(name)}`);
    }
  };

  const joinRecent = (id: string) => {
    const name = teacherName.trim() || "Teacher";
    navigate(`/room/${id}?name=${encodeURIComponent(name)}`);
  };

  const teacherDisabled = !teacherName.trim();
  const studentDisabled = !roomCode.trim() || !studentName.trim();

  return (
    <div className="ml-page-bg">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1180px] flex-col px-6 py-8 lg:py-14">
        {/* Top bar */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="ml-brandmark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 18l6-12 4 8 6-4" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-[color:var(--text-primary)]">
              Math<span className="text-[color:var(--accent-indigo)]">Live</span>
            </span>
          </div>
          <span className="ml-badge ml-badge-indigo">
            <span className="ml-badge-dot" />
            Live teaching platform
          </span>
        </header>

        {/* Hero + cards */}
        <main className="mt-12 grid flex-1 grid-cols-1 items-center gap-12 lg:mt-16 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          {/* Hero copy */}
          <section>
            <span className="ml-eyebrow">For teachers and students</span>
            <h1 className="ml-display mt-4">
              Run live HTML simulations with{" "}
              <span className="bg-clip-text text-transparent" style={{ backgroundImage: "var(--gradient-primary)" }}>
                deterministic sync
              </span>
              .
            </h1>
            <p className="ml-body mt-5 max-w-[520px] text-[15px]">
              Math Live is a premium delivery platform for interactive simulations. Bring custom HTML from your
              authoring tools, present it live, annotate, and stay perfectly in sync with every student in the room.
            </p>

            <ul className="mt-8 grid gap-3 text-[14px] text-[color:var(--text-secondary)] sm:grid-cols-2">
              {[
                "Teacher-authoritative live sync",
                "Late-join and reconnect recovery",
                "Whiteboard, annotation, and laser tools",
                "View-only or interactive student modes",
              ].map(item => (
                <li key={item} className="flex items-start gap-2">
                  <svg className="mt-[3px] flex-shrink-0 text-[color:var(--accent-indigo)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Entry cards */}
          <section className="flex flex-col gap-5">
            {/* Teacher */}
            <div className="ml-surface-elevated p-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="ml-eyebrow">Teach</div>
                  <h2 className="ml-headline mt-1">Launch a session</h2>
                </div>
                <span className="ml-badge ml-badge-indigo">Teacher</span>
              </div>
              <p className="ml-caption mt-2">Create a room and bring students into your simulation.</p>

              <div className="mt-5">
                <label htmlFor="teacher-name" className="ml-field-label">Your name or session title</label>
                <input
                  id="teacher-name"
                  type="text"
                  className="ml-input"
                  placeholder="e.g. Calculus — Visualizing Limits"
                  value={teacherName}
                  onChange={e => setTeacherName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && createRoom()}
                  autoComplete="off"
                />
              </div>

              <button
                type="button"
                className="ml-btn ml-btn-primary ml-btn-lg ml-btn-block mt-4"
                onClick={createRoom}
                disabled={teacherDisabled}
              >
                Create room
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 5l7 7-7 7" />
                </svg>
              </button>

              {recentRooms.length > 0 && (
                <div className="mt-5">
                  <div className="ml-eyebrow mb-2">Recent rooms</div>
                  <div className="flex flex-wrap gap-2">
                    {recentRooms.map(room => (
                      <button
                        key={room.id}
                        type="button"
                        className="ml-btn ml-btn-secondary ml-btn-sm"
                        onClick={() => joinRecent(room.id)}
                        title={`Re-open ${room.name}`}
                      >
                        <span className="font-mono tracking-[0.16em] text-[12px]">{room.id}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Student */}
            <div className="ml-surface p-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="ml-eyebrow">Join</div>
                  <h2 className="ml-headline mt-1">Enter a session</h2>
                </div>
                <span className="ml-badge">Student</span>
              </div>
              <p className="ml-caption mt-2">Got a room code from your teacher? Join the live session.</p>

              <form onSubmit={joinRoom} className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="grid gap-3">
                  <div>
                    <label htmlFor="student-name" className="ml-field-label">Your name</label>
                    <input
                      id="student-name"
                      type="text"
                      className="ml-input"
                      placeholder="Arjun"
                      value={studentName}
                      onChange={e => setStudentName(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label htmlFor="room-code" className="ml-field-label">Room code</label>
                    <input
                      id="room-code"
                      type="text"
                      className="ml-input ml-input-mono"
                      placeholder="e.g. K3D-7P9"
                      value={roomCode}
                      onChange={e => setRoomCode(e.target.value)}
                      autoComplete="off"
                      maxLength={20}
                    />
                  </div>
                </div>
                <button type="submit" className="ml-btn ml-btn-violet ml-btn-lg sm:self-end" disabled={studentDisabled}>
                  Join
                </button>
              </form>
            </div>
          </section>
        </main>

        <footer className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-[color:var(--ml-border-soft)] pt-6 text-[12px] text-[color:var(--text-muted)] sm:flex-row">
          <span>Built for live teaching of custom HTML simulations.</span>
          <span className="font-mono tracking-wider">v3 · math-live</span>
        </footer>
      </div>
    </div>
  );
}
