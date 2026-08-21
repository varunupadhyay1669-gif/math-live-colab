import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { savedBoards, templates, type SavedBoard, type LessonTemplate } from "../lib/prefs";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/passcode";

type Mode = null | "teacher" | "student" | "deploy";

// The server answers with machine-readable codes; a person should never be
// shown one. "passcode_required" appearing verbatim under the Deploy button —
// with no field to type a passcode into — is what sent someone looking for a
// bug in their HTML.
function deployErrorText(code: unknown, status: number): string {
  if (typeof code === "string" && code) {
    if (code === "passcode_required") return "This site needs an access code — enter it above and deploy again.";
    // Anything else the server chose to word for a human (size limits, empty
    // HTML) is already a sentence; pass it through rather than burying it.
    if (/[ .]/.test(code)) return code;
  }
  return `Deploy failed (${status}).`;
}

// Where a half-written deploy waits out the passcode prompt.
//
// The prompt replaces the whole app while it is up, so the Home page unmounts
// and takes any pasted HTML with it. Losing a lesson you just pasted because
// you were asked for a code is a poor trade; this survives it. sessionStorage,
// not localStorage — it belongs to this tab and this sitting.
const DEPLOY_DRAFT = "mathslive:deploy-draft";
function readDeployDraft(): { html: string; name: string } {
  try {
    const raw = sessionStorage.getItem(DEPLOY_DRAFT);
    if (!raw) return { html: "", name: "" };
    const d = JSON.parse(raw) as { html?: unknown; name?: unknown };
    return { html: typeof d.html === "string" ? d.html : "", name: typeof d.name === "string" ? d.name : "" };
  } catch { return { html: "", name: "" }; }
}

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

// Storage can throw in embedded/sandboxed contexts (SecurityError) — a raw
// localStorage call in a render-phase initializer took down the whole landing
// page there. These never throw.
const safeStorageGet = (key: string): string => {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
};
const safeStorageSet = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* storage blocked — non-fatal */ }
};

export default function Home() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [teacherName, setTeacherName] = useState(() => safeStorageGet("mathslive_teacher_name"));

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
  const [teacherSubMode, setTeacherSubMode] = useState<"login" | "quick">("login");

  const sendMagicLink = async () => {
    const email = loginEmail.trim();
    if (!email || sendingLink) return;
    setSendingLink(true);
    setLoginError(null);
    try {
      if (!auth.enabled) {
        setLoginError('Supabase is not connected yet. Please add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or SUPABASE_URL and SUPABASE_ANON_KEY) in app Settings → Environment Variables.');
        return;
      }
      const { error } = await auth.signInWithEmail(email);
      if (error) setLoginError(error);
      else setLinkSent(true);
    } catch {
      setLoginError('Could not reach the sign-in service. Check your connection and try again.');
    } finally {
      setSendingLink(false);
    }
  };
  const [mode, setMode] = useState<Mode>(null);

  // ── Quick Deploy: drop HTML → instant shareable page (no login, 24h) ──
  const [deployTab, setDeployTab] = useState<"paste" | "upload">("paste");
  const [deployHtml, setDeployHtml] = useState(() => readDeployDraft().html);
  const [deployName, setDeployName] = useState(() => readDeployDraft().name);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployedId, setDeployedId] = useState<string | null>(null);
  const [deployCopied, setDeployCopied] = useState(false);

  // Mirror the draft as it is typed, so an interruption cannot lose it.
  useEffect(() => {
    try {
      if (deployHtml || deployName) sessionStorage.setItem(DEPLOY_DRAFT, JSON.stringify({ html: deployHtml, name: deployName }));
      else sessionStorage.removeItem(DEPLOY_DRAFT);
    } catch { /* full or private mode — the draft is a convenience, not the work */ }
  }, [deployHtml, deployName]);

  const publishHtml = async () => {
    const html = deployHtml;
    if (!html.trim() || deploying) return;
    setDeploying(true);
    setDeployError(null);
    try {
      // apiFetch, not fetch: /api/publish is passcode-gated, and a plain fetch
      // never sent the code — so wherever a SITE_PASSCODE is set this button
      // could only fail. apiFetch also re-arms the passcode prompt on a 401,
      // which is the only way to supply a code you were never asked for.
      const res = await apiFetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, name: deployName.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setDeployError(deployErrorText(data?.error, res.status)); return; }
      setDeployedId(data.id);
      // Published — the draft has served its purpose.
      try { sessionStorage.removeItem(DEPLOY_DRAFT); } catch { /* noop */ }
    } catch {
      setDeployError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setDeploying(false);
    }
  };

  const onDeployFile = (file: File | null | undefined) => {
    if (!file) return;
    setDeployError(null);
    if (file.size > 16 * 1024 * 1024) { setDeployError("File too large (max 16MB)."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      setDeployHtml(String(reader.result || ""));
      setDeployName(file.name.replace(/\.html?$/i, ""));
    };
    reader.onerror = () => setDeployError("Couldn't read that file.");
    reader.readAsText(file);
  };

  // Opening the panel should clear the LAST RESULT — nobody wants to land on
  // the previous "deployed" success screen — but not the HTML sitting in the
  // box. That distinction matters once a draft can survive the passcode prompt:
  // clearing everything here threw the restored draft away on the way back in,
  // which looked exactly like the restore never happened.
  const resetDeployResult = () => {
    setDeployedId(null); setDeployError(null); setDeployCopied(false);
  };
  // "Deploy another" — a deliberate fresh start, so the box empties too.
  const resetDeploy = () => {
    resetDeployResult(); setDeployHtml(""); setDeployName("");
    try { sessionStorage.removeItem(DEPLOY_DRAFT); } catch { /* noop */ }
  };
  const deployedUrl = deployedId ? `${window.location.origin}/p/${deployedId}` : "";
  const copyDeployed = async () => {
    if (!deployedUrl) return;
    try { await navigator.clipboard.writeText(deployedUrl); setDeployCopied(true); setTimeout(() => setDeployCopied(false), 1800); } catch { /* blocked */ }
  };

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
    const stored = safeStorageGet("mathslive_teacher_name").trim();
    const name = stored || (window.prompt("What are you teaching today?") || "").trim();
    if (!name) return;
    safeStorageSet("mathslive_teacher_name", name);
    const newRoomId = uuidv4().slice(0, 8);
    navigate(`/room/${newRoomId}?name=${encodeURIComponent(name)}&template=${encodeURIComponent(tpl.id)}`);
  };
  const removeTemplate = (id: string) => {
    templates.remove(id);
    setTpls(templates.list());
  };

  // Turn a free-text class name into a valid, stable room id. Must satisfy
  // the server's isValidRoomId rule: /^[a-zA-Z0-9_-]+$/ AND length <= 20
  // (MAX_ROOM_ID_LENGTH). The previous 32-char cap produced codes the server
  // rejected on join — a custom code of 21-32 chars created a dead /room link.
  const slugifyCode = (s: string) =>
    s.trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20);

  const createRoom = () => {
    const name = teacherName.trim();
    if (!name) return;
    safeStorageSet("mathslive_teacher_name", name);
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {auth.user ? (
              <button
                className="ml-dark-btn ml-dark-btn-glass"
                onClick={() => navigate('/dashboard')}
                style={{ fontSize: 13, padding: '5px 14px' }}
              >
                Dashboard ({auth.user.email})
              </button>
            ) : (
              <button
                className="ml-dark-btn ml-dark-btn-glass"
                onClick={() => { setMode('teacher'); setTeacherSubMode('login'); }}
                style={{ fontSize: 13, padding: '5px 14px' }}
              >
                Sign in with email
              </button>
            )}
            <span className="ml-dark-pill">
              <span className="dot" />
              Live
            </span>
          </div>
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

              {/* Quick Deploy — drop HTML, get an instant shareable link. No
                  login, no delay, live for 24h. Perfect for AI-generated pages,
                  demos and prototypes. */}
              <button
                className="ml-dark-btn ml-dark-btn-glass ml-dark-deploy-cta"
                onClick={() => { resetDeployResult(); setMode("deploy"); }}
                style={{ width: "100%", justifyContent: "center", marginTop: 2 }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
                </svg>
                Quick deploy HTML — paste or upload, get an instant link
              </button>

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

              {/* Quiet capability strip — what makes this different, in one
                  glance. Pure presentation; chips are not buttons. */}
              <ul className="ml-dark-features" aria-label="Platform capabilities">
                <li className="ml-dark-feature">
                  <span className="ml-dark-feature-icon" aria-hidden="true">✋</span>
                  <span><strong>Hand the chalk</strong><em>one student drives, you take it back anytime</em></span>
                </li>
                <li className="ml-dark-feature">
                  <span className="ml-dark-feature-icon" aria-hidden="true">👁️</span>
                  <span><strong>See every screen</strong><em>peek at any student's live view</em></span>
                </li>
                <li className="ml-dark-feature">
                  <span className="ml-dark-feature-icon" aria-hidden="true">⏪</span>
                  <span><strong>Rewind the lesson</strong><em>bookmark moments, jump the whole class back</em></span>
                </li>
                <li className="ml-dark-feature">
                  <span className="ml-dark-feature-icon" aria-hidden="true">⚡</span>
                  <span><strong>Late joiners catch up</strong><em>sims replay the class automatically</em></span>
                </li>
              </ul>
            </>
          )}

          {/* Teacher form */}
          {mode === "teacher" && (
            <div className="ml-dark-form">
              {auth.user ? (
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
                  <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                    <button
                      type="button"
                      className={`ml-dark-btn ${teacherSubMode === "login" ? "ml-dark-btn-primary" : "ml-dark-btn-ghost"}`}
                      onClick={() => setTeacherSubMode("login")}
                      style={{ flex: 1, padding: "6px 10px", fontSize: 12.5 }}
                    >
                      ✉️ Teacher Sign In
                    </button>
                    <button
                      type="button"
                      className={`ml-dark-btn ${teacherSubMode === "quick" ? "ml-dark-btn-primary" : "ml-dark-btn-ghost"}`}
                      onClick={() => setTeacherSubMode("quick")}
                      style={{ flex: 1, padding: "6px 10px", fontSize: 12.5 }}
                    >
                      ⚡ Instant Session
                    </button>
                  </div>

                  {teacherSubMode === "login" ? (
                    linkSent ? (
                      <div style={{ textAlign: "center", lineHeight: 1.6, padding: "8px 0" }}>
                        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Check your inbox ✉️</div>
                        <p style={{ fontSize: 13, opacity: 0.8 }}>
                          We sent a sign-in link to <strong>{loginEmail}</strong>. Open it on this device to continue.
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
                          <div style={{ color: "#F87171", fontSize: 12.5, textAlign: "center", lineHeight: 1.4, padding: "6px 8px", background: "rgba(248, 113, 113, 0.12)", borderRadius: 6 }}>
                            {loginError}
                          </div>
                        )}
                        <p style={{ fontSize: 12, opacity: 0.7, textAlign: "center", lineHeight: 1.5 }}>
                          Enter your email to sign in or register as a teacher.
                        </p>
                      </>
                    )
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

          {/* Quick Deploy panel */}
          {mode === "deploy" && (
            <div className="ml-dark-form ml-dark-deploy">
              {!deployedId ? (
                <>
                  <div className="ml-dark-deploy-head">
                    <div className="ml-dark-deploy-title">Drop HTML, get a live link</div>
                    <div className="ml-dark-deploy-sub">Paste code or upload a file — instant, no sign-in, live for 24 hours.</div>
                  </div>

                  <div className="ml-dark-deploy-tabs" role="tablist">
                    <button
                      role="tab"
                      aria-selected={deployTab === "paste"}
                      className={`ml-dark-deploy-tab${deployTab === "paste" ? " is-active" : ""}`}
                      onClick={() => setDeployTab("paste")}
                    >
                      Paste code
                    </button>
                    <button
                      role="tab"
                      aria-selected={deployTab === "upload"}
                      className={`ml-dark-deploy-tab${deployTab === "upload" ? " is-active" : ""}`}
                      onClick={() => setDeployTab("upload")}
                    >
                      Upload file
                    </button>
                  </div>

                  {deployTab === "paste" ? (
                    <textarea
                      autoFocus
                      className="ml-dark-input ml-dark-input-mono ml-dark-deploy-textarea"
                      placeholder="Paste your HTML here — <!doctype html>…"
                      value={deployHtml}
                      onChange={(e) => setDeployHtml(e.target.value)}
                      spellCheck={false}
                    />
                  ) : (
                    <label
                      className="ml-dark-deploy-drop"
                      onDragOver={(e) => { e.preventDefault(); }}
                      onDrop={(e) => { e.preventDefault(); onDeployFile(e.dataTransfer.files?.[0]); }}
                    >
                      <input
                        type="file"
                        accept=".html,.htm,text/html"
                        style={{ display: "none" }}
                        onChange={(e) => onDeployFile(e.target.files?.[0])}
                      />
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
                      </svg>
                      <span className="ml-dark-deploy-drop-main">
                        {deployHtml ? `✓ ${deployName || "file"}.html loaded` : "Drop an HTML file here, or click to choose"}
                      </span>
                      <span className="ml-dark-deploy-drop-sub">Max 16MB · .html</span>
                    </label>
                  )}

                  {deployError && <p className="ml-dark-deploy-error">{deployError}</p>}

                  <button
                    className="ml-dark-btn ml-dark-btn-primary"
                    onClick={publishHtml}
                    disabled={!deployHtml.trim() || deploying}
                    style={{ width: "100%" }}
                  >
                    {deploying ? "Deploying…" : "Deploy now"}
                    {!deploying && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    )}
                  </button>
                </>
              ) : (
                <div className="ml-dark-deploy-done">
                  <div className="ml-dark-deploy-done-badge">✓ Live</div>
                  <div className="ml-dark-deploy-title">Your page is deployed</div>
                  <div className="ml-dark-deploy-linkrow">
                    <input className="ml-dark-input ml-dark-input-mono" readOnly value={deployedUrl} onFocus={(e) => e.target.select()} />
                    <button className="ml-dark-btn ml-dark-btn-glass" onClick={copyDeployed} style={{ flex: "0 0 auto" }}>
                      {deployCopied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                  <div className="ml-dark-deploy-actions">
                    <a className="ml-dark-btn ml-dark-btn-primary" href={deployedUrl} target="_blank" rel="noreferrer" style={{ flex: 1, textDecoration: "none" }}>
                      Open page
                    </a>
                    <button className="ml-dark-btn ml-dark-btn-glass" onClick={() => navigate(`/room/${deployedId}?name=${encodeURIComponent("Host")}`)} style={{ flex: 1 }}>
                      Open as live class
                    </button>
                  </div>
                  <div className="ml-dark-deploy-sub" style={{ textAlign: "center" }}>Live for 24 hours · anyone with the link can view</div>
                  <button className="ml-dark-btn ml-dark-btn-ghost" onClick={resetDeploy} style={{ width: "100%" }}>
                    Deploy another
                  </button>
                </div>
              )}

              <div className="ml-dark-back-row">
                <button className="ml-dark-btn ml-dark-btn-ghost" onClick={() => setMode(null)}>← Back</button>
              </div>
            </div>
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
