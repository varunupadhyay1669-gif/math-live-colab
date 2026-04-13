import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { injectedSyncScript } from "../lib/syncScript";
import { stepLockScript } from "../lib/stepLockScript";
import { setupAttentionDetection } from "../lib/attentionDetector";
import { sounds } from "../lib/sounds";

// ── Components ──
import ChatPanel from "../components/ChatPanel";
import StudentReactions from "../components/StudentReactions";
import PausedOverlay from "../components/PausedOverlay";
import TimerDisplay from "../components/TimerDisplay";
import Celebrations from "../components/Celebrations";
import CursorOverlay from "../components/CursorOverlay";
import AnnotationLayer from "../components/AnnotationLayer";
import StepGate from "../components/StepGate";
import ConnectionStatus from "../components/ConnectionStatus";

// ── Types ──
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

interface GateData {
  question: string;
  options: string[];
  correctIndex: number;
}

const CURSOR_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#F43F5E", "#8B5CF6", "#EC4899"];

export default function StudentView() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const studentName = searchParams.get('name') || 'Student';

  // ── Core State ──
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [iframeUrl, setIframeUrl] = useState("");
  const [currentHtml, setCurrentHtml] = useState("");
  const [currentFileName, setCurrentFileName] = useState("");
  const [isPaused, setIsPaused] = useState(false);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});

  // ── Chat ──
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);

  // ── Reactions ──
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: string; x: number }>>([]);
  const reactionIdRef = useRef(0);

  // ── Quiz ──
  const [quizModal, setQuizModal] = useState<{ question: string } | null>(null);
  const [quizAnswer, setQuizAnswer] = useState("");
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  // ── Misc ──
  const [notification, setNotification] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  // ── Engagement ──
  const [laserPointer, setLaserPointer] = useState<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const [challengeTimer, setChallengeTimer] = useState<{ seconds: number; remaining: number } | null>(null);
  const challengeTimerRef = useRef<ReturnType<typeof setInterval>>();
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationType, setCelebrationType] = useState<'confetti' | 'fireworks' | 'stars'>('confetti');
  const [spotlight, setSpotlight] = useState<{ x: number; y: number; active: boolean } | null>(null);

  // ── Step-Lock ──
  const [currentStep, setCurrentStep] = useState(999);
  const [gateModal, setGateModal] = useState<{ step: number; gate: GateData } | null>(null);

  // ── Scroll Sync ──
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(true);

  // ── Sound ──
  const [soundMuted, setSoundMuted] = useState(false);

  // ── Iframe readiness ──
  const iframeReadyRef = useRef(false);
  const pendingMessagesRef = useRef<any[]>([]);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(""), 4000);
  };

  // ── Build iframe URL ──
  useEffect(() => {
    if (!currentHtml) { setIframeUrl(""); return; }
    // Mark iframe as not ready while we rebuild it
    iframeReadyRef.current = false;
    let content = currentHtml;
    const scripts = injectedSyncScript + stepLockScript;
    if (content.includes("<head>")) {
      content = content.replace("<head>", "<head>" + scripts);
    } else if (content.includes("<html>")) {
      content = content.replace("<html>", "<html><head>" + scripts + "</head>");
    } else {
      content = scripts + content;
    }
    const blob = new Blob([content], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    setIframeUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [currentHtml]);

  // ── Socket Connection ──
  useEffect(() => {
    if (!roomId) { navigate("/"); return; }

    const newSocket = io();
    setSocket(newSocket);

    let cleanupAttention: (() => void) | null = null;

    newSocket.on("connect", () => {
      setConnected(true);
      newSocket.emit("join_room", { roomId, userName: studentName, role: 'student' });
      // Start attention detection
      cleanupAttention = setupAttentionDetection(newSocket, roomId, studentName);
    });

    newSocket.on("disconnect", () => {
      setConnected(false);
      showNotification("⚠️ Disconnected. Reconnecting...");
    });

    newSocket.on("reconnect" as any, () => {
      setConnected(true);
      newSocket.emit("join_room", { roomId, userName: studentName, role: 'student' });
      showNotification("✅ Reconnected!");
    });

    newSocket.on("room_state", (state: any) => {
      setFiles(state.files || []);
      setActiveFileId(state.activeFileId);
      setIsPaused(state.isPaused);
      if (typeof state.scrollSyncEnabled === 'boolean') setScrollSyncEnabled(state.scrollSyncEnabled);
      setChatMessages(state.chat || []);
      if (state.lastRunHtml) {
        const f = state.files?.find((f: FileEntry) => f.id === state.activeFileId);
        setCurrentFileName(f?.name || 'Simulation');
        setCurrentHtml(state.lastRunHtml);
      } else if (state.activeFileId && state.files) {
        const f = state.files.find((f: FileEntry) => f.id === state.activeFileId);
        if (f) { setCurrentFileName(f.name); setCurrentHtml(f.html); }
      }
    });

    newSocket.on("file_uploaded", (file: FileEntry) => {
      setFiles(prev => [...prev, file]);
      showNotification(`📄 Teacher uploaded: ${file.name}`);
      sounds.join();
    });

    newSocket.on("active_file_changed", (data: { fileId: string; fileName?: string; html?: string }) => {
      setActiveFileId(data.fileId);
      if (data.html) {
        setCurrentFileName(data.fileName || 'Simulation');
        setCurrentHtml(data.html);
        showNotification(`📂 Switched to: ${data.fileName || 'new file'}`);
      }
    });

    newSocket.on("run_preview", ({ html }: { fileId: string; html: string }) => setCurrentHtml(html));

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
      sounds.message();
    });

    newSocket.on("reaction", ({ emoji }: { emoji: string }) => {
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
      sounds.raiseHand();
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
        const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
        postToIframe(remoteEvent);
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
    newSocket.on("celebration", ({ type }: { type?: string }) => {
      setCelebrationType((type as any) || 'confetti');
      setShowCelebration(true);
      sounds.celebration();
      setTimeout(() => setShowCelebration(false), 4000);
    });

    // ── Step-Lock ──
    newSocket.on("step_changed", ({ step }: { step: number }) => {
      setCurrentStep(step);
      postToIframe({ type: 'SET_STEP', step });
    });

    newSocket.on("gate_added", ({ step }: { step: number }) => {
      showNotification(`🚧 Checkpoint added at Step ${step}`);
    });

    // ── Scroll Sync ──
    newSocket.on("scroll_sync_changed", ({ enabled }: { enabled: boolean }) => {
      setScrollSyncEnabled(enabled);
      showNotification(enabled ? '🔗 Scroll sync enabled' : '🔓 Free scroll — you can scroll independently');
    });

    // ── Kick ──
    newSocket.on("kicked", () => {
      showNotification("You have been removed from the session");
      setTimeout(() => navigate("/"), 2000);
    });

    return () => {
      cleanupAttention?.();
      newSocket.disconnect();
    };
  }, [roomId, navigate, studentName]);

  // ── Helper: safely post message to iframe (queues if not ready) ──
  const postToIframe = useCallback((msg: any) => {
    if (iframeReadyRef.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(msg, '*');
    } else {
      pendingMessagesRef.current.push(msg);
    }
  }, []);

  // ── Iframe onLoad: flush pending messages ──
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    // Flush pending messages
    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    for (const msg of pending) {
      iframeRef.current?.contentWindow?.postMessage(msg, '*');
    }
    // Re-send current state
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled }, '*');
    if (currentStep < 999) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_STEP', step: currentStep }, '*');
    }
  }, [scrollSyncEnabled, currentStep]);

  // ── Relay iframe messages ──
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!socket) return;
      const type = e.data?.type;
      if (!type) return;
      
      // Filter out internal events that shouldn't be relayed as interactions
      if (type === 'SYNC_PROVIDE_HTML' || type === 'STEP_INFO') return;
      
      if (!type.startsWith('SYNC_')) return;
      if (type === 'SYNC_SCROLL' && !scrollSyncEnabled) return;
      socket.emit("interaction", { roomId, event: e.data });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [socket, roomId, scrollSyncEnabled]);

  // ── Challenge Timer Countdown ──
  useEffect(() => {
    if (!challengeTimer) return;
    if (challengeTimerRef.current) clearInterval(challengeTimerRef.current);
    challengeTimerRef.current = setInterval(() => {
      setChallengeTimer(prev => {
        if (!prev || prev.remaining <= 1) {
          clearInterval(challengeTimerRef.current);
          sounds.timerEnd();
          return null;
        }
        return { ...prev, remaining: prev.remaining - 1 };
      });
    }, 1000);
    return () => { if (challengeTimerRef.current) clearInterval(challengeTimerRef.current); };
  }, [challengeTimer?.seconds]);

  // ── Push scroll sync state to iframe ──
  useEffect(() => {
    postToIframe({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled });
  }, [scrollSyncEnabled, iframeUrl, postToIframe]);

  // ── Step sync to iframe ──
  useEffect(() => {
    if (currentStep < 999) {
      postToIframe({ type: 'SET_STEP', step: currentStep });
    }
  }, [currentStep, iframeUrl, postToIframe]);

  // ── Handlers ──
  const submitQuizAnswer = () => {
    if (!socket || !quizAnswer.trim()) return;
    socket.emit("quiz_answer", { roomId, answer: quizAnswer.trim(), studentName });
    setQuizSubmitted(true);
    sounds.success();
  };

  const toggleChat = () => {
    setChatOpen(!chatOpen);
    if (!chatOpen) setUnreadChat(0);
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-primary)' }}>

      {/* ══════ HEADER ══════ */}
      <header className="flex items-center justify-between px-5 shrink-0"
        style={{ height: '52px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>

        <div className="flex items-center gap-4">
          <span className="text-lg">🧮</span>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
            <span className="text-[13px] font-display font-semibold" style={{ color: 'var(--text-primary)' }}>
              {currentFileName || 'MathsLive'}
            </span>
            <ConnectionStatus socket={socket} connected={connected} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Sound toggle */}
          <button onClick={() => { const m = sounds.toggleMute(); setSoundMuted(m); }}
            className="btn text-[12px]" title={soundMuted ? 'Unmute' : 'Mute'}>
            {soundMuted ? '🔇' : '🔊'}
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
              onLoad={handleIframeLoad}
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

          {/* Annotation Layer (view-only for students) */}
          <AnnotationLayer
            socket={socket} roomId={roomId!}
            drawMode={false} laserMode={false}
            penType="transient" penColor="#6366F1" penWidth={3}
            iframeRef={iframeRef} interactive={false}
            laserPointer={laserPointer}
          />

          {/* Teacher Cursor */}
          <CursorOverlay cursors={cursors} />

          {/* Spotlight */}
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

          {/* Timer */}
          {challengeTimer && (
            <TimerDisplay seconds={challengeTimer.seconds} remaining={challengeTimer.remaining} />
          )}

          {/* Celebration */}
          <Celebrations show={showCelebration} type={celebrationType} />

          {/* Student Reactions Bar */}
          <StudentReactions
            socket={socket} roomId={roomId!} studentName={studentName}
            isPaused={isPaused} visible={!!iframeUrl}
          />

          {/* Floating Reactions */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
            {reactions.map(r => (
              <div key={r.id} className="absolute"
                style={{
                  left: `${r.x}%`, bottom: '15%', fontSize: '48px',
                  animation: 'reaction-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards, reaction-float-up 3s ease-out 0.4s forwards',
                }}>
                {r.emoji}
              </div>
            ))}
          </div>

          {/* Paused Overlay */}
          <PausedOverlay isPaused={isPaused} isTeacher={false} />
        </div>

        {/* Chat Panel */}
        <ChatPanel
          socket={socket} roomId={roomId!} userName={studentName}
          messages={chatMessages} isOpen={chatOpen}
          onToggle={toggleChat} unreadCount={unreadChat}
          variant="panel"
        />
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

      {/* ══════ STEP GATE MODAL ══════ */}
      {gateModal && (
        <StepGate
          socket={socket} roomId={roomId!}
          mode="answer" step={gateModal.step}
          gate={gateModal.gate}
          studentName={studentName}
          onClose={() => setGateModal(null)}
        />
      )}
    </div>
  );
}
