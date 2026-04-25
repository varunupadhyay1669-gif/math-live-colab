import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { injectedSyncScript } from "../lib/syncScript";
import { stepLockScript } from "../lib/stepLockScript";
import { sounds } from "../lib/sounds";
import { useStudentSocket } from "../hooks/useStudentSocket";
import { ThemeToggle } from "../components/ThemeToggle";

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
import Leaderboard from "../components/Leaderboard";
import Whiteboard from "../components/Whiteboard";

export default function StudentView() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const studentName = searchParams.get('name') || 'Student';

  const [iframeUrl, setIframeUrl] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [soundMuted, setSoundMuted] = useState(false);
  const [quizAnswer, setQuizAnswer] = useState("");

  const iframeReadyRef = useRef(false);
  const pendingMessagesRef = useRef<any[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const postToIframe = useCallback((msg: any) => {
    if (iframeReadyRef.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(msg, '*');
    } else {
      if (pendingMessagesRef.current.length < 500) {
        pendingMessagesRef.current.push(msg);
      }
    }
  }, []);

  const handleRemoteInteraction = useCallback((event: any) => {
    postToIframe(event);
  }, [postToIframe]);

  const handleResetView = useCallback(() => {
    postToIframe({ type: 'RESET_VIEW' });
  }, [postToIframe]);

  const {
    socket, connected, currentHtml, setCurrentHtml, currentFileName,
    isPaused, cursors, chatMessages, unreadChat, setUnreadChat, reactions,
    quizModal, setQuizModal, quizSubmitted, setQuizSubmitted, notification, showNotification,
    laserPointer, challengeTimer, showCelebration, celebrationType, spotlight,
    currentStep, gateModal, setGateModal, scrollSyncEnabled, zoomLevel,
    interactionAllowed, whiteboardMode, setWhiteboardMode, whiteboardScrollX, whiteboardScrollY,
    myXp, myStreak, myLevel, xpFloater, levelUpBanner, leaderboard,
    attentionCheckModal, setAttentionCheckModal, teacherDisconnected, joinError,
    attentionTimeoutRef
  } = useStudentSocket(roomId!, studentName, handleRemoteInteraction, handleResetView);

  // ── Iframe onLoad: flush pending messages ──
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    for (const msg of pending) {
      iframeRef.current?.contentWindow?.postMessage(msg, '*');
    }
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled }, '*');
    if (currentStep < 999) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_STEP', step: currentStep }, '*');
    }
    if (zoomLevel !== 1) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'REMOTE_ZOOM', zoom: zoomLevel }, '*');
    }
  }, [scrollSyncEnabled, currentStep, zoomLevel]);

  // ── Relay iframe messages ──
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!socket) return;
      const type = e.data?.type;
      if (!type) return;

      if (type === 'SYNC_PROVIDE_HTML' || type === 'STEP_INFO') return;

      if (!type.startsWith('SYNC_')) return;
      if (type === 'SYNC_CURSOR') {
        socket.emit("interaction", { roomId, event: e.data });
        return;
      }
      if (!interactionAllowed) return;
      if (type === 'SYNC_SCROLL' && !scrollSyncEnabled) return;
      socket.emit("interaction", { roomId, event: e.data });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [socket, roomId, scrollSyncEnabled, interactionAllowed]);

  // ── Push interaction mode to iframe ──
  useEffect(() => {
    postToIframe({ type: 'SET_INTERACTION_MODE', allowed: interactionAllowed });
  }, [interactionAllowed, iframeUrl, postToIframe]);


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

  // ── Re-push zoom when level changes ──
  useEffect(() => {
    postToIframe({ type: 'REMOTE_ZOOM', zoom: zoomLevel });
  }, [zoomLevel, postToIframe]);


  // ── Build iframe URL ──
  useEffect(() => {
    if (!currentHtml) { setIframeUrl(""); return; }
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

  // ── HTTP Fallback: fetch content if Socket.io delivery fails ──
  // This handles cases where the student is far away (e.g., different country)
  // and the large HTML payload gets dropped by Socket.io or network proxies.
  const httpFallbackRef = useRef<ReturnType<typeof setTimeout>>();
  const fetchContentViaHttp = useCallback(async () => {
    if (!roomId) return;
    // First try: ask server via socket (fastest, re-triggers teacher DOM capture)
    if (socket && connected) {
      socket.emit('request_content', { roomId });
    }
    // Second try: HTTP fallback (works even if socket is flaky)
    try {
      const res = await fetch(`/api/room/${roomId}/content`);
      if (res.status === 200) {
        const data = await res.json();
        if (data.html && !currentHtml) {
          setCurrentFileName(data.fileName || 'Simulation');
          setCurrentHtml(data.html);
          showNotification("✅ Content loaded");
        }
      }
    } catch {
      // Silently fail — socket path may still deliver
    }
  }, [roomId, currentHtml, socket, connected]);

  useEffect(() => {
    // If we're connected but have no content after 5 seconds, try HTTP fallback
    if (connected && !currentHtml) {
      httpFallbackRef.current = setTimeout(() => {
        fetchContentViaHttp();
      }, 5000);
    }
    return () => { if (httpFallbackRef.current) clearTimeout(httpFallbackRef.current); };
  }, [connected, currentHtml, fetchContentViaHttp]);


  // ── Relay iframe messages ──
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!socket) return;
      const type = e.data?.type;
      if (!type) return;

      // Filter out internal events that shouldn't be relayed as interactions
      if (type === 'SYNC_PROVIDE_HTML' || type === 'STEP_INFO') return;

      if (!type.startsWith('SYNC_')) return;
      // Always allow cursor (teacher can see where students look)
      if (type === 'SYNC_CURSOR') {
        socket.emit("interaction", { roomId, event: e.data });
        return;
      }
      // Block all other interactions when not allowed (view-only mode)
      if (!interactionAllowed) return;
      if (type === 'SYNC_SCROLL' && !scrollSyncEnabled) return;
      socket.emit("interaction", { roomId, event: e.data });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [socket, roomId, scrollSyncEnabled, interactionAllowed]);

  // ── Push interaction mode to iframe ──
  useEffect(() => {
    postToIframe({ type: 'SET_INTERACTION_MODE', allowed: interactionAllowed });
  }, [interactionAllowed, iframeUrl, postToIframe]);


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
      <header className="app-header" style={{ borderBottom: '2px solid var(--border-strong)', height: '56px' }}>
        <div className="header-section">
          <span className="font-display font-bold text-[20px]" style={{ color: 'var(--text-primary)' }}>
            Maths<span style={{ color: 'var(--accent-emerald)' }}>Craft</span>
          </span>

          <div className="header-divider" style={{ height: '24px' }} />

          <span className="text-[16px] font-bold" style={{ color: 'var(--text-secondary)' }}>
            {currentFileName || 'Server'}
          </span>
          <ConnectionStatus socket={socket} connected={connected} />

          <ThemeToggle />

          {/* ── Whiteboard Button ── */}
          <button
            onClick={() => setWhiteboardMode(true)}
            className="btn-secondary"
            style={{ padding: '4px 12px', height: '32px', fontSize: '14px', marginLeft: '8px' }}
            title="Open collaborative whiteboard"
          >
            Whiteboard
          </button>
        </div>

        <div className="header-section">
          {/* ── XP Badge ── */}
          <button onClick={() => setShowLeaderboard(true)}
            className="flex items-center gap-2 px-3 py-1 transition-all"
            data-tip="View leaderboard"
            style={{
              background: 'var(--bg-card)',
              border: '2px solid var(--border-strong)',
              boxShadow: 'var(--shadow-sm)',
              cursor: 'pointer',
              position: 'relative',
              height: '36px'
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-emerald)', letterSpacing: 0.5 }}>
              LVL {myLevel}
            </span>
            <div style={{ width: 40, height: 8, background: 'var(--bg-code)', border: '1px solid var(--border-default)', overflow: 'hidden' }}>
              <div style={{
                width: `${myXp % 100}%`,
                height: '100%',
                background: 'var(--accent-emerald)',
                transition: 'width 0.5s',
              }} />
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              {myXp} XP
            </span>
            {myStreak >= 2 && (
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-amber)', marginLeft: 2 }}>
                🔥{myStreak}
              </span>
            )}
            {/* Floating +XP animation */}
            {xpFloater && (
              <span
                key={xpFloater.id}
                style={{
                  position: 'absolute',
                  top: -20, right: 8,
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'var(--accent-emerald)',
                  pointerEvents: 'none',
                  animation: 'xpFloat 1.8s forwards',
                  textShadow: '2px 2px 0 rgba(0,0,0,0.5)',
                }}
              >
                +{xpFloater.amount}
              </span>
            )}
          </button>

          <div className="header-divider" style={{ height: '24px' }} />

          {/* View-only / Interactive indicator */}
          <span className="status-pill" style={{
            background: interactionAllowed ? 'var(--accent-emerald-light)' : 'var(--accent-amber-light)',
            color: interactionAllowed ? 'var(--accent-emerald)' : 'var(--accent-amber)',
            fontSize: '14px', fontWeight: 700, border: '2px solid', height: '32px'
          }}>
            {interactionAllowed ? 'INTERACTIVE' : 'SPECTATOR'}
          </span>

          <div className="header-divider" style={{ height: '24px' }} />

          {/* Icon buttons */}
          <button onClick={() => {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen().catch(() => {});
          }} className="btn-icon" data-tip="Fullscreen">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>

          <button onClick={() => { const m = sounds.toggleMute(); setSoundMuted(m); }}
            className="btn-icon" data-tip={soundMuted ? 'Unmute' : 'Mute'}>
            {soundMuted ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
              </svg>
            )}
          </button>

          {/* Chat Toggle */}
          <button onClick={toggleChat} className={`btn-icon relative ${chatOpen ? 'active' : ''}`} data-tip="Chat">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            {unreadChat > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white animate-bounce-in"
                style={{ background: 'var(--accent-rose)', boxShadow: '0 2px 6px rgba(239,68,68,0.35)', padding: '0 4px' }}>
                {unreadChat}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* ══════ JOIN ERROR ══════ */}
      {joinError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)' }}>
          <div className="w-full max-w-sm animate-bounce-in text-center"
            style={{ background: 'var(--bg-card)', borderRadius: '12px', border: '2px solid #E5394B', boxShadow: '0 8px 32px rgba(229,57,75,0.25)', padding: '32px 24px' }}>
            <div className="text-4xl mb-4">⚠️</div>
            <h3 className="font-display text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Cannot Join Room</h3>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>{joinError}</p>
            <button onClick={() => navigate('/')} className="btn-primary w-full justify-center" style={{ height: '44px', fontSize: '15px', borderRadius: '8px' }}>
              Go Back
            </button>
          </div>
        </div>
      )}

      {/* ══════ TEACHER DISCONNECTED BANNER ══════ */}
      {teacherDisconnected && (
        <div className="animate-slide-down px-4 py-2 text-center text-sm font-semibold shrink-0"
          style={{ background: 'rgba(245,158,11,0.12)', color: '#B45309', borderBottom: '1px solid rgba(245,158,11,0.2)' }}>
          ⚠️ Teacher disconnected — waiting for reconnection...
        </div>
      )}

      {/* ══════ MAIN AREA ══════ */}
      <div className="flex-1 flex overflow-hidden relative">

        {/* Full-Screen Iframe */}
        <div className="flex-1 relative overflow-hidden m-3" style={{ border: '4px solid var(--border-strong)' }}>
          {whiteboardMode ? (
            <Whiteboard
              ref={whiteboardRef}
              socket={socket}
              roomId={roomId!}
              isTeacher={false}
              interactive={interactionAllowed}
              zoomLevel={zoomLevel}
              scrollX={whiteboardScrollX}
              scrollY={whiteboardScrollY}
              isActive={true}
            />
          ) : iframeUrl ? (
            <>
              <iframe
                ref={iframeRef}
                src={iframeUrl}
                className="w-full h-full border-none"
                style={{ background: '#ffffff' }}
                onLoad={handleIframeLoad}
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock"
              />
              {/* View-only overlay — blocks pointer events on content when not allowed */}
              {!interactionAllowed && (
                <div
                  className="absolute inset-0"
                  style={{ pointerEvents: 'auto', zIndex: 1, cursor: 'not-allowed' }}
                  onWheel={(e) => e.preventDefault()}
                  onTouchMove={(e) => e.preventDefault()}
                  onMouseDown={(e) => e.preventDefault()}
                />
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full" style={{ background: 'var(--bg-surface)' }}>
              <div className="text-center animate-slide-up p-8"
                style={{ background: 'var(--bg-card)', border: '4px solid var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}>
                <div className="text-6xl mb-4 animate-gentle-bounce">⏳</div>
                <h2 className="font-display text-3xl font-bold mb-2 uppercase" style={{ color: 'var(--text-primary)' }}>Waiting for Server...</h2>
                <p className="text-lg" style={{ color: 'var(--text-secondary)' }}>
                  Your teacher will load the world shortly.
                </p>
                <div className="flex items-center justify-center gap-3 mt-6">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="w-4 h-4 bg-[var(--text-primary)]"
                      style={{ animation: `dot-pulse 1.5s infinite`, animationDelay: `${i * 0.3}s` }} />
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
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 animate-slide-down">
          <div className="px-6 py-3 text-lg font-bold"
            style={{
              background: 'var(--bg-card)', color: 'var(--text-primary)',
              border: '3px solid var(--border-strong)', boxShadow: 'var(--shadow-lg)',
              textTransform: 'uppercase'
            }}>
            {notification}
          </div>
        </div>
      )}

      {/* ══════ QUIZ MODAL ══════ */}
      {quizModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-md animate-bounce-in"
            style={{ background: 'var(--bg-card)', border: '4px solid var(--border-strong)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="p-6">
              <div className="text-center mb-5">
                <h3 className="font-display text-3xl font-bold uppercase" style={{ color: 'var(--text-primary)' }}>Pop Quiz!</h3>
              </div>
              <div className="p-4 mb-4" style={{ background: 'var(--bg-surface)', border: '2px solid var(--border-default)' }}>
                <p className="text-xl font-bold text-center" style={{ color: 'var(--text-primary)' }}>
                  {quizModal.question}
                </p>
              </div>
              {!quizSubmitted ? (
                <>
                  <textarea
                    value={quizAnswer}
                    onChange={(e) => setQuizAnswer(e.target.value)}
                    placeholder="Type your answer here..."
                    className="input-field mb-4 text-lg"
                    autoFocus
                    style={{ minHeight: '100px', resize: 'vertical' }}
                  />
                  <div className="flex gap-3">
                    <button onClick={() => setQuizModal(null)} className="btn-secondary flex-1 text-lg uppercase">Skip</button>
                    <button onClick={submitQuizAnswer} disabled={!quizAnswer.trim()}
                      className="btn-primary flex-1 disabled:opacity-40 text-lg uppercase">
                      Submit
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-center py-4">
                  <div className="text-4xl mb-2 animate-bounce-in">✅</div>
                  <p className="text-xl font-bold uppercase" style={{ color: 'var(--accent-emerald)' }}>Answer submitted!</p>
                  <button onClick={() => setQuizModal(null)} className="btn-secondary mt-4 text-lg uppercase">Close</button>
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

      {/* ══════ ATTENTION CHECK MODAL ══════ */}
      {attentionCheckModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}>
          <div className="w-full max-w-sm animate-bounce-in text-center"
            style={{ background: 'var(--bg-card)', border: '4px solid var(--accent-emerald)', boxShadow: '0 8px 32px rgba(0,170,0,0.25)', padding: '32px 24px' }}>
            <div className="text-6xl mb-4">👀</div>
            <h3 className="font-display text-3xl font-bold mb-2 uppercase" style={{ color: 'var(--text-primary)' }}>
              Are you there?
            </h3>
            <p className="text-lg mb-6" style={{ color: 'var(--text-secondary)' }}>
              Your teacher wants to confirm you're active.
            </p>
            <button
              onClick={() => {
                setAttentionCheckModal(false);
                if (attentionTimeoutRef.current) clearTimeout(attentionTimeoutRef.current);
                if (socket) socket.emit('attention_ack', { roomId, studentName });
              }}
              className="btn-primary w-full justify-center text-xl uppercase"
              style={{ height: '48px' }}>
              I'm Here!
            </button>
          </div>
        </div>
      )}

      {/* ══════ LEVEL-UP BANNER ══════ */}
      {levelUpBanner && (
        <div className="fixed inset-0 z-[60] pointer-events-none flex items-center justify-center">
          <div
            className="px-8 py-6 rounded-2xl text-center"
            style={{
              background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 50%, #EC4899 100%)',
              color: '#fff',
              boxShadow: '0 40px 120px rgba(99,102,241,0.5), 0 0 0 1px rgba(255,255,255,0.15) inset',
              animation: 'levelUpPop 3.5s cubic-bezier(.34,1.56,.64,1) forwards',
            }}
          >
            <div style={{ fontSize: 52, lineHeight: 1 }}>⭐</div>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, opacity: 0.9, marginTop: 8 }}>
              LEVEL UP!
            </div>
            <div style={{ fontSize: 32, fontWeight: 900, marginTop: 4 }}>
              Level {myLevel}
            </div>
          </div>
        </div>
      )}

      {/* ══════ LEADERBOARD ══════ */}
      <Leaderboard
        entries={leaderboard}
        open={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
        currentStudentName={studentName}
      />

    </div>
  );
}
