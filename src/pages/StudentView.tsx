import React, { useEffect, useState, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { injectedSyncScript } from "../lib/syncScript";

interface FileEntry {
  id: string;
  name: string;
  html: string;
  uploadedAt: number;
}

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  message: string;
  timestamp: number;
}

interface Cursor {
  x: number;
  y: number;
  color: string;
  name: string;
}

const CURSOR_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#F43F5E", "#8B5CF6", "#EC4899"];

export default function StudentView() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const studentName = searchParams.get('name') || 'Student';

  // ── State ──
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [iframeUrl, setIframeUrl] = useState("");
  const [currentHtml, setCurrentHtml] = useState("");
  const [currentFileName, setCurrentFileName] = useState("");
  const [isPaused, setIsPaused] = useState(false);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [unreadChat, setUnreadChat] = useState(0);
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: string; x: number }>>([]);
  const [quizModal, setQuizModal] = useState<{ question: string } | null>(null);
  const [quizAnswer, setQuizAnswer] = useState("");
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [handUp, setHandUp] = useState(false);
  const [notification, setNotification] = useState("");
  const [spotlight, setSpotlight] = useState<{ x: number; y: number; active: boolean } | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const reactionIdRef = useRef(0);
  // Drawing
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Array<{points: Array<{x: number; y: number}>; color: string; width: number; time: number; transient?: boolean}>>([]);
  const drawAnimRef = useRef<number>();

  // ── Engagement Features ──
  const [laserPointer, setLaserPointer] = useState<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const [challengeTimer, setChallengeTimer] = useState<{ seconds: number; remaining: number } | null>(null);
  const challengeTimerRef = useRef<ReturnType<typeof setInterval>>();
  const [showCelebration, setShowCelebration] = useState(false);
  const [reactionCooldown, setReactionCooldown] = useState(false);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(""), 4000);
  };

  // ── Build iframe URL ──
  useEffect(() => {
    if (!currentHtml) {
      setIframeUrl("");
      return;
    }
    let content = currentHtml;
    if (content.includes("<head>")) {
      content = content.replace("<head>", "<head>" + injectedSyncScript);
    } else if (content.includes("<html>")) {
      content = content.replace("<html>", "<html><head>" + injectedSyncScript + "</head>");
    } else {
      content = injectedSyncScript + content;
    }
    const blob = new Blob([content], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    setIframeUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [currentHtml]);

  // ── Socket Connection ──
  useEffect(() => {
    if (!roomId) { navigate("/"); return; }

    const newSocket = io();
    setSocket(newSocket);

    newSocket.on("connect", () => {
      setConnected(true);
      newSocket.emit("join_room", { roomId, userName: studentName, role: 'student' });
    });

    newSocket.on("disconnect", () => {
      setConnected(false);
      showNotification("⚠️ Disconnected. Reconnecting...");
    });

    // On reconnect, automatically request fresh state
    newSocket.on("reconnect" as any, () => {
      setConnected(true);
      newSocket.emit("join_room", { roomId, userName: studentName, role: 'student' });
      showNotification("✅ Reconnected!");
    });

    newSocket.on("room_state", (state: any) => {
      setFiles(state.files || []);
      setActiveFileId(state.activeFileId);
      setIsPaused(state.isPaused);
      setChatMessages(state.chat || []);
      // Use lastRunHtml — this fixes late-join sync
      if (state.lastRunHtml) {
        const f = state.files?.find((f: FileEntry) => f.id === state.activeFileId);
        setCurrentFileName(f?.name || 'Simulation');
        setCurrentHtml(state.lastRunHtml);
      } else if (state.activeFileId && state.files) {
        const f = state.files.find((f: FileEntry) => f.id === state.activeFileId);
        if (f) {
          setCurrentFileName(f.name);
          setCurrentHtml(f.html);
        }
      }
    });

    newSocket.on("file_uploaded", (file: FileEntry) => {
      setFiles(prev => [...prev, file]);
      showNotification(`📄 Teacher uploaded: ${file.name}`);
    });

    // ──── FIXED: active_file_changed now includes html payload from server ────
    newSocket.on("active_file_changed", (data: { fileId: string; fileName?: string; html?: string }) => {
      setActiveFileId(data.fileId);
      if (data.html) {
        setCurrentFileName(data.fileName || 'Simulation');
        setCurrentHtml(data.html);
        showNotification(`📂 Switched to: ${data.fileName || 'new file'}`);
      }
    });

    newSocket.on("run_preview", ({ html }: { fileId: string; html: string }) => {
      setCurrentHtml(html);
    });

    // ──── FORCE SYNC: Server-authoritative state push ────
    newSocket.on("force_sync_state", (state: any) => {
      if (state.files) setFiles(state.files);
      if (state.activeFileId) setActiveFileId(state.activeFileId);
      if (state.lastRunHtml) {
        setCurrentHtml(state.lastRunHtml);
        const f = state.files?.find((f: FileEntry) => f.id === state.activeFileId);
        setCurrentFileName(f?.name || 'Simulation');
      }
      if (typeof state.isPaused === 'boolean') setIsPaused(state.isPaused);
      showNotification("🔄 Synced with teacher");
    });

    newSocket.on("file_deleted", ({ fileId, newActiveId }: { fileId: string; newActiveId: string | null }) => {
      setFiles(prev => prev.filter(f => f.id !== fileId));
      if (newActiveId) setActiveFileId(newActiveId);
    });

    newSocket.on("session_paused", () => {
      setIsPaused(true);
      showNotification("⏸ Teacher paused the session");
    });

    newSocket.on("session_resumed", () => {
      setIsPaused(false);
      showNotification("▶ Session resumed!");
    });

    newSocket.on("chat_message", (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
      if (!chatOpen) setUnreadChat(c => c + 1);
    });

    newSocket.on("reaction", ({ emoji, fromName, senderId }: { emoji: string; fromName: string; senderId: string }) => {
      const id = reactionIdRef.current++;
      const x = 15 + Math.random() * 70;
      setReactions(prev => [...prev, { id, emoji, x }]);
      setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 3000);
    });

    newSocket.on("quiz", ({ question }: { question: string }) => {
      setQuizModal({ question });
      setQuizAnswer("");
      setQuizSubmitted(false);
      showNotification("🎯 You have a question from your teacher!");
    });

    newSocket.on("spotlight", (data: { x: number; y: number; active: boolean }) => {
      setSpotlight(data.active ? data : null);
    });

    newSocket.on("user_left", (data: { userName: string }) => {
      if (data.userName && data.userName !== studentName) {
        showNotification(`${data.userName} left`);
      }
    });

    newSocket.on("interaction", (event: any) => {
      if (event.type === "SYNC_CURSOR") {
        setCursors(prev => ({
          ...prev,
          [event.userId]: {
            x: event.x, y: event.y,
            color: CURSOR_COLORS[event.userId.charCodeAt(0) % CURSOR_COLORS.length],
            name: event.userName || 'Teacher',
          },
        }));
      } else {
        if (iframeRef.current?.contentWindow) {
          const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
          iframeRef.current.contentWindow.postMessage(remoteEvent, "*");
        }
      }
    });

    // ── Laser Pointer ──
    newSocket.on("laser_pointer", (data: { x: number; y: number; active: boolean }) => {
      setLaserPointer(data);
    });

    // ── Challenge Timer ──
    newSocket.on("timer_started", ({ seconds }: { seconds: number }) => {
      setChallengeTimer({ seconds, remaining: seconds });
    });
    newSocket.on("timer_stopped", () => {
      setChallengeTimer(null);
      if (challengeTimerRef.current) clearInterval(challengeTimerRef.current);
    });

    // ── Celebration ──
    newSocket.on("celebration", () => {
      setShowCelebration(true);
      setTimeout(() => setShowCelebration(false), 4000);
    });

    return () => { newSocket.disconnect(); };
  }, [roomId, navigate, studentName]);

  // ── Relay iframe messages to socket ──
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!socket || !e.data?.type?.startsWith("SYNC_")) return;
      socket.emit("interaction", { roomId, event: e.data });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [socket, roomId]);

  // ── Auto-scroll chat ──
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ── Drawing: render strokes on canvas ──
  const renderDrawing = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width * 2 || canvas.height !== rect.height * 2) {
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      ctx.scale(2, 2);
    }
    ctx.clearRect(0, 0, rect.width, rect.height);
    const now = Date.now();
    const w = rect.width;
    const h = rect.height;
    strokesRef.current = strokesRef.current.filter(s => {
      const maxAge = s.transient ? 1000 : 6000;
      return (now - s.time) < maxAge;
    });
    strokesRef.current.forEach(stroke => {
      const age = now - stroke.time;
      const fadeStart = stroke.transient ? 200 : 4000;
      const fadeDuration = stroke.transient ? 800 : 2000;
      const alpha = age > fadeStart ? 1 - (age - fadeStart) / fadeDuration : 1;
      if (alpha <= 0) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = stroke.color;
      ctx.shadowBlur = stroke.transient ? 20 : 14;
      ctx.beginPath();
      stroke.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    });
    ctx.globalAlpha = 1;
  };

  // Drawing animation loop
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      if (strokesRef.current.length > 0) renderDrawing();
      drawAnimRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; if (drawAnimRef.current) cancelAnimationFrame(drawAnimRef.current); };
  }, []);

  // ── Challenge Timer Countdown ──
  useEffect(() => {
    if (!challengeTimer) return;
    if (challengeTimerRef.current) clearInterval(challengeTimerRef.current);
    challengeTimerRef.current = setInterval(() => {
      setChallengeTimer(prev => {
        if (!prev || prev.remaining <= 1) {
          clearInterval(challengeTimerRef.current);
          return null;
        }
        return { ...prev, remaining: prev.remaining - 1 };
      });
    }, 1000);
    return () => { if (challengeTimerRef.current) clearInterval(challengeTimerRef.current); };
  }, [challengeTimer?.seconds]);

  // Receive drawing events
  useEffect(() => {
    if (!socket) return;
    const handleStroke = (data: { points: Array<{x:number;y:number}>; color: string; width: number; transient?: boolean }) => {
      strokesRef.current.push({ ...data, time: Date.now() });
      renderDrawing();
    };
    const handleClear = () => { strokesRef.current = []; renderDrawing(); };
    socket.on('draw_stroke', handleStroke);
    socket.on('draw_clear', handleClear);
    return () => { socket.off('draw_stroke', handleStroke); socket.off('draw_clear', handleClear); };
  }, [socket]);

  // ── Handlers ──
  const raiseHand = () => {
    if (!socket || handUp) return;
    socket.emit("raise_hand", { roomId, studentName });
    setHandUp(true);
    setTimeout(() => setHandUp(false), 5000);
  };

  const sendReaction = (emoji: string, label: string) => {
    if (!socket || reactionCooldown) return;
    socket.emit("student_reaction", { roomId, emoji, label, studentName });

    const id = reactionIdRef.current++;
    const x = 15 + Math.random() * 70;
    setReactions(prev => [...prev, { id, emoji, x }]);
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 3000);

    setReactionCooldown(true);
    setTimeout(() => setReactionCooldown(false), 2000);
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!socket || !chatInput.trim()) return;
    socket.emit("send_chat", { roomId, message: chatInput.trim(), userName: studentName });
    setChatInput("");
  };

  const submitQuizAnswer = () => {
    if (!socket || !quizAnswer.trim()) return;
    socket.emit("quiz_answer", { roomId, answer: quizAnswer.trim(), studentName });
    setQuizSubmitted(true);
  };

  const toggleChat = () => {
    setChatOpen(!chatOpen);
    if (!chatOpen) setUnreadChat(0);
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-primary)' }}>

      {/* ══════ HEADER BAR ══════ */}
      <header className="flex items-center justify-between px-5 shrink-0"
        style={{ height: '52px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>

        <div className="flex items-center gap-4">
          <span className="text-lg">🧮</span>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
            <span className="text-[13px] font-display font-semibold" style={{ color: 'var(--text-primary)' }}>
              {currentFileName || 'MathsLive'}
            </span>
            <div className={`connection-dot ${connected ? 'online' : 'offline'}`}
              style={{ width: 7, height: 7 }} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Raise Hand */}
          <button onClick={raiseHand}
            className={`btn text-[12px] ${handUp ? 'animate-hand-wave btn-toolbar-active' : ''}`}>
            {handUp ? '✋ Hand Raised' : '✋ Raise Hand'}
          </button>

          {/* Chat Toggle */}
          <button onClick={toggleChat}
            className={`btn text-[12px] relative ${chatOpen ? 'btn-toolbar-active' : ''}`}>
            💬 Chat
            {unreadChat > 0 && (
              <span className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white animate-bounce-in"
                style={{ background: 'var(--accent-rose)', boxShadow: '0 2px 6px rgba(244,63,94,0.4)' }}>
                {unreadChat}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* ══════ MAIN AREA ══════ */}
      <div className="flex-1 flex overflow-hidden relative">

        {/* Full-Screen Iframe */}
        <div className="flex-1 relative">
          {iframeUrl ? (
            <iframe
              ref={iframeRef}
              src={iframeUrl}
              className="w-full h-full border-none"
              style={{ background: '#ffffff' }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock"
            />
          ) : (
            <div className="flex items-center justify-center h-full" style={{ background: 'var(--bg-primary)' }}>
              <div className="text-center animate-slide-up p-12 rounded-2xl"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-lg)' }}>
                <div className="text-5xl mb-5 animate-gentle-bounce">⏳</div>
                <h2 className="font-display text-2xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Waiting for teacher...</h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)', lineHeight: '1.6' }}>
                  Your teacher will load a simulation shortly.
                </p>
                <div className="flex items-center justify-center gap-2 mt-6">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="w-2 h-2 rounded-full"
                      style={{ background: 'var(--accent-indigo)', animation: `dot-pulse 1.5s ease-in-out infinite`, animationDelay: `${i * 0.3}s` }} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Drawing Canvas Overlay */}
          <canvas ref={drawCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 10 }} />

          {/* Teacher Cursor Overlay */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 11 }}>
            {(Object.entries(cursors) as [string, Cursor][]).map(([id, cursor]) => (
              <div key={id} className="absolute transition-all duration-100 ease-linear"
                style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, transform: 'translate(-2px, -2px)' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill={cursor.color} xmlns="http://www.w3.org/2000/svg">
                  <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.86a.5.5 0 0 0-.85.35Z"
                    stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
                <span className="absolute left-5 top-3 whitespace-nowrap px-2 py-0.5 rounded-full text-white shadow-lg"
                  style={{ background: cursor.color, fontSize: '11px', fontWeight: 700 }}>
                  {cursor.name}
                </span>
              </div>
            ))}
          </div>

          {/* Spotlight Overlay */}
          {spotlight && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute w-20 h-20 rounded-full border-4 animate-pulse-glow"
                style={{
                  left: `${spotlight.x * 100}%`, top: `${spotlight.y * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  borderColor: 'var(--accent-amber)',
                  boxShadow: '0 0 30px rgba(245,158,11,0.3)',
                }} />
            </div>
          )}

          {/* Laser Pointer Overlay */}
          {laserPointer.active && (
            <div className="absolute inset-0 pointer-events-none z-20">
              <div className="absolute w-4 h-4 rounded-full"
                style={{
                  left: `${laserPointer.x * 100}%`, top: `${laserPointer.y * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  background: 'rgba(239,68,68,0.9)',
                  boxShadow: '0 0 12px 6px rgba(239,68,68,0.6)',
                  animation: 'laser-pulse 1s infinite',
                }} />
            </div>
          )}

          {/* Challenge Timer Overlay */}
          {challengeTimer && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none z-30 animate-bounce-in">
              <div className="flex items-center gap-3 px-5 py-2.5 rounded-xl" style={{
                background: challengeTimer.remaining <= 10 ? 'rgba(244,63,94,0.95)' : 'rgba(17,24,39,0.9)',
                backdropFilter: 'blur(10px)', boxShadow: 'var(--shadow-xl)',
                animation: challengeTimer.remaining <= 5 ? 'pulse 0.5s ease-in-out infinite' : 'none',
              }}>
                <span className="text-xl">⏳</span>
                <span className="text-2xl font-black text-white tabular-nums">{challengeTimer.remaining}s</span>
              </div>
            </div>
          )}

          {/* Celebration Confetti */}
          {showCelebration && (
            <div className="absolute inset-0 pointer-events-none z-40 overflow-hidden">
              {Array.from({ length: 80 }).map((_, i) => (
                <div key={i} className="absolute" style={{
                  left: `${Math.random() * 100}%`, top: '-10%',
                  width: `${6 + Math.random() * 8}px`, height: `${6 + Math.random() * 8}px`,
                  background: ['#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6', '#EC4899', '#0EA5E9', '#F97316'][i % 8],
                  borderRadius: Math.random() > 0.5 ? '50%' : '2px',
                  animation: `confetti-fall ${2 + Math.random() * 2.5}s ease-in forwards`,
                  animationDelay: `${Math.random() * 0.5}s`,
                  transform: `rotate(${Math.random() * 360}deg)`,
                }} />
              ))}
            </div>
          )}

          {/* Quick Reactions Bar */}
          {iframeUrl && !isPaused && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 animate-slide-up">
              <div className="flex items-center gap-1.5 px-3 py-2 rounded-2xl"
                style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(12px)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-lg)' }}>
                {[
                  { emoji: '✅', label: 'Got it!' },
                  { emoji: '😕', label: 'Confused' },
                  { emoji: '🐌', label: 'Slow down' },
                  { emoji: '🤯', label: 'Mind blown' },
                ].map(r => (
                  <button key={r.emoji} onClick={() => sendReaction(r.emoji, r.label)} disabled={reactionCooldown}
                    className="px-3 py-1.5 rounded-xl active:scale-95 transition-all text-sm font-semibold flex items-center gap-1"
                    style={{ color: 'var(--text-primary)', background: 'transparent' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {r.emoji} <span className="hidden sm:inline text-[12px]" style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Floating Reactions */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
            {reactions.map(r => (
              <div key={r.id}
                className="absolute"
                style={{
                  left: `${r.x}%`,
                  bottom: '15%',
                  fontSize: '48px',
                  animation: 'reaction-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards, reaction-float-up 3s ease-out 0.4s forwards',
                }}>
                {r.emoji}
              </div>
            ))}
          </div>

          {/* Paused Overlay */}
          {isPaused && (
            <div className="absolute inset-0 flex items-center justify-center animate-fade-in z-30"
              style={{ background: 'rgba(249,250,251,0.9)', backdropFilter: 'blur(8px)' }}>
              <div className="text-center animate-bounce-in">
                <div className="text-6xl mb-4">⏸</div>
                <h2 className="font-display text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Session Paused</h2>
                <p className="text-base" style={{ color: 'var(--text-secondary)' }}>
                  Your teacher is explaining something...
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Chat Panel */}
        {chatOpen && (
          <div className="flex flex-col shrink-0 animate-slide-in-right"
            style={{ width: '280px', background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center justify-between px-3 py-2.5 shrink-0"
              style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <span className="badge badge-indigo text-[10px]">💬 CHAT</span>
              <button onClick={() => setChatOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
              {chatMessages.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-3xl mb-2">💬</div>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No messages yet</p>
                </div>
              ) : chatMessages.map(msg => (
                <div key={msg.id} className="animate-fade-in">
                  <div className="text-[10px] font-bold mb-0.5"
                    style={{ color: msg.userName === studentName ? 'var(--accent-emerald)' : 'var(--accent-indigo)' }}>
                    {msg.userName}
                  </div>
                  <div className="text-sm px-3 py-2 rounded-xl"
                    style={{
                      background: msg.userName === studentName ? 'var(--accent-indigo-light)' : 'var(--bg-surface)',
                      color: 'var(--text-primary)',
                      borderRadius: msg.userName === studentName ? '12px 12px 4px 12px' : '4px 12px 12px 12px',
                    }}>
                    {msg.message}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={sendChat} className="p-3 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div className="flex gap-2">
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Type a message..."
                  className="input-field text-sm" style={{ padding: '8px 12px' }} />
                <button type="submit" className="btn-primary" style={{ padding: '8px 12px', fontSize: '14px' }}>
                  ↑
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* ══════ NOTIFICATION TOAST ══════ */}
      {notification && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 animate-slide-down">
          <div className="px-5 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-lg)', maxWidth: '90vw' }}>
            {notification}
          </div>
        </div>
      )}

      {/* ══════ QUIZ MODAL ══════ */}
      {quizModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-md animate-bounce-in"
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="p-6">
              <div className="text-center mb-5">
                <div className="text-4xl mb-3 animate-reaction-pop">🎯</div>
                <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Pop Quiz!</h3>
              </div>
              <div className="p-4 rounded-xl mb-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-base font-medium text-center" style={{ color: 'var(--text-primary)', lineHeight: 1.6 }}>
                  {quizModal.question}
                </p>
              </div>
              {!quizSubmitted ? (
                <>
                  <textarea
                    value={quizAnswer}
                    onChange={(e) => setQuizAnswer(e.target.value)}
                    placeholder="Type your answer here..."
                    className="input-field mb-4"
                    autoFocus
                    style={{ minHeight: '80px', resize: 'vertical' }}
                  />
                  <div className="flex gap-3">
                    <button onClick={() => setQuizModal(null)} className="btn-secondary flex-1">Skip</button>
                    <button onClick={submitQuizAnswer} disabled={!quizAnswer.trim()}
                      className="btn-primary flex-1 disabled:opacity-40">
                      Submit Answer
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-center py-4">
                  <div className="text-4xl mb-2 animate-bounce-in">✅</div>
                  <p className="text-sm font-medium" style={{ color: 'var(--accent-emerald)' }}>Answer submitted!</p>
                  <button onClick={() => setQuizModal(null)} className="btn-secondary mt-4">Close</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
