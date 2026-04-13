import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { injectedSyncScript } from "../lib/syncScript";
import { stepLockScript } from "../lib/stepLockScript";
import { sessionRecorder } from "../lib/sessionRecorder";
import { sounds } from "../lib/sounds";

// ── Components ──
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

  // ── Refs ──
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const reactionIdRef = useRef(0);

  // ── Session Timer ──
  useEffect(() => {
    timerRef.current = setInterval(() => setSessionTimer(t => t + 1), 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

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
      setPreviewHtml(html);
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
    newSocket.on("interaction", (event: any) => {
      if (event.type === "SYNC_CURSOR") {
        setCursors(prev => ({
          ...prev,
          [event.userId]: {
            x: event.x, y: event.y,
            color: CURSOR_COLORS[event.userId.charCodeAt(0) % CURSOR_COLORS.length],
            name: event.userName || 'Student',
          },
        }));
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

    // ── Step-Lock events ──
    newSocket.on("gate_answered", ({ studentName, step, correct }: { studentName: string; step: number; correct: boolean }) => {
      showNotif(`${correct ? '✅' : '❌'} ${studentName} ${correct ? 'passed' : 'failed'} gate on Step ${step}`);
      if (correct) sounds.success();
    });

    return () => { newSocket.disconnect(); };
  }, [roomId, navigate, teacherName]);

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
  }, [scrollSyncEnabled, stepLockEnabled, currentStep]);

  // ── Relay iframe messages ──
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!socket) return;
      const type = e.data?.type;
      if (!type) return;

      // Internal sync events — not interactions
      if (type === 'SYNC_PROVIDE_HTML') {
        socket.emit("sync_html_update", { roomId, html: e.data.html });
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
        socket.emit("interaction", { roomId, event: e.data });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [socket, roomId, scrollSyncEnabled]);

  // ── Periodic auto-sync: every 10s, push teacher's live DOM to students ──
  useEffect(() => {
    if (!socket || !roomId) return;
    const interval = setInterval(() => {
      if (iframeRef.current?.contentWindow && iframeReadyRef.current) {
        iframeRef.current.contentWindow.postMessage({ type: 'REQUEST_HTML' }, '*');
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [socket, roomId]);

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

  // ── Attention timestamp updater ──
  useEffect(() => {
    const interval = setInterval(() => {
      setAttention(prev => ({ ...prev })); // Force re-render for time-based status
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── Helpers ──
  const showNotif = (msg: string) => { setNotification(msg); setTimeout(() => setNotification(""), 3000); };

  const uploadFileFromInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || !socket) return;
    Array.from(uploadedFiles).forEach((file: File) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
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
      reader.readAsText(file);
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
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
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
      reader.readAsText(file);
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
    postToIframe({ type: 'REQUEST_HTML' });
    setTimeout(() => {
      socket.emit("force_sync", { roomId });
      setLastSyncTime(Date.now());
      showNotif("🔄 Force Synced — all students updated");
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
    <div className="h-screen flex flex-col overflow-hidden"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDragging(false); }}
      onDrop={handleDrop}>

      {/* ═══ DROP OVERLAY ═══ */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(249,250,251,0.95)', backdropFilter: 'blur(8px)' }}>
          <div className="text-center animate-bounce-in">
            <div className="text-7xl mb-4">📂</div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent-indigo)' }}>Drop HTML files here</div>
            <div className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>They'll be added to your file library</div>
          </div>
        </div>
      )}

      {/* ═══ HEADER ═══ */}
      <header className="flex items-center justify-between px-5 shrink-0"
        style={{ height: '54px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>

        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')} className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            <span className="font-display font-extrabold text-[16px]" style={{ color: '#111318', letterSpacing: '-0.03em' }}>
              Maths<span style={{ color: '#5B5FE6' }}>Live</span>
            </span>
          </button>

          <div className="h-4 w-px hidden sm:block" style={{ background: 'var(--border-default)' }} />

          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1"
            style={{ background: 'var(--bg-surface)', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <span className="text-[10px] font-bold" style={{ color: 'var(--text-muted)', letterSpacing: '0.06em' }}>ROOM</span>
            <span className="text-[12px] font-mono font-bold" style={{ color: '#5B5FE6' }}>{roomId}</span>
          </div>

          {/* View Mode Toggles */}
          <div className="toolbar-group">
            {(['code', 'split', 'preview'] as ViewMode[]).map(mode => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={`tg-btn${viewMode === mode ? ' active-accent' : ''}`}>
                {mode === 'code' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                  </svg>
                )}
                {mode === 'split' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
                  </svg>
                )}
                {mode === 'preview' && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
                <span className="text-[12px] font-semibold capitalize">{mode}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <ConnectionStatus socket={socket} connected={connected} />

          <span className="text-[13px] font-mono hidden sm:block" style={{ color: 'var(--text-muted)' }}>
            {formatTime(sessionTimer)}
          </span>

          <div className="relative">
            <button onClick={() => setShowUserPanel(!showUserPanel)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all"
              style={{
                background: showUserPanel ? 'var(--accent-indigo-light)' : (studentCount > 0 ? 'var(--accent-emerald-light)' : 'var(--bg-surface)'),
                color: showUserPanel ? 'var(--accent-indigo)' : (studentCount > 0 ? 'var(--accent-emerald)' : 'var(--text-muted)'),
                border: '1px solid var(--border-subtle)',
                cursor: 'pointer',
              }}>
              <div className={`connection-dot ${studentCount > 0 ? 'online' : 'offline'}`}
                style={{ width: 7, height: 7 }} />
              {studentCount} {studentCount === 1 ? 'student' : 'students'}
              <span style={{ fontSize: '8px', opacity: 0.6 }}>{showUserPanel ? '▲' : '▼'}</span>
            </button>
            {showUserPanel && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUserPanel(false)} />
                <div className="absolute top-full right-0 mt-2 z-50 rounded-xl overflow-hidden animate-slide-down"
                  style={{ width: '280px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)', maxHeight: '420px', overflowY: 'auto' }}>
                  {users.length === 0 ? (
                    <div className="text-center py-8 px-4">
                      <div className="text-3xl mb-2 opacity-30">👥</div>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No participants yet</p>
                    </div>
                  ) : (
                    <UserList users={users} attention={attention} isTeacher={true} socket={socket} roomId={roomId!} />
                  )}
                </div>
              </>
            )}
          </div>

          <div className="relative">
            <button onClick={() => setShowShareMenu(!showShareMenu)}
              className={`btn text-[12px] ${linkCopied ? 'btn-accent' : ''}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
              </svg>
              {linkCopied ? 'Copied!' : 'Invite'}
            </button>
            {showShareMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowShareMenu(false)} />
                <div className="absolute top-full right-0 mt-2 z-50 animate-slide-down"
                  style={{ width: '300px', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)', padding: '16px' }}>
                  <div className="text-[11px] font-bold mb-3" style={{ color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Share with students</div>

                  <div className="flex items-center gap-2 p-2.5 rounded-lg mb-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
                    <span className="text-[12px] font-mono truncate flex-1" style={{ color: 'var(--accent-indigo)', fontWeight: 600 }}>
                      {window.location.origin}/live/{roomId}
                    </span>
                  </div>

                  <div className="mb-3">
                    <label className="block text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                      Room Passcode <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. math123"
                      value={roomPassword}
                      onChange={(e) => saveRoomPassword(e.target.value)}
                      className="input-field"
                      style={{ fontSize: '13px', padding: '8px 12px' }}
                    />
                  </div>

                  <button onClick={copyStudentLink}
                    className="btn-primary w-full justify-center"
                    style={{ height: '40px', fontSize: '13px', borderRadius: '6px', gap: '6px' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                    {roomPassword ? 'Copy Link + Passcode' : 'Copy Link'}
                  </button>

                  {roomPassword && (
                    <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--text-muted)' }}>
                      Will copy: link + passcode together
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Library */}
          <button onClick={() => setShowLibrary(true)} className="btn text-[12px] hidden sm:inline-flex" title="Simulation Library"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
            </svg>
            <span className="hidden md:inline">Library</span>
          </button>

          {/* Recording */}
          <button onClick={toggleRecording}
            className={`btn text-[12px] hidden sm:inline-flex ${isRecording ? 'btn-danger' : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
            title={isRecording ? 'Stop Recording' : 'Start Recording'}>
            {isRecording ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <circle cx="12" cy="12" r="6"/>
              </svg>
            )}
            <span className="hidden md:inline">{isRecording ? 'Stop' : 'Rec'}</span>
          </button>

          {/* Sound toggle */}
          <button onClick={() => { const m = sounds.toggleMute(); setSoundMuted(m); }}
            className="btn text-[12px]" title={soundMuted ? 'Unmute' : 'Mute'}
            style={{ display: 'inline-flex', alignItems: 'center' }}>
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
        </div>
      </header>

      {/* ═══ HAND RAISED BANNER ═══ */}
      {handRaised && (
        <div className="animate-slide-down px-4 py-2 text-center text-sm font-semibold"
          style={{ background: 'var(--accent-amber-light)', color: '#B45309', borderBottom: '1px solid rgba(245,158,11,0.2)' }}>
          ✋ {handRaised.studentName} raised their hand!
        </div>
      )}

      {/* ═══ MAIN CONTENT ═══ */}
      <div className="flex-1 flex overflow-hidden">

        {/* ──── LEFT: Files + Code Editor ──── */}
        {showLeftPanel && (
          <div className="flex flex-col overflow-hidden" style={{
            width: viewMode === 'code' ? '100%' : '40%', minWidth: viewMode === 'split' ? '320px' : undefined,
            transition: 'width 0.3s ease',
            borderRight: '1px solid var(--border-subtle)',
            background: 'var(--bg-secondary)',
          }}>
            {/* Upload Bar */}
            <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <input type="file" accept=".html,.htm" ref={fileInputRef} onChange={uploadFileFromInput} className="hidden" multiple />
              <button onClick={() => fileInputRef.current?.click()} className="btn-accent text-[12px]">
                📤 Upload HTML
              </button>
              <button onClick={() => setShowPasteModal(true)} className="btn text-[12px]">
                📋 Paste Code
              </button>
            </div>

            {/* File Tabs */}
            {files.length > 0 && (
              <div className="flex gap-1.5 px-4 py-2 overflow-x-auto shrink-0 scrollbar-hide"
                style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
                {files.map(f => (
                  <button key={f.id} onClick={() => switchFile(f.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] shrink-0 transition-all group"
                    style={{
                      background: activeFileId === f.id ? 'var(--bg-secondary)' : 'transparent',
                      color: activeFileId === f.id ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                      border: activeFileId === f.id ? '1px solid var(--border-default)' : '1px solid transparent',
                      fontWeight: activeFileId === f.id ? 600 : 400,
                      boxShadow: activeFileId === f.id ? 'var(--shadow-sm)' : 'none',
                    }}>
                    <span className="max-w-[120px] truncate">{f.name}</span>
                    <span onClick={(e) => { e.stopPropagation(); deleteFile(f.id); }}
                      className="opacity-0 group-hover:opacity-100 ml-1 cursor-pointer text-base leading-none transition-opacity"
                      style={{ color: 'var(--text-muted)' }}>×</span>
                  </button>
                ))}
              </div>
            )}

            {/* Code Area */}
            <div className="flex-1 flex flex-col overflow-hidden relative min-h-0">
              {files.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center p-8">
                  <div className="text-center max-w-sm p-10 rounded-2xl animate-slide-up"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
                    <div className="text-5xl mb-5 animate-gentle-bounce">📄</div>
                    <h3 className="font-display text-xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Empty Canvas</h3>
                    <p className="text-sm mb-8" style={{ color: 'var(--text-muted)', lineHeight: '1.6' }}>
                      Upload an HTML file or paste a code snippet to get started.
                    </p>
                    <div className="flex flex-col gap-3">
                      <button onClick={() => fileInputRef.current?.click()} className="btn-primary justify-center text-sm">
                        Browse Files
                      </button>
                      <button onClick={() => setShowPasteModal(true)} className="btn-secondary justify-center text-sm">
                        Paste Snippet
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Editor header */}
                  <div className="flex items-center justify-between px-4 py-2.5 shrink-0"
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <span className="badge badge-indigo">
                      {activeFile?.name || 'Editor'}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] font-mono hidden sm:inline" style={{ color: 'var(--text-muted)' }}>⌘+Enter</span>
                      <button onClick={runPreview} className="btn-primary text-[12px]" style={{ padding: '6px 14px' }}>
                        ▶ Run & Sync
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={htmlCode}
                    onChange={(e) => setHtmlCode(e.target.value)}
                    className="flex-1 w-full p-4 resize-none focus:outline-none code-editor"
                    style={{
                      background: 'var(--bg-code)', color: '#D4D4D8',
                      caretColor: 'var(--accent-indigo)',
                      fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', lineHeight: '1.6',
                    }}
                    spellCheck={false}
                    placeholder="Paste or write your HTML code here..."
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runPreview(); }
                      if (e.key === 'Tab') {
                        e.preventDefault();
                        const ta = e.currentTarget;
                        const start = ta.selectionStart;
                        const end = ta.selectionEnd;
                        setHtmlCode(ta.value.substring(0, start) + '  ' + ta.value.substring(end));
                        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
                      }
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}

        {/* ──── CENTER: Preview ──── */}
        {showPreview && (
          <div className="flex-1 flex flex-col relative overflow-hidden" style={{ background: 'var(--bg-primary)' }}>

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
            />

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

            {/* Iframe */}
            <div className="flex-1 relative overflow-hidden m-3 rounded-xl preview-frame">
              {iframeUrl ? (
                <iframe ref={iframeRef} src={iframeUrl} className="w-full h-full border-none"
                  style={{ background: '#ffffff' }}
                  onLoad={handleIframeLoad}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock" />
              ) : (
                <div className="flex items-center justify-center h-full" style={{ background: 'var(--bg-surface)' }}>
                  <div className="text-center">
                    <div className="text-5xl mb-3 opacity-30">🎯</div>
                    <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-muted)' }}>Preview</h3>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Upload or paste HTML to preview</p>
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
                  <div key={r.id} className="absolute"
                    style={{ left: `${20 + Math.random() * 60}%`, bottom: '10%', fontSize: '44px', animation: 'reaction-float-up 2.5s ease-out forwards' }}>
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
          <div className="px-5 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-lg)' }}>
            {notification}
          </div>
        </div>
      )}

      {/* ═══ PASTE CODE MODAL ═══ */}
      {showPasteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-2xl animate-bounce-in"
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="flex items-center justify-between p-5 pb-0">
              <h3 className="font-display text-lg font-bold">📋 Paste HTML Code</h3>
              <button onClick={() => { setShowPasteModal(false); setPasteCode(''); setPasteFileName(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
            </div>
            <div className="p-5 space-y-4">
              <input value={pasteFileName} onChange={(e) => setPasteFileName(e.target.value)}
                placeholder="File name (optional, e.g. fractions-sim)"
                className="input-field text-sm" />
              <textarea value={pasteCode} onChange={(e) => setPasteCode(e.target.value)}
                placeholder="Paste your HTML code here..."
                className="input-field code-editor"
                style={{ minHeight: '250px', resize: 'vertical', lineHeight: '1.6', background: 'var(--bg-code)', color: '#D4D4D8' }} />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-md animate-bounce-in"
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="p-5">
              <h3 className="font-display text-lg font-bold mb-4">🎯 Pop Quiz</h3>
              <textarea value={quizQuestion} onChange={(e) => setQuizQuestion(e.target.value)}
                placeholder="Type your question... e.g. What is 3/4 + 1/2?"
                className="input-field mb-4" style={{ minHeight: '90px', resize: 'vertical' }} />
              {quizAnswers.length > 0 && (
                <div className="mb-4 p-3 rounded-xl" style={{ background: 'var(--bg-surface)' }}>
                  <div className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>ANSWERS RECEIVED</div>
                  {quizAnswers.map((a, i) => (
                    <div key={i} className="text-sm mb-1">
                      <span style={{ color: 'var(--accent-indigo)', fontWeight: 600 }}>{a.studentName}:</span> {a.answer}
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
    </div>
  );
}
