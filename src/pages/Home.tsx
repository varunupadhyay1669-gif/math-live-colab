import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

export default function Home() {
  const navigate = useNavigate();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem("mathslive_teacher_name") || "");
  const [studentName, setStudentName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [recentRooms, setRecentRooms] = useState<Array<{ id: string; name: string; date: string }>>([]);
  const [activeCard, setActiveCard] = useState<"teacher" | "student">("teacher");

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
    const updated = [{ id: newRoomId, name, date: new Date().toLocaleString() }, ...recentRooms].slice(0, 5);
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
    navigate(`/room/${id}?name=${encodeURIComponent(teacherName.trim() || "Teacher")}`);
  };

  return (
    <main className="ml-page-bg min-h-screen flex items-center justify-center overflow-hidden px-4 py-8">
      <div className="relative z-10 grid w-full max-w-6xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <section className="space-y-8">
          <div className="flex items-center gap-3">
            <span className="ml-brandmark">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19V5a2 2 0 0 1 2-2h11" />
                <path d="M8 7h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8a4 4 0 0 1 0-8h12" />
                <path d="M10 11h6" />
              </svg>
            </span>
            <div>
              <div className="ml-title">MathsLive</div>
              <div className="ml-caption">Live classroom workspace</div>
            </div>
          </div>

          <div>
            <p className="ml-eyebrow mb-3">Interactive lessons</p>
            <h1 className="ml-display max-w-[620px]">Teach simulations with everyone on the same page.</h1>
            <p className="ml-body mt-5 max-w-[540px]">
              Run HTML explainers, sync scroll and quiz steps, annotate live, and keep student screens aligned from one calm teaching console.
            </p>
          </div>

          <div className="grid max-w-xl grid-cols-3 gap-3">
            {[
              ["Live sync", "Teacher-led scroll, zoom, and state"],
              ["Whiteboard", "Ink, images, erase, and reset"],
              ["Checkpoints", "Questions, XP, and progress"],
            ].map(([title, body]) => (
              <div key={title} className="ml-surface p-4">
                <div className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>{title}</div>
                <div className="mt-1 text-xs leading-5" style={{ color: "var(--text-muted)" }}>{body}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="ml-surface-elevated p-3 sm:p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setActiveCard("teacher")}
              className={`home-role-tab ${activeCard === "teacher" ? "active" : ""}`}
            >
              <span className="home-role-icon">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 5h18" /><path d="M6 5v14" /><path d="M18 5v14" /><path d="M8 19h8" /><path d="M9 9h6" />
                </svg>
              </span>
              <span>
                <strong>Teacher</strong>
                <small>Create a room</small>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveCard("student")}
              className={`home-role-tab ${activeCard === "student" ? "active" : ""}`}
            >
              <span className="home-role-icon">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                </svg>
              </span>
              <span>
                <strong>Student</strong>
                <small>Join live</small>
              </span>
            </button>
          </div>

          <div className="mt-4 rounded-xl border p-5 sm:p-6" style={{ borderColor: "var(--ml-border-soft)", background: "#fff" }}>
            {activeCard === "teacher" ? (
              <div className="animate-fade-in">
                <div className="mb-5">
                  <h2 className="ml-headline">Launch a session</h2>
                  <p className="ml-body mt-1">Name your room and open the teacher console.</p>
                </div>
                <label className="ml-field-label">Session title</label>
                <input
                  type="text"
                  placeholder="Calculus visualization 101"
                  value={teacherName}
                  onChange={(e) => setTeacherName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createRoom()}
                  className="ml-input"
                  autoFocus
                />
                <button onClick={createRoom} disabled={!teacherName.trim()} className="ml-btn ml-btn-primary ml-btn-lg ml-btn-block mt-4">
                  Create Room
                </button>
              </div>
            ) : (
              <form onSubmit={joinRoom} className="animate-fade-in">
                <div className="mb-5">
                  <h2 className="ml-headline">Join a live room</h2>
                  <p className="ml-body mt-1">Enter your name and the room code from your teacher.</p>
                </div>
                <label className="ml-field-label">Your name</label>
                <input
                  type="text"
                  placeholder="Arjun"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  className="ml-input mb-4"
                />
                <label className="ml-field-label">Room code</label>
                <input
                  type="text"
                  placeholder="A1B2C3D4"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  className="ml-input ml-input-mono"
                />
                <button type="submit" disabled={!roomCode.trim() || !studentName.trim()} className="ml-btn ml-btn-violet ml-btn-lg ml-btn-block mt-4">
                  Join Room
                </button>
              </form>
            )}
          </div>

          {recentRooms.length > 0 && (
            <div className="mt-4 rounded-xl p-4" style={{ background: "var(--ml-bg-muted)" }}>
              <div className="ml-eyebrow mb-3">Recent sessions</div>
              <div className="flex flex-wrap gap-2">
                {recentRooms.map((room) => (
                  <button key={room.id} onClick={() => joinRecent(room.id)} className="ml-btn ml-btn-secondary ml-btn-sm">
                    <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{room.id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
