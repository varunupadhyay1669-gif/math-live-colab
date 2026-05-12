import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { savedBoards, type SavedBoard } from "../lib/prefs";

type Mode = null | "teacher" | "student";

// Tiny "5m ago" / "2h ago" / "yesterday" helper. Avoid depending on a
// date library for one little label.
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

export default function Home() {
  const navigate = useNavigate();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem("mathslive_teacher_name") || "");
  const [studentName, setStudentName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [mode, setMode] = useState<Mode>(null);
  // AUTONOMOUS: Read saved-boards on first render and on every mode flip.
  // (Refs/state set on actions stay correct; the initial read covers the
  // common case of opening Home and seeing the list.)
  const [boards, setBoards] = useState<SavedBoard[]>(() => savedBoards.list());

  const removeBoard = (roomId: string) => {
    savedBoards.remove(roomId);
    setBoards(savedBoards.list());
  };
  const openBoard = (board: SavedBoard) => {
    navigate(`/room/${board.roomId}?name=${encodeURIComponent(board.name)}`);
  };

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
            <>
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

              {/* AUTONOMOUS: Miro-style "My boards" — saved rooms from
                  this browser. Hidden when empty so first-time users
                  see the clean landing page. */}
              {boards.length > 0 && (
                <div className="ml-dark-saved">
                  <div className="ml-dark-saved-head">
                    <span>My saved boards</span>
                    <span className="ml-dark-saved-count">{boards.length}</span>
                  </div>
                  <ul className="ml-dark-saved-list">
                    {boards.slice(0, 6).map(b => (
                      <li key={b.roomId} className="ml-dark-saved-item">
                        <button
                          className="ml-dark-saved-open"
                          onClick={() => openBoard(b)}
                          title={`Open ${b.label || b.roomId}`}
                        >
                          <span className="ml-dark-saved-label">{b.label || 'Untitled board'}</span>
                          <span className="ml-dark-saved-meta">
                            {b.roomId} · saved {formatRelativeTime(b.claimedAt)}
                          </span>
                        </button>
                        <button
                          className="ml-dark-saved-remove"
                          onClick={() => removeBoard(b.roomId)}
                          aria-label={`Remove ${b.roomId}`}
                          title="Remove from my boards"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                  {boards.length > 6 && (
                    <div className="ml-dark-saved-more">+{boards.length - 6} more</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Teacher form */}
          {mode === "teacher" && (
            <div className="ml-dark-form">
              <input
                autoFocus
                className="ml-dark-input"
                placeholder="What are you teaching today?"
                aria-label="What are you teaching today?"
                value={teacherName}
                onChange={(e) => setTeacherName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createRoom()}
              />
              <button
                className="ml-dark-btn ml-dark-btn-primary"
                onClick={createRoom}
                disabled={!teacherName.trim()}
                title={!teacherName.trim() ? "Please enter a topic to create a room" : "Create room"}
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
                aria-label="Your name"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
              />
              <input
                className="ml-dark-input ml-dark-input-mono"
                placeholder="abc123de"
                aria-label="Room code"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
              />
              <button
                type="submit"
                className="ml-dark-btn ml-dark-btn-primary"
                disabled={!roomCode.trim() || !studentName.trim()}
                title={!studentName.trim() || !roomCode.trim() ? "Please enter your name and a room code to join" : "Join room"}
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
