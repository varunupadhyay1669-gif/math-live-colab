import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { savedBoards, templates, type SavedBoard, type LessonTemplate } from "../lib/prefs";
import { useAuth } from "../lib/auth";

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
  const auth = useAuth();
  const [teacherName, setTeacherName] = useState(() => localStorage.getItem("mathslive_teacher_name") || "");

  // When auth is on and the teacher signs in with Google, prefill their name
  // from the account (only if they haven't typed/saved one already).
  useEffect(() => {
    if (!auth.user) return;
    setTeacherName((prev) => {
      if (prev.trim()) return prev;
      const meta = auth.user?.user_metadata as { full_name?: string; name?: string } | undefined;
      return meta?.full_name || meta?.name || auth.user?.email || prev;
    });
  }, [auth.user]);
  const [studentName, setStudentName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  // Optional fixed/permanent room code. When the teacher names a class, the
  // same link (/room/<code> for them, /live/<code> for students) works every
  // time — no need to resend a new code each session.
  const [classCode, setClassCode] = useState("");
  // Magic-link sign-in state (teacher auth).
  const [loginEmail, setLoginEmail] = useState("");
  const [sendingLink, setSendingLink] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const sendMagicLink = async () => {
    const email = loginEmail.trim();
    if (!email || sendingLink) return;
    setSendingLink(true);
    setLoginError(null);
    const { error } = await auth.signInWithEmail(email);
    setSendingLink(false);
    if (error) setLoginError(error);
    else setLinkSent(true);
  };
  const [mode, setMode] = useState<Mode>(null);

  // Flow: as soon as a signed-in teacher reaches the teacher path, send them
  // to their dashboard — the hub where they create per-student rooms.
  useEffect(() => {
    if (auth.enabled && auth.user && mode === "teacher") navigate("/dashboard");
  }, [auth.enabled, auth.user, mode, navigate]);
  // AUTONOMOUS: Read saved-boards on first render and on every mode flip.
  // (Refs/state set on actions stay correct; the initial read covers the
  // common case of opening Home and seeing the list.)
  const [boards, setBoards] = useState<SavedBoard[]>(() => savedBoards.list());
  // AUTONOMOUS: Lesson templates — saved whiteboard snapshots that the
  // teacher can re-instantiate as a fresh room. Each "Use" opens a new
  // room and hydrates it from localStorage (see Room.tsx ?template=ID).
  const [tpls, setTpls] = useState<LessonTemplate[]>(() => templates.list());

  const removeBoard = (roomId: string) => {
    savedBoards.remove(roomId);
    setBoards(savedBoards.list());
  };
  const openBoard = (board: SavedBoard) => {
    navigate(`/room/${board.roomId}?name=${encodeURIComponent(board.name)}`);
  };
  const useTemplate = (tpl: LessonTemplate) => {
    // Need a teacher name to enter a fresh room. Fall back to a stored
    // name if present, else ask the user once.
    const stored = (localStorage.getItem("mathslive_teacher_name") || "").trim();
    const name = stored || (window.prompt("What are you teaching today?") || "").trim();
    if (!name) return;
    localStorage.setItem("mathslive_teacher_name", name);
    const newRoomId = uuidv4().slice(0, 8);
    navigate(`/room/${newRoomId}?name=${encodeURIComponent(name)}&template=${encodeURIComponent(tpl.id)}`);
  };
  const removeTemplate = (id: string) => {
    templates.remove(id);
    setTpls(templates.list());
  };

  // Turn a free-text class name into a valid, stable room id. Must satisfy
  // the server's isValidRoomId rule: /^[a-zA-Z0-9_-]+$/. Capped so the link
  // stays tidy and well within MAX_ROOM_ID_LENGTH.
  const slugifyCode = (s: string) =>
    s.trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);

  const createRoom = () => {
    const name = teacherName.trim();
    if (!name) return;
    localStorage.setItem("mathslive_teacher_name", name);
    // Use the teacher's chosen permanent code when given; otherwise fall back
    // to a fresh random id (the previous always-random behaviour).
    const custom = slugifyCode(classCode);
    const newRoomId = custom || uuidv4().slice(0, 8);
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

              {/* AUTONOMOUS: "My templates" panel — saved whiteboard
                  snapshots the teacher can re-instantiate as fresh
                  rooms. Hidden when empty so first-time users see the
                  clean landing page. Parallel structure & styling to
                  the saved-boards panel above. */}
              {tpls.length > 0 && (
                <div className="ml-dark-saved ml-dark-templates">
                  <div className="ml-dark-saved-head">
                    <span>My lesson templates</span>
                    <span className="ml-dark-saved-count">{tpls.length}</span>
                  </div>
                  <ul className="ml-dark-saved-list">
                    {tpls.slice(0, 6).map(t => (
                      <li key={t.id} className="ml-dark-saved-item">
                        <button
                          className="ml-dark-saved-open"
                          onClick={() => useTemplate(t)}
                          title={`Start a new class from "${t.name}"`}
                        >
                          <span className="ml-dark-saved-label">📐 {t.name}</span>
                          <span className="ml-dark-saved-meta">
                            template · saved {formatRelativeTime(t.savedAt)}
                          </span>
                        </button>
                        <button
                          className="ml-dark-saved-remove"
                          onClick={() => removeTemplate(t.id)}
                          aria-label={`Remove ${t.name}`}
                          title="Remove this template"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                  {tpls.length > 6 && (
                    <div className="ml-dark-saved-more">+{tpls.length - 6} more</div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Teacher form */}
          {mode === "teacher" && (
            <div className="ml-dark-form">
              {/* Auth gate: when Supabase is configured, teachers must sign in
                  before creating rooms. When it's off, this whole block is
                  skipped and the form behaves exactly as before. Students are
                  never affected — they use /live/:id and never reach here. */}
              {auth.enabled && !auth.user ? (
                auth.loading ? (
                  <div className="ml-dark-input" style={{ textAlign: "center", opacity: 0.7 }}>
                    Checking sign-in…
                  </div>
                ) : linkSent ? (
                  <div style={{ textAlign: "center", lineHeight: 1.6, padding: "8px 0" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Check your inbox ✉️</div>
                    <p style={{ fontSize: 13, opacity: 0.8 }}>
                      We sent a sign-in link to <strong>{loginEmail}</strong>. Open it on this
                      device to continue.
                    </p>
                    <button
                      className="ml-dark-btn ml-dark-btn-ghost"
                      onClick={() => { setLinkSent(false); setLoginError(null); }}
                      style={{ width: "100%", marginTop: 8 }}
                    >
                      Use a different email
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="email"
                      autoFocus
                      className="ml-dark-input"
                      placeholder="you@example.com"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && sendMagicLink()}
                    />
                    <button
                      className="ml-dark-btn ml-dark-btn-primary"
                      onClick={sendMagicLink}
                      disabled={!loginEmail.trim() || sendingLink}
                      style={{ width: "100%" }}
                    >
                      {sendingLink ? "Sending…" : "Email me a sign-in link"}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    </button>
                    {loginError && (
                      <p style={{ color: "#F87171", fontSize: 12.5, textAlign: "center" }}>{loginError}</p>
                    )}
                    <p style={{ fontSize: 12.5, opacity: 0.7, textAlign: "center", lineHeight: 1.5 }}>
                      Teachers sign in to manage their classes. Students don't
                      sign in — they just open the link you share.
                    </p>
                  </>
                )
              ) : auth.enabled && auth.user ? (
                <div style={{ textAlign: "center", lineHeight: 1.6, padding: "8px 0" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>You're signed in ✓</div>
                  <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>Taking you to your classes…</p>
                  <button
                    className="ml-dark-btn ml-dark-btn-primary"
                    onClick={() => navigate("/dashboard")}
                    style={{ width: "100%" }}
                  >
                    Go to my classes
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                  <button
                    className="ml-dark-btn ml-dark-btn-ghost"
                    onClick={() => auth.signOut()}
                    style={{ width: "100%", marginTop: 8 }}
                  >
                    Sign out{auth.user.email ? ` (${auth.user.email})` : ""}
                  </button>
                </div>
              ) : (
                <>
              <input
                autoFocus
                className="ml-dark-input"
                placeholder="What are you teaching today?"
                value={teacherName}
                onChange={(e) => setTeacherName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createRoom()}
              />
              <input
                className="ml-dark-input ml-dark-input-mono"
                placeholder="Permanent room code (optional) — e.g. varun-grade5"
                value={classCode}
                onChange={(e) => setClassCode(e.target.value)}
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
                </>
              )}
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
                placeholder="Room code (often your name)"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.trim())}
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
