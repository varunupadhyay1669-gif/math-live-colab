import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

type Mode = null | "teacher" | "student";

export default function Home() {
  const navigate = useNavigate();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem("mathslive_teacher_name") || "");
  const [studentName, setStudentName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [mode, setMode] = useState<Mode>(null);

  const createRoom = () => {
    const name = teacherName.trim();
    if (!name) return;
    localStorage.setItem("mathslive_teacher_name", name);
    const newRoomId = uuidv4().slice(0, 8);
    navigate(`/room/${newRoomId}?name=${encodeURIComponent(name)}`);
  };

  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomCode.trim();
    const name = studentName.trim();
    if (code && name) navigate(`/live/${code}?name=${encodeURIComponent(name)}`);
  };

  return (
    <div className="ml-dark-home">
      <div className="ml-dark-stage">
        {/* Top bar */}
        <header className="ml-dark-topbar">
          <div className="ml-dark-brand">
            <span className="ml-dark-brandmark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 18l6-12 4 8 6-4" />
              </svg>
            </span>
            <span className="ml-dark-wordmark">
              Maths<span className="accent">Live</span>
            </span>
          </div>
          <span className="ml-dark-pill">
            <span className="dot" />
            Live
          </span>
        </header>

        {/* Center */}
        <main className="ml-dark-center">
          <h1 className="ml-dark-headline">
            <span className="word-cream">Math</span>
            <span className="word-grad">Reimagined</span>
          </h1>

          {/* Initial mode picker */}
          {mode === null && (
            <div className="ml-dark-mode-row">
              <button
                className="ml-dark-btn ml-dark-btn-primary"
                onClick={() => setMode("teacher")}
                autoFocus
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M13.8 12H3" />
                </svg>
                Start teaching
              </button>
              <button
                className="ml-dark-btn ml-dark-btn-glass"
                onClick={() => setMode("student")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                </svg>
                Join a room
              </button>
            </div>
          )}

          {/* Teacher form */}
          {mode === "teacher" && (
            <div className="ml-dark-form">
              <input
                autoFocus
                className="ml-dark-input"
                placeholder="What are you teaching today?"
                value={teacherName}
                onChange={(e) => setTeacherName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createRoom()}
              />
              <button
                className="ml-dark-btn ml-dark-btn-primary"
                onClick={createRoom}
                disabled={!teacherName.trim()}
                style={{ width: "100%" }}
              >
                Create room
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
              <div className="ml-dark-back-row">
                <button
                  className="ml-dark-btn ml-dark-btn-ghost"
                  onClick={() => setMode(null)}
                >
                  ← Back
                </button>
              </div>
            </div>
          )}

          {/* Student form */}
          {mode === "student" && (
            <form className="ml-dark-form" onSubmit={joinRoom}>
              <input
                autoFocus
                className="ml-dark-input"
                placeholder="Your name"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
              />
              <input
                className="ml-dark-input ml-dark-input-mono"
                placeholder="abc123de"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
              />
              <button
                type="submit"
                className="ml-dark-btn ml-dark-btn-primary"
                disabled={!roomCode.trim() || !studentName.trim()}
                style={{ width: "100%" }}
              >
                Join room
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
              <div className="ml-dark-back-row">
                <button
                  type="button"
                  className="ml-dark-btn ml-dark-btn-ghost"
                  onClick={() => setMode(null)}
                >
                  ← Back
                </button>
              </div>
            </form>
          )}

        </main>

        {/* Footer */}
        <footer className="ml-dark-footer">
          <span>MathsLive</span>
        </footer>
      </div>
    </div>
  );
}
