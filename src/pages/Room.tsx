import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { injectedSyncScript } from "../lib/syncScript";
import { stepLockScript } from "../lib/stepLockScript";
import { sessionRecorder } from "../lib/sessionRecorder";
import { sounds } from "../lib/sounds";

// ── Components ──
import RoomHeader from "../components/RoomHeader";
import FileSidebar from "../components/FileSidebar";
import TeacherControls from "../components/TeacherControls";
import ChatPanel from "../components/ChatPanel";
import FeedbackToasts from "../components/FeedbackToasts";
import PausedOverlay from "../components/PausedOverlay";
import TimerDisplay from "../components/TimerDisplay";
import Celebrations from "../components/Celebrations";
import CursorOverlay from "../components/CursorOverlay";
import AnnotationLayer from "../components/AnnotationLayer";
import StepControls from "../components/StepControls";
import StepGate from "../components/StepGate";
import AttentionIndicator from "../components/AttentionIndicator";
import UserList from "../components/UserList";
import SimulationLibrary from "../components/SimulationLibrary";
import ConnectionStatus from "../components/ConnectionStatus";
import Leaderboard from "../components/Leaderboard";
import Whiteboard from "../components/Whiteboard";

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

interface UserInfo {
  id: string;
  name: string;
  role: string;
}

interface StudentAttention {
  studentId: string;
  studentName: string;
  isAttentive: boolean;
  lastSeen: number;
}

interface GateData {
  question: string;
  options: string[];
  correctIndex: number;
}

const CURSOR_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#F43F5E", "#8B5CF6", "#EC4899", "#0EA5E9", "#F97316"];

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const teacherName = searchParams.get('name') || 'Teacher';

  // ── View Mode ──
  type ViewMode = 'split' | 'code' | 'preview';
  const [viewMode, setViewMode] = useState<ViewMode>(
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'preview' : 'split'
  );

  // ── Core State ──
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [htmlCode, setHtmlCode] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [iframeUrl, setIframeUrl] = useState("");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});

  // ── Feature State ──
  const [isPaused, setIsPaused] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [showQuizModal, setShowQuizModal] = useState(false);
  const [quizQuestion, setQuizQuestion] = useState("");
  const [quizAnswers, setQuizAnswers] = useState<Array<{ answer: string; studentName: string }>>([]);
  const [handRaised, setHandRaised] = useState<{ studentName: string } | null>(null);
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: string }>>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [notification, setNotification] = useState("");
  const [sessionTimer, setSessionTimer] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteCode, setPasteCode] = useState("");
  const [pasteFileName, setPasteFileName] = useState("");

  // ── Drawing & Annotation ──
  const [drawMode, setDrawMode] = useState(false);
  const [laserMode, setLaserMode] = useState(false);
  const [penType, setPenType] = useState<'transient' | 'permanent'>('transient');
  const [penColor, setPenColor] = useState('#6366F1');
  const [penWidth, setPenWidth] = useState(3);

  // ── Challenge Timer ──
  const [challengeTimer, setChallengeTimer] = useState<{ seconds: number; remaining: number } | null>(null);
  const challengeTimerRef = useRef<ReturnType<typeof setInterval>>();

  // ── Student Feedback ──
  const [studentFeedback, setStudentFeedback] = useState<Array<{ id: number; emoji: string; label: string; studentName: string }>>([]);
  const feedbackIdRef = useRef(0);

  // ── Celebration ──
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationType, setCelebrationType] = useState<'confetti' | 'fireworks' | 'stars'>('confetti');

  // ── Sync Status ──
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);

  // ── Scroll Sync ──
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(true);

  // ── Temporary Explanation Content ──
  const [tempContent, setTempContent] = useState<{ html: string; name: string } | null>(null);
  const [showTempContent, setShowTempContent] = useState(false);
  const tempFileInputRef = useRef<HTMLInputElement>(null);

  // Memoize blob URL to prevent iframe from reloading on every render
  const tempContentUrl = useMemo(() => {
    if (!tempContent) return null;
    const scripts = injectedSyncScript + stepLockScript;
    let content = tempContent.html;
    if (content.includes("<head>")) {
      content = content.replace("<head>", "<head>" + scripts);
    } else {
      content = scripts + content;
    }
    const blob = new Blob([content], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [tempContent?.html, tempContent?.name]);

  useEffect(() => {
    return () => {
      if (tempContentUrl) URL.revokeObjectURL(tempContentUrl);
    };
  }, [tempContentUrl]);

  // ── Zoom Sync ──
  const [zoomLevel, setZoomLevel] = useState(1);

  // ── Gamification ──
  const [leaderboard, setLeaderboard] = useState<Array<{ studentName: string; xp: number; streak: number }>>([]);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  // ── Whiteboard ──
  const [whiteboardMode, setWhiteboardMode] = useState(false);
  const [whiteboardScrollX, setWhiteboardScrollX] = useState(0);
  const [whiteboardScrollY, setWhiteboardScrollY] = useState(0);
  const whiteboardRef = useRef<import('../components/Whiteboard').WhiteboardRef>(null);

  // ── Student Interaction Mode ──
  const [studentInteractionAllowed, setStudentInteractionAllowed] = useState(false);

  // ── Attention Check ──
  const [attentionAcks, setAttentionAcks] = useState<Array<{ studentName: string; timestamp: number }>>([]);
  const [attentionCheckActive, setAttentionCheckActive] = useState(false);

  // ── Follow Clicks ──
  const [followStudentClicks, setFollowStudentClicks] = useState(false);
  const [studentClickIndicators, setStudentClickIndicators] = useState<Array<{ id: number; x: number; y: number; name: string; color: string }>>([]);

  // ── Iframe readiness ──
  const iframeReadyRef = useRef(false);
  const pendingMessagesRef = useRef<any[]>([]);

  // ── Step-Lock ──
  const [stepLockEnabled, setStepLockEnabled] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStep, setMaxStep] = useState(0);
  const [gates, setGates] = useState<Record<number, GateData>>({});
  const [showGateModal, setShowGateModal] = useState(false);

  // ── Attention Detection ──
  const [attention, setAttention] = useState<Record<string, StudentAttention>>({});

  // ── Simulation Library ──
  const [showLibrary, setShowLibrary] = useState(false);

  // ── Recording ──
  const [isRecording, setIsRecording] = useState(false);

  // ── Sound ──
  const [soundMuted, setSoundMuted] = useState(false);

  // ── User Panel ──
  const [showUserPanel, setShowUserPanel] = useState(false);

  // ── Room Password ──
  const [roomPassword, setRoomPassword] = useState<string>('');
  const [showShareMenu, setShowShareMenu] = useState(false);

  // ── Flag to skip our own run_preview echo ──
  const skipOwnPreviewRef = useRef(false);
  const syncEpochRef = useRef(0);
  const lastInboundSeqRef = useRef(0);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotRequestRef = useRef(false);

  // ── Refs ──
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const reactionIdRef = useRef(0);

  // ── Session Timer ──
  useEffect(() => {
    timerRef.current = setInterval(() => setSessionTimer(t => t + 1), 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  // ── Socket Connection ──
  useEffect(() => {
    if (!roomId) { navigate("/"); return; }
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on("connect", () => {
      setConnected(true);
      newSocket.emit("join_room", { roomId, userName: teacherName, role: 'teacher' });
    });
    newSocket.on("disconnect", () => setConnected(false));

    newSocket.on("room_state", (state: any) => {
      setFiles(state.files || []);
      setActiveFileId(state.activeFileId);
      setIsPaused(state.isPaused);
      if (typeof state.scrollSyncEnabled === 'boolean') setScrollSyncEnabled(state.scrollSyncEnabled);
      if (typeof state.studentInteractionAllowed === 'boolean') setStudentInteractionAllowed(state.studentInteractionAllowed);
      setUsers(state.users || []);
      setChatMessages(state.chat || []);
      if (state.activeFileId && state.files) {
        const f = state.files.find((f: FileEntry) => f.id === state.activeFileId);
        if (f) { setHtmlCode(f.html); setPreviewHtml(f.html); }
      }
    });

    newSocket.on("user_list", (list: UserInfo[]) => setUsers(list));
    newSocket.on("user_left", (data: { userId: string; userName: string }) => {
      setCursors(prev => { const n = { ...prev }; delete n[data.userId]; return n; });
      setAttention(prev => { const n = { ...prev }; delete n[data.userId]; return n; });
      showNotif(`${data.userName} left the session`);
    });
    newSocket.on("file_uploaded", (file: FileEntry) => {
      setFiles(prev => [...prev, file]);
      sounds.tick();
    });
    newSocket.on("upload_error", ({ message }: { message: string }) => {
      showNotif(`⚠️ Upload failed: ${message}`);
    });
    newSocket.on("file_updated", ({ fileId, html }: { fileId: string; html: string }) => {
      setFiles(prev => prev.map(f => f.id === fileId ? { ...f, html } : f));
    });
    newSocket.on("file_deleted", ({ fileId, newActiveId }: { fileId: string; newActiveId: string | null }) => {
      setFiles(prev => prev.filter(f => f.id !== fileId));
      if (newActiveId) setActiveFileId(newActiveId);
    });
    newSocket.on("active_file_changed", (data: { fileId: string; fileName?: string; html?: string }) => {
      setActiveFileId(data.fileId);
    });
    newSocket.on("run_preview", ({ html }: { fileId: string; html: string }) => {
      // Skip if this is our own echo from run_preview we just emitted
      if (skipOwnPreviewRef.current) {
        skipOwnPreviewRef.current = false;
        return;
      }
      // Only rebuild iframe if HTML actually changed
      setPreviewHtml(prev => prev === html ? prev : html);
    });
    newSocket.on("chat_message", (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
      sounds.message();
      if (isRecording) sessionRecorder.record('chat_message', msg);
    });
    newSocket.on("hand_raised", ({ studentName }: { studentName: string }) => {
      setHandRaised({ studentName });
      showNotif(`✋ ${studentName} raised their hand!`);
      sounds.raiseHand();
      setTimeout(() => setHandRaised(null), 8000);
    });
    newSocket.on("quiz_answer_received", ({ answer, studentName }: { answer: string; studentName: string }) => {
      setQuizAnswers(prev => [...prev, { answer, studentName }]);
      showNotif(`📝 ${studentName} answered!`);
      sounds.success();
    });
    newSocket.on("reaction", ({ emoji }: { emoji: string }) => {
      const id = reactionIdRef.current++;
      setReactions(prev => [...prev, { id, emoji }]);
      setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 2500);
    });

    // ── Temporary Explanation Content ──
    newSocket.on("temp_content", ({ html, name }: { html: string; name: string }) => {
      setTempContent({ html, name });
      setShowTempContent(true);
      showNotif(`📚 Showing explanation: ${name}`);
    });
    newSocket.on("clear_temp_content", () => {
      setShowTempContent(false);
      showNotif('↩️ Back to main content');
    });

    newSocket.on("interaction", (event: any) => {
      if (typeof event.serverSeq === 'number') {
        if (event.serverSeq <= lastInboundSeqRef.current) return;
        lastInboundSeqRef.current = event.serverSeq;
      }
      if (typeof event.syncEpoch === 'number' && event.syncEpoch < syncEpochRef.current) {
        return;
      }
      if (event.type === "SYNC_CURSOR") {
        setCursors(prev => ({
          ...prev,
          [event.userId]: {
            x: event.x, y: event.y,
            color: CURSOR_COLORS[event.userId.charCodeAt(0) % CURSOR_COLORS.length],
            name: event.userName || 'Student',
          },
        }));
      } else if (event.type === "SYNC_CLICK") {
        // Show click indicator for student clicks
        if (event.role === 'student') {
          const id = Date.now() + Math.random();
          const color = CURSOR_COLORS[event.userId.charCodeAt(0) % CURSOR_COLORS.length];
          setStudentClickIndicators(prev => [...prev, {
            id,
            x: event.clientX,
            y: event.clientY,
            name: event.userName || 'Student',
            color
          }]);
          setTimeout(() => {
            setStudentClickIndicators(prev => prev.filter(i => i.id !== id));
          }, 2000);

          // Auto-scroll to student click if following is enabled
          if (followStudentClicks && iframeRef.current) {
            const iframe = iframeRef.current;
            iframe.contentWindow?.postMessage({
              type: 'FOLLOW_CLICK',
              x: event.clientX,
              y: event.clientY
            }, '*');
          }
        }
        const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
        postToIframe(remoteEvent);
      } else {
        const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
        postToIframe(remoteEvent);
      }
      if (isRecording) sessionRecorder.record('interaction', event);
    });

    // ── Student Feedback ──
    newSocket.on("student_feedback", ({ emoji, label, studentName }: { emoji: string; label: string; studentName: string }) => {
      const id = feedbackIdRef.current++;
      setStudentFeedback(prev => [...prev, { id, emoji, label, studentName }]);
      showNotif(`${emoji} ${studentName}: ${label}`);
      sounds.tick();
      setTimeout(() => setStudentFeedback(prev => prev.filter(f => f.id !== id)), 5000);
    });

    // ── Timer ──
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

    // ── Sync ──
    newSocket.on("request_html_sync", () => {
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({ type: 'REQUEST_HTML' }, "*");
      }
    });
    newSocket.on("force_sync_state", (state: any) => {
      if (state.activeFileId && state.lastRunHtml) {
        setPreviewHtml(state.lastRunHtml);
        setActiveFileId(state.activeFileId);
      }
      if (state.files) setFiles(state.files);
      setLastSyncTime(Date.now());
    });

    // ── Attention ──
    newSocket.on("student_attention", ({ studentId, studentName, isAttentive }: { studentId: string; studentName: string; isAttentive: boolean }) => {
      setAttention(prev => ({
        ...prev,
        [studentId]: { studentId, studentName, isAttentive, lastSeen: Date.now() },
      }));
    });

    // ── Scroll Sync ──
    newSocket.on("scroll_sync_changed", ({ enabled }: { enabled: boolean }) => {
      setScrollSyncEnabled(enabled);
    });

    // ── Student Interaction Mode ──
    newSocket.on("student_interaction_changed", ({ allowed }: { allowed: boolean }) => {
      setStudentInteractionAllowed(allowed);
    });

    // ── Attention Check Acks ──
    newSocket.on("attention_ack", ({ studentName, timestamp }: { studentName: string; timestamp: number }) => {
      setAttentionAcks(prev => [...prev, { studentName, timestamp }]);
      showNotif(`${studentName} is here`);
    });

    // ── Step-Lock events ──
    newSocket.on("gate_answered", ({ studentName, step, correct }: { studentName: string; step: number; correct: boolean }) => {
      showNotif(`${correct ? '✅' : '❌'} ${studentName} ${correct ? 'passed' : 'failed'} gate on Step ${step}`);
      if (correct) sounds.success();
    });

    // ── Gamification ──
    newSocket.on("leaderboard_update", (lb: Array<{ studentName: string; xp: number; streak: number }>) => {
      setLeaderboard(lb);
    });

    // ── Room Hard Reset (files are PRESERVED — only progress/session state is cleared) ──
    newSocket.on("room_reset", (payload?: { activeFileId?: string | null; files?: FileEntry[]; lastRunHtml?: string | null }) => {
      // Clear session progress/state
      setChatMessages([]);
      setCursors({});
      setCurrentStep(1);
      setMaxStep(0);
      setGates({});
      setStepLockEnabled(false);
      setZoomLevel(1);
      setLeaderboard([]);
      setQuizAnswers([]);
      setHandRaised(null);
      setStudentFeedback([]);
      setAttention({});
      setAttentionAcks([]);
      // Keep uploaded files — sync from server's authoritative state if provided
      if (payload?.files) setFiles(payload.files);
      if (payload?.activeFileId !== undefined) setActiveFileId(payload.activeFileId);
      // Reload the active file into preview so it starts fresh from the top
      if (payload?.activeFileId && payload.files) {
        const active = payload.files.find(f => f.id === payload.activeFileId);
        if (active) {
          setHtmlCode(active.html);
          setPreviewHtml(active.html);
        }
      }
      showNotif("🔄 Session reset — starting from the beginning");
    });

    return () => { newSocket.disconnect(); };
  }, [roomId, navigate, teacherName]);

  // ── Helper: safely post message to iframe (queues if not ready) ──
  const postToIframe = useCallback((msg: any) => {
    if (iframeReadyRef.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(msg, '*');
    } else {
      // Cap pending queue to prevent memory leak
      if (pendingMessagesRef.current.length < 500) {
        pendingMessagesRef.current.push(msg);
      }
    }
  }, []);

  // ── Iframe onLoad: flush pending messages ──
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    // Flush any pending messages
    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    for (const msg of pending) {
      iframeRef.current?.contentWindow?.postMessage(msg, '*');
    }
    // Re-send current state
    if (scrollSyncEnabled !== undefined) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled }, '*');
    }
    if (stepLockEnabled && currentStep) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_STEP', step: currentStep }, '*');
    }
    if (zoomLevel !== 1) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_ZOOM', zoom: zoomLevel }, '*');
    }
  }, [scrollSyncEnabled, stepLockEnabled, currentStep, zoomLevel]);

  // ── Relay iframe messages ──
  useEffect(() => {
    const requestSnapshot = () => {
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = setTimeout(() => {
        snapshotRequestRef.current = true;
        iframeRef.current?.contentWindow?.postMessage({ type: 'REQUEST_HTML' }, "*");
      }, 350);
    };

    const handler = (e: MessageEvent) => {
      if (!socket) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const type = e.data?.type;
      if (!type) return;

      // Internal sync events — not interactions
      if (type === 'SYNC_PROVIDE_HTML') {
        if (snapshotRequestRef.current) {
          snapshotRequestRef.current = false;
          socket.emit("dom_snapshot", { roomId, html: e.data.html });
        } else {
          socket.emit("sync_html_update", { roomId, html: e.data.html });
        }
        return;
      }
      if (type === 'STEP_INFO') {
        setMaxStep(e.data.maxStep || 0);
        return;
      }

      // Only relay actual SYNC_ interaction events
      if (type.startsWith('SYNC_')) {
        // Check scroll sync gate
        if (type === 'SYNC_SCROLL' && !scrollSyncEnabled) return;
        socket.emit("interaction", {
          roomId,
          event: {
            ...e.data,
            syncEpoch: syncEpochRef.current,
            clientTs: Date.now(),
          },
        });
        if (type !== 'SYNC_CURSOR' && type !== 'SYNC_SCROLL' && type !== 'SYNC_ZOOM') {
          requestSnapshot();
        }
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    };
  }, [socket, roomId, scrollSyncEnabled]);

  useEffect(() => {
    syncEpochRef.current += 1;
    // Reset iframe readiness when content source changes — the new iframe needs to fire onLoad
    iframeReadyRef.current = false;
  }, [iframeUrl, showTempContent, whiteboardMode]);

  // NOTE: Periodic auto-sync removed — it was causing full iframe reloads on student
  // side every 10s, making the page blink and scroll jump to top.
  // Interactions are already synced in real-time via SYNC_* events.
  // Full HTML sync only happens on: file switch, file upload, manual Force Sync.

  // ── Build iframe URL ──
  useEffect(() => {
    if (!previewHtml) { setIframeUrl(""); return; }
    // Mark iframe as not ready while we rebuild it
    iframeReadyRef.current = false;
    let content = previewHtml;
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
  }, [previewHtml, stepLockEnabled]);

  // ── Sync code when active file changes ──
  useEffect(() => {
    if (activeFileId) {
      const file = files.find(f => f.id === activeFileId);
      if (file) { setHtmlCode(file.html); setPreviewHtml(file.html); }
    }
  }, [activeFileId]);

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

  // ── Step-Lock: send step to iframe when changed ──
  useEffect(() => {
    if (stepLockEnabled) {
      postToIframe({ type: 'SET_STEP', step: currentStep });
    }
  }, [currentStep, stepLockEnabled, postToIframe]);

  // ── Push scroll sync state to iframe ──
  useEffect(() => {
    postToIframe({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled });
  }, [scrollSyncEnabled, iframeUrl, postToIframe]);

  // ── Zoom: push to iframe when level changes ──
  useEffect(() => {
    postToIframe({ type: 'SET_ZOOM', zoom: zoomLevel });
  }, [zoomLevel, postToIframe]);

  const handleZoomIn = () => {
    const newZoom = Math.min(3, +(zoomLevel + 0.1).toFixed(2));
    setZoomLevel(newZoom);
    if (socket) socket.emit('zoom_changed', { roomId, zoom: newZoom });
  };
  const handleZoomOut = () => {
    const newZoom = Math.max(0.5, +(zoomLevel - 0.1).toFixed(2));
    setZoomLevel(newZoom);
    if (socket) socket.emit('zoom_changed', { roomId, zoom: newZoom });
  };
  const handleZoomReset = () => {
    setZoomLevel(1);
    if (socket) socket.emit('zoom_changed', { roomId, zoom: 1 });
  };

  const handleHardReset = () => {
    if (!socket) return;
    const ok = window.confirm("🔄 Reset Session\n\nThis will start the lesson over from the beginning:\n• Chat history cleared\n• Steps reset to 1\n• All gates & quiz answers cleared\n• XP & leaderboard cleared\n• Everyone scrolled back to top\n\n✅ Uploaded files are kept safe.\n\nContinue?");
    if (!ok) return;
    socket.emit("hard_reset", { roomId });
  };

  // ── Attention timestamp updater ──
  useEffect(() => {
    const interval = setInterval(() => {
      setAttention(prev => ({ ...prev })); // Force re-render for time-based status
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── Helpers ──
  const notifTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const showNotif = (msg: string) => {
    if (notifTimeoutRef.current) clearTimeout(notifTimeoutRef.current);
    setNotification(msg);
    notifTimeoutRef.current = setTimeout(() => setNotification(""), 3000);
  };

  const uploadFileFromInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || !socket) return;
    Array.from(uploadedFiles).forEach((file: File) => {
      if (file.size > 2 * 1024 * 1024) { showNotif(`⚠️ ${file.name} is too large (max 2MB)`); return; }
      if (file.size === 0) { showNotif(`⚠️ ${file.name} is empty`); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        if (!content || content.trim().length === 0) {
          showNotif(`⚠️ ${file.name} has no content`);
          return;
        }
        const entry: FileEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name.replace(/\.html?$/i, ''),
          html: content,
          uploadedAt: Date.now(),
        };
        socket.emit("upload_file", { roomId, file: entry });
        setHtmlCode(content);
        setPreviewHtml(content);
        showNotif(`✅ Uploaded: ${entry.name}`);
      };
      reader.onerror = () => showNotif(`⚠️ Failed to read ${file.name}`);
      reader.onabort = () => showNotif(`⚠️ Upload of ${file.name} was cancelled`);
      try {
        reader.readAsText(file);
      } catch (err) {
        showNotif(`⚠️ Cannot read ${file.name}: ${err}`);
      }
    });
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!socket) return;
    const droppedFiles = (Array.from(e.dataTransfer.files) as File[]).filter(f => /\.html?$/i.test(f.name));
    if (droppedFiles.length === 0) { showNotif("⚠️ Only .html files please"); return; }
    droppedFiles.forEach((file: File) => {
      if (file.size > 2 * 1024 * 1024) { showNotif(`⚠️ ${file.name} is too large (max 2MB)`); return; }
      if (file.size === 0) { showNotif(`⚠️ ${file.name} is empty`); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        if (!content || content.trim().length === 0) {
          showNotif(`⚠️ ${file.name} has no content`);
          return;
        }
        const entry: FileEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name.replace(/\.html?$/i, ''),
          html: content,
          uploadedAt: Date.now(),
        };
        socket.emit("upload_file", { roomId, file: entry });
        setHtmlCode(content);
        setPreviewHtml(content);
        showNotif(`✅ Uploaded: ${entry.name}`);
      };
      reader.onerror = () => showNotif(`⚠️ Failed to read ${file.name}`);
      reader.onabort = () => showNotif(`⚠️ Upload of ${file.name} was cancelled`);
      try {
        reader.readAsText(file);
      } catch (err) {
        showNotif(`⚠️ Cannot read ${file.name}: ${err}`);
      }
    });
  };

  const handlePasteSubmit = () => {
    if (!socket || !pasteCode.trim()) return;
    const name = pasteFileName.trim() || `Pasted-${new Date().toLocaleTimeString()}`;
    const entry: FileEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      html: pasteCode,
      uploadedAt: Date.now(),
    };
    socket.emit("upload_file", { roomId, file: entry });
    setHtmlCode(pasteCode);
    setPreviewHtml(pasteCode);
    setShowPasteModal(false);
    setPasteCode("");
    setPasteFileName("");
    showNotif(`✅ Added: ${name}`);
  };

  const runPreview = () => {
    if (!socket || !activeFileId) return;
    // Flag to skip our own echo from the server broadcast
    skipOwnPreviewRef.current = true;
    socket.emit("run_preview", { roomId, fileId: activeFileId, html: htmlCode });
    setPreviewHtml(htmlCode);
    showNotif("▶ Preview updated & synced");
  };

  const switchFile = (fileId: string) => {
    if (!socket) return;
    const file = files.find(f => f.id === fileId);
    if (file) {
      setHtmlCode(file.html);
      setPreviewHtml(file.html);
      socket.emit("switch_file", { roomId, fileId });
    }
  };

  const deleteFile = (fileId: string) => {
    if (!socket) return;
    socket.emit("delete_file", { roomId, fileId });
  };

  const copyStudentLink = () => {
    const url = `${window.location.origin}/live/${roomId}`;
    let text = url;
    if (roomPassword) {
      text = `Join my MathsLive session:\n${url}\nPasscode: ${roomPassword}`;
    }
    navigator.clipboard.writeText(text);
    setLinkCopied(true);
    setShowShareMenu(false);
    setTimeout(() => setLinkCopied(false), 2500);
  };

  const saveRoomPassword = (pw: string) => {
    setRoomPassword(pw);
    if (socket) {
      socket.emit('set_room_password', { roomId, password: pw || null });
    }
  };

  const sendReaction = (emoji: string) => {
    if (!socket) return;
    socket.emit("send_reaction", { roomId, emoji, fromName: teacherName });
    const id = reactionIdRef.current++;
    setReactions(prev => [...prev, { id, emoji }]);
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 2500);
  };

  const handleForceSync = () => {
    if (!socket) return;
    // Capture teacher's current live DOM and save it server-side for new students,
    // then emit force_sync so students get the latest state.
    // The REQUEST_HTML → SYNC_PROVIDE_HTML → sync_html_update flow stores it.
    postToIframe({ type: 'REQUEST_HTML' });
    setTimeout(() => {
      socket.emit("force_sync", { roomId });
      setLastSyncTime(Date.now());
    }, 300);
  };

  const toggleScrollSync = () => {
    if (!socket) return;
    const newEnabled = !scrollSyncEnabled;
    setScrollSyncEnabled(newEnabled);
    socket.emit("toggle_scroll_sync", { roomId, enabled: newEnabled });
    postToIframe({ type: 'SET_SCROLL_SYNC', enabled: newEnabled });
    showNotif(newEnabled ? '🔗 Scroll sync ON' : '🔓 Free scroll — everyone scrolls independently');
  };

  const toggleStudentInteraction = () => {
    if (!socket) return;
    const newAllowed = !studentInteractionAllowed;
    setStudentInteractionAllowed(newAllowed);
    socket.emit("toggle_student_interaction", { roomId, allowed: newAllowed });
    showNotif(newAllowed ? '🖐️ Students can now interact with the simulation' : '👁️ Students are now view-only');
  };

  const resetView = () => {
    if (!socket) return;
    socket.emit("reset_view", { roomId });
    postToIframe({ type: 'RESET_VIEW' });
    showNotif('⬆️ Reset view — scrolled everyone to top');
  };

  const sendAttentionCheck = () => {
    if (!socket) return;
    setAttentionAcks([]);
    setAttentionCheckActive(true);
    socket.emit("attention_check", { roomId });
    showNotif('📢 Attention check sent — waiting for responses');
    // Auto-dismiss after 30s
    setTimeout(() => setAttentionCheckActive(false), 30000);
  };

  const togglePause = () => {
    if (!socket) return;
    if (isPaused) { socket.emit("resume_session", { roomId }); setIsPaused(false); }
    else { socket.emit("pause_session", { roomId }); setIsPaused(true); }
  };

  const triggerCelebration = () => {
    if (!socket) return;
    socket.emit("trigger_celebration", { roomId, type: 'confetti' });
  };

  const startChallengeTimer = (seconds: number) => {
    if (!socket) return;
    socket.emit("start_timer", { roomId, seconds });
  };

  const stopChallengeTimer = () => {
    if (!socket) return;
    socket.emit("stop_timer", { roomId });
    setChallengeTimer(null);
    if (challengeTimerRef.current) clearInterval(challengeTimerRef.current);
  };

  const clearDrawing = () => {
    if (socket) socket.emit('draw_clear', { roomId });
  };

  const sendQuiz = () => {
    if (!socket || !quizQuestion.trim()) return;
    socket.emit("send_quiz", { roomId, question: quizQuestion.trim() });
    setQuizAnswers([]);
    setShowQuizModal(false);
    showNotif("🎯 Quiz sent!");
  };

  // ── Temporary Explanation Content ──
  const handleUploadExplanation = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !socket) return;
    if (file.size > 2 * 1024 * 1024) { showNotif(`⚠️ File too large (max 2MB)`); return; }
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = String(event.target?.result || '');
      const name = file.name.replace(/\.html?$/i, '');
      setTempContent({ html: content, name });
      socket.emit('show_temp_content', { roomId, html: content, name });
      setShowTempContent(true);
      showNotif(`📚 Showing explanation: ${name}`);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const clearTempContent = () => {
    if (!socket) return;
    socket.emit('clear_temp_content', { roomId });
    setShowTempContent(false);
    showNotif('↩️ Back to main content');
  };

  const handleSetStep = (step: number) => {
    setCurrentStep(step);
    if (socket) socket.emit('set_step', { roomId, step });
  };

  const toggleStepLock = () => {
    const newEnabled = !stepLockEnabled;
    setStepLockEnabled(newEnabled);
    if (!newEnabled) {
      postToIframe({ type: 'DISABLE_STEP_LOCK' });
    }
    if (newEnabled) {
      setCurrentStep(1);
      postToIframe({ type: 'GET_MAX_STEP' });
      postToIframe({ type: 'SET_STEP', step: 1 });
    }
  };

  const handleLoadFromLibrary = (html: string, name: string) => {
    if (!socket) return;
    const entry: FileEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      html,
      uploadedAt: Date.now(),
    };
    socket.emit("upload_file", { roomId, file: entry });
    setHtmlCode(html);
    setPreviewHtml(html);
    setShowLibrary(false);
    showNotif(`📚 Loaded: ${name}`);
  };

  const toggleRecording = () => {
    if (isRecording) {
      sessionRecorder.stop();
      sessionRecorder.download();
      setIsRecording(false);
      showNotif("⏹ Recording saved");
    } else {
      sessionRecorder.start();
      setIsRecording(true);
      showNotif("🔴 Recording started");
    }
  };

  const studentCount = users.filter(u => u.role === 'student').length;
  const showLeftPanel = viewMode === 'split' || viewMode === 'code';
  const showPreview = viewMode === 'split' || viewMode === 'preview';
  const activeFile = files.find(f => f.id === activeFileId);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]"
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDragging(false); }}
      onDrop={handleDrop}>

      {/* ═══ DROP OVERLAY ═══ */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(249,250,251,0.95)] backdrop-blur-[8px]">
          <div className="text-center animate-bounce-in">
            <div className="text-7xl mb-4">📂</div>
            <div className="text-2xl font-bold text-[var(--accent-indigo)]">Drop HTML files here</div>
            <div className="text-sm mt-2 text-[var(--text-muted)]">They'll be added to your file library</div>
          </div>
        </div>
      )}

      {/* ═══ HEADER ═══ */}
      <RoomHeader
        roomId={roomId!}
        viewMode={viewMode}
        setViewMode={setViewMode}
        socket={socket}
        connected={connected}
        sessionTimer={sessionTimer}
        studentCount={studentCount}
        showUserPanel={showUserPanel}
        setShowUserPanel={setShowUserPanel}
        users={users}
        attention={attention}
        showShareMenu={showShareMenu}
        setShowShareMenu={setShowShareMenu}
        linkCopied={linkCopied}
        roomPassword={roomPassword}
        saveRoomPassword={saveRoomPassword}
        copyStudentLink={copyStudentLink}
        setShowLibrary={setShowLibrary}
        isRecording={isRecording}
        toggleRecording={toggleRecording}
        soundMuted={soundMuted}
        setSoundMuted={(muted) => {
            const m = sounds.toggleMute();
            setSoundMuted(m);
        }}
        navigate={navigate}
      />

      {/* ═══ HAND RAISED BANNER ═══ */}
      {handRaised && (
        <div className="animate-slide-down px-4 py-2 text-center text-sm font-semibold bg-[var(--accent-amber-light)] text-[#B45309] border-b border-[rgba(245,158,11,0.2)]">
          ✋ {handRaised.studentName} raised their hand!
        </div>
      )}

      {/* ═══ MAIN CONTENT ═══ */}
      <div className="flex-1 flex overflow-hidden">

        {/* ──── LEFT: Files + Code Editor ──── */}
        <FileSidebar
          viewMode={viewMode}
          files={files}
          activeFileId={activeFileId}
          htmlCode={htmlCode}
          setHtmlCode={setHtmlCode}
          uploadFileFromInput={uploadFileFromInput}
          setShowPasteModal={setShowPasteModal}
          switchFile={switchFile}
          deleteFile={deleteFile}
          runPreview={runPreview}
          activeFile={activeFile}
        />

        {/* ──── CENTER: Preview ──── */}
        {showPreview && (
          <div className="flex-1 flex flex-col relative overflow-hidden bg-[var(--bg-primary)]">

            {/* Teacher Toolbar */}
            <TeacherControls
              socket={socket} roomId={roomId!}
              isPaused={isPaused} onTogglePause={togglePause}
              drawMode={drawMode} laserMode={laserMode} penType={penType}
              penColor={penColor} penWidth={penWidth}
              onSetDrawMode={setDrawMode} onSetLaserMode={setLaserMode}
              onSetPenType={setPenType} onSetPenColor={setPenColor} onSetPenWidth={setPenWidth}
              onClearDrawing={clearDrawing}
              onForceSync={handleForceSync} onTriggerCelebration={triggerCelebration}
              challengeTimer={challengeTimer}
              onStartTimer={startChallengeTimer} onStopTimer={stopChallengeTimer}
              lastSyncTime={lastSyncTime}
              onOpenQuiz={() => setShowQuizModal(true)}
              onSendReaction={sendReaction}
              scrollSyncEnabled={scrollSyncEnabled}
              onToggleScrollSync={toggleScrollSync}
              studentInteractionAllowed={studentInteractionAllowed}
              onToggleStudentInteraction={toggleStudentInteraction}
              onResetView={resetView}
              onAttentionCheck={sendAttentionCheck}
              zoomLevel={zoomLevel}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onZoomReset={handleZoomReset}
              onHardReset={handleHardReset}
              leaderboardCount={leaderboard.length}
              onToggleLeaderboard={() => setShowLeaderboard(v => !v)}
              onToggleWhiteboard={() => {
                const newMode = !whiteboardMode;
                setWhiteboardMode(newMode);
                if (socket) {
                  socket.emit('whiteboard_mode_toggle', { roomId, active: newMode });
                }
              }}
              followStudentClicks={followStudentClicks}
              onToggleFollowStudentClicks={() => setFollowStudentClicks(v => !v)}
              whiteboardMode={whiteboardMode}
            />

            {/* Temporary Explanation Content Bar */}
            {showTempContent && tempContent && (
              <div className="px-4 py-2 flex items-center justify-between"
                style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(251,191,36,0.12))', borderBottom: '1px solid rgba(245,158,11,0.25)' }}>
                <div className="flex items-center gap-2">
                  <span style={{ color: '#D97706' }}>📚</span>
                  <span className="font-medium text-sm" style={{ color: '#92400E' }}>
                    Showing explanation: {tempContent.name}
                  </span>
                </div>
                <button
                  onClick={clearTempContent}
                  className="flex items-center gap-1 px-3 py-1 rounded-md text-sm font-medium transition-all"
                  style={{
                    background: 'rgba(245,158,11,0.2)',
                    color: '#B45309',
                    border: '1px solid rgba(245,158,11,0.3)'
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 12h18M3 12l6-6M3 12l6 6"/>
                  </svg>
                  Back to Content
                </button>
              </div>
            )}

            {/* Upload Explanation Button (when no temp content) */}
            {!showTempContent && (
              <div className="px-4 py-2">
                <button
                  onClick={() => tempFileInputRef.current?.click()}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all"
                  style={{
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(139,92,246,0.12))',
                    border: '1px solid rgba(99,102,241,0.25)',
                    color: '#6366F1'
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="12" y1="18" x2="12" y2="12"/>
                    <line x1="9" y1="15" x2="15" y2="15"/>
                  </svg>
                  Upload Explanation HTML
                </button>
                <input
                  ref={tempFileInputRef}
                  type="file"
                  accept=".html,.htm"
                  onChange={handleUploadExplanation}
                  className="hidden"
                />
              </div>
            )}

            {/* Step Controls */}
            <StepControls
              socket={socket} roomId={roomId!}
              currentStep={currentStep} maxStep={maxStep}
              stepLockEnabled={stepLockEnabled}
              onSetStep={handleSetStep}
              onToggleStepLock={toggleStepLock}
              onOpenGate={() => setShowGateModal(true)}
              gates={gates}
            />

            {/* Iframe or Whiteboard */}
            <div className="flex-1 relative overflow-hidden m-3 rounded-xl preview-frame">
              {showTempContent && tempContent && tempContentUrl ? (
                // Temporary explanation content overlay — uses same ref so scroll sync works
                <iframe
                  ref={iframeRef}
                  src={tempContentUrl}
                  className="w-full h-full border-none"
                  style={{ background: '#ffffff' }}
                  onLoad={handleIframeLoad}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock"
                />
              ) : whiteboardMode ? (
                <Whiteboard
                  ref={whiteboardRef}
                  socket={socket}
                  roomId={roomId!}
                  isTeacher={true}
                  interactive={true}
                  zoomLevel={zoomLevel}
                  scrollX={whiteboardScrollX}
                  scrollY={whiteboardScrollY}
                  isActive={true}
                />
              ) : iframeUrl ? (
                <iframe ref={iframeRef} src={iframeUrl} className="w-full h-full border-none bg-white"
                  onLoad={handleIframeLoad}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock" />
              ) : (
                <div className="flex items-center justify-center h-full bg-[var(--bg-surface)]">
                  <div className="text-center">
                    <div className="text-5xl mb-3 opacity-30">🎯</div>
                    <h3 className="font-display text-lg font-bold text-[var(--text-muted)]">Preview</h3>
                    <p className="text-sm mt-1 text-[var(--text-muted)]">Upload or paste HTML to preview</p>
                  </div>
                </div>
              )}

              {/* Drawing/Annotation Layer */}
              <AnnotationLayer
                socket={socket} roomId={roomId!}
                drawMode={drawMode} laserMode={laserMode}
                penType={penType} penColor={penColor} penWidth={penWidth}
                iframeRef={iframeRef} interactive={true}
              />

              {/* Cursor Overlay */}
              <CursorOverlay cursors={cursors} />

              {/* Reactions */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {reactions.map(r => (
                  <div key={r.id} className="absolute text-[44px] bottom-[10%] animate-[reaction-float-up_2.5s_ease-out_forwards]"
                    style={{ left: `${20 + Math.random() * 60}%` }}>
                    {r.emoji}
                  </div>
                ))}
              </div>

              {/* Timer Display */}
              {challengeTimer && (
                <TimerDisplay seconds={challengeTimer.seconds} remaining={challengeTimer.remaining} />
              )}

              {/* Feedback Toasts */}
              <FeedbackToasts feedback={studentFeedback} />

              {/* Celebration */}
              <Celebrations show={showCelebration} type={celebrationType} />

              {/* Paused Overlay */}
              <PausedOverlay isPaused={isPaused} isTeacher={true} />
            </div>
          </div>
        )}

        {/* ──── RIGHT: Sidebar ──── */}
        <ChatPanel
          socket={socket} roomId={roomId!} userName={teacherName}
          messages={chatMessages} isOpen={chatOpen}
          onToggle={() => setChatOpen(!chatOpen)}
          variant="sidebar"
        />
      </div>

      {/* ═══ NOTIFICATION ═══ */}
      {notification && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 animate-slide-down">
          <div className="px-5 py-2.5 rounded-xl text-sm font-medium bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-subtle)] shadow-[var(--shadow-lg)]">
            {notification}
          </div>
        </div>
      )}

      {/* ═══ PASTE CODE MODAL ═══ */}
      {showPasteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(0,0,0,0.3)] backdrop-blur-[4px]">
          <div className="w-full max-w-2xl animate-bounce-in bg-[var(--bg-card)] rounded-[var(--radius-xl)] border border-[var(--border-subtle)] shadow-[var(--shadow-xl)]">
            <div className="flex items-center justify-between p-5 pb-0">
              <h3 className="font-display text-lg font-bold">📋 Paste HTML Code</h3>
              <button onClick={() => { setShowPasteModal(false); setPasteCode(''); setPasteFileName(''); }}
                className="bg-transparent border-none text-[var(--text-muted)] cursor-pointer text-[20px] hover:opacity-80">✕</button>
            </div>
            <div className="p-5 space-y-4">
              <input value={pasteFileName} onChange={(e) => setPasteFileName(e.target.value)}
                placeholder="File name (optional, e.g. fractions-sim)"
                className="input-field text-sm" />
              <textarea value={pasteCode} onChange={(e) => setPasteCode(e.target.value)}
                placeholder="Paste your HTML code here..."
                className="input-field code-editor min-h-[250px] resize-y leading-relaxed bg-[var(--bg-code)] text-[#D4D4D8]" />
              <div className="flex gap-3 justify-end">
                <button onClick={() => { setShowPasteModal(false); setPasteCode(''); setPasteFileName(''); }}
                  className="btn-secondary">Cancel</button>
                <button onClick={handlePasteSubmit} disabled={!pasteCode.trim()}
                  className="btn-primary disabled:opacity-40">
                  Add & Run ▶
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ QUIZ MODAL ═══ */}
      {showQuizModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(0,0,0,0.3)] backdrop-blur-[4px]">
          <div className="w-full max-w-md animate-bounce-in bg-[var(--bg-card)] rounded-[var(--radius-xl)] border border-[var(--border-subtle)] shadow-[var(--shadow-xl)]">
            <div className="p-5">
              <h3 className="font-display text-lg font-bold mb-4">🎯 Pop Quiz</h3>
              <textarea value={quizQuestion} onChange={(e) => setQuizQuestion(e.target.value)}
                placeholder="Type your question... e.g. What is 3/4 + 1/2?"
                className="input-field mb-4 min-h-[90px] resize-y" />
              {quizAnswers.length > 0 && (
                <div className="mb-4 p-3 rounded-xl bg-[var(--bg-surface)]">
                  <div className="text-[10px] font-bold mb-2 text-[var(--text-muted)] tracking-[0.05em]">ANSWERS RECEIVED</div>
                  {quizAnswers.map((a, i) => (
                    <div key={i} className="text-sm mb-1">
                      <span className="text-[var(--accent-indigo)] font-semibold">{a.studentName}:</span> {a.answer}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={() => { setShowQuizModal(false); setQuizQuestion(''); }} className="btn-secondary flex-1">Cancel</button>
                <button onClick={sendQuiz} disabled={!quizQuestion.trim()} className="btn-primary flex-1 disabled:opacity-40">Send Quiz</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ STEP GATE MODAL ═══ */}
      {showGateModal && (
        <StepGate
          socket={socket} roomId={roomId!}
          mode="create" step={currentStep + 1}
          onSave={(gate) => setGates(prev => ({ ...prev, [currentStep + 1]: gate }))}
          onClose={() => setShowGateModal(false)}
        />
      )}

      {/* ═══ SIMULATION LIBRARY ═══ */}
      <SimulationLibrary
        isOpen={showLibrary}
        onClose={() => setShowLibrary(false)}
        onLoad={handleLoadFromLibrary}
        currentHtml={previewHtml}
        currentName={activeFile?.name}
      />

      {/* ═══ LEADERBOARD ═══ */}
      <Leaderboard
        entries={leaderboard}
        open={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
      />

    </div>
  );
}
