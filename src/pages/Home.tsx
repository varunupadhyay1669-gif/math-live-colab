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
  const [activeCard, setActiveCard] = useState<"teacher" | "student" | null>(null);

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
    if (code && name) navigate(`/live/${code}?name=${encodeURIComponent(name)}`);
  };

  const joinRecent = (id: string) => {
    const name = teacherName.trim() || "Teacher";
    navigate(`/room/${id}?name=${encodeURIComponent(name)}`);
  };

  const teacherDisabled = !teacherName.trim();
  const studentDisabled = !roomCode.trim() || !studentName.trim();

  return (
    <div className="ml-page-bg">
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1240px] flex-col px-6 py-8 lg:py-14">
        {/* ── Top bar ── */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="ml-brandmark" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 18l6-12 4 8 6-4" />
              </svg>
            </span>
            <span className="ml-home-wordmark">
              Maths<span className="accent">Live</span>
            </span>
          </div>
          <span className="ml-hero-eyebrow">
            <span style={{ width: 6, height: 6, borderRadius: 9999, background: "var(--accent-emerald)", boxShadow: "0 0 0 3px rgba(5,150,105,0.18)" }} />
            Live now
          </span>
        </header>

        {/* ── Hero + cards ── */}
        <main className="mt-14 grid flex-1 grid-cols-1 items-start gap-12 lg:mt-20 lg:grid-cols-[1.15fr_1fr] lg:gap-20">
          {/* Hero copy */}
          <section className="lg:pt-6">
            <span className="ml-hero-eyebrow">For 1-on-1 tutoring · Built for math</span>
            <h1 className="ml-hero-display mt-5">
              The classroom is on{" "}
              <span style={{ background: "var(--gradient-primary)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
                the same page
              </span>
              .
            </h1>
            <p className="ml-hero-sub mt-6">
              Run any HTML simulation live with a student. Whiteboard, pan/zoom and ink stay in sync both ways — like
              flipping a real book with two pairs of hands. No screen-share friction. No drift.
            </p>

            <div className="mt-9 grid gap-3 sm:grid-cols-2" style={{ maxWidth: 540 }}>
              {[
                { title: "Shared whiteboard", body: "Pen, shapes, images, multi-select, undo. Mutual sync by default." },
                { title: "Premium simulations", body: "Drop in any HTML — quizzes, graphs, simulations. Stays in step." },
                { title: "View-only mode", body: "Lock the student to your view when explaining. One toggle." },
                { title: "No setup, no install", body: "Open a link. Teach. The room remembers your work." },
              ].map(item => (
                <div key={item.title} className="flex items-start gap-3" style={{ padding: "8px 0" }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 8, flexShrink: 0,
                    background: "rgba(79,70,229,0.10)", color: "var(--accent-indigo)",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text-primary)", letterSpacing: "-0.005em" }}>{item.title}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-secondary)", marginTop: 2 }}>{item.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Cards */}
          <section className="flex flex-col gap-5">
            {/* Teacher */}
            <div
              className={`ml-premium-card ${activeCard === "teacher" ? "is-active" : ""}`}
              onClick={() => setActiveCard("teacher")}
              style={{ padding: 24, cursor: "pointer" }}
            >
              <div className="flex items-center gap-3">
                <span className="ml-role-icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M13.8 12H3" />
                  </svg>
                </span>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text-primary)", letterSpacing: "-0.005em" }}>Launch a session</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>You're the teacher. Create a fresh room.</div>
                </div>
              </div>

              <div className="mt-5">
                <label htmlFor="t-name" className="ml-eyebrow" style={{ display: "block", marginBottom: 8 }}>Session title</label>
                <input
                  id="t-name"
                  type="text"
                  placeholder="e.g. Calculus — Chain Rule, Tuesday"
                  value={teacherName}
                  onChange={(e) => setTeacherName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createRoom()}
                  onFocus={() => setActiveCard("teacher")}
                  onClick={(e) => e.stopPropagation()}
                  className="ml-input"
                />
              </div>

              <button
                onClick={(e) => { e.stopPropagation(); createRoom(); }}
                disabled={teacherDisabled}
                className="ml-btn ml-btn-primary ml-btn-lg ml-btn-block mt-4"
              >
                Create room
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>

            {/* Student */}
            <div
              className={`ml-premium-card ${activeCard === "student" ? "is-active" : ""}`}
              onClick={() => setActiveCard("student")}
              style={{ padding: 24, cursor: "pointer" }}
            >
              <div className="flex items-center gap-3">
                <span className="ml-role-icon ml-role-icon-violet" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
                  </svg>
                </span>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text-primary)", letterSpacing: "-0.005em" }}>Join a session</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Got a code from your teacher? Hop in.</div>
                </div>
              </div>

              <form onSubmit={joinRoom} onClick={(e) => e.stopPropagation()} className="mt-5">
                <label htmlFor="s-name" className="ml-eyebrow" style={{ display: "block", marginBottom: 8 }}>Your name</label>
                <input
                  id="s-name"
                  type="text"
                  placeholder="e.g. Arjun"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  onFocus={() => setActiveCard("student")}
                  className="ml-input"
                />

                <label htmlFor="s-code" className="ml-eyebrow" style={{ display: "block", marginBottom: 8, marginTop: 14 }}>Room code</label>
                <input
                  id="s-code"
                  type="text"
                  placeholder="abc123de"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  onFocus={() => setActiveCard("student")}
                  className="ml-input"
                  style={{ fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.10em", textAlign: "center" }}
                />

                <button
                  type="submit"
                  disabled={studentDisabled}
                  className="ml-btn ml-btn-lg ml-btn-block mt-4"
                  style={{
                    background: studentDisabled ? "#E7E9EC" : "var(--accent-violet)",
                    color: studentDisabled ? "var(--text-muted)" : "#fff",
                    border: "none",
                    boxShadow: studentDisabled ? "none" : "0 1px 0 rgba(255,255,255,0.18) inset, 0 6px 18px -8px rgba(124, 58, 237, 0.55)",
                  }}
                >
                  Join room
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              </form>
            </div>

            {/* Recent rooms */}
            {recentRooms.length > 0 && (
              <div className="mt-2">
                <div className="ml-eyebrow" style={{ marginBottom: 10 }}>Recent rooms</div>
                <div className="flex flex-wrap gap-2">
                  {recentRooms.map(room => (
                    <button key={room.id} onClick={() => joinRecent(room.id)} className="ml-recent-pill" title={`${room.name} · ${room.date}`}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                      </svg>
                      {room.id}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </main>

        {/* ── Footer ── */}
        <footer className="mt-14 flex items-center justify-between pt-6" style={{ borderTop: "1px solid var(--border-subtle)" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            MathsLive · Real-time collaborative simulations
          </span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Designed for 1-on-1 tutoring
          </span>
        </footer>
      </div>
    </div>
  );
}
