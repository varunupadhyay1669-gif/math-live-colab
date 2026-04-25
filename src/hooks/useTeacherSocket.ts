import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { sessionRecorder } from '../lib/sessionRecorder';
import { sounds } from '../lib/sounds';

export interface FileEntry {
  id: string;
  name: string;
  html: string;
  uploadedAt: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  message: string;
  timestamp: number;
}

export interface Cursor {
  x: number;
  y: number;
  color: string;
  name: string;
}

export interface UserInfo {
  id: string;
  name: string;
  role: string;
}

export interface StudentAttention {
  studentId: string;
  studentName: string;
  isAttentive: boolean;
  lastSeen: number;
}

export interface GateData {
  question: string;
  options: string[];
  correctIndex: number;
}

const CURSOR_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#F43F5E", "#8B5CF6", "#EC4899", "#0EA5E9", "#F97316"];

export function useTeacherSocket(
  roomId: string,
  teacherName: string,
  onRemoteInteraction?: (event: any) => void,
  onRequestHtmlSync?: () => void
) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [htmlCode, setHtmlCode] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});

  const [isPaused, setIsPaused] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [handRaised, setHandRaised] = useState<{ studentName: string } | null>(null);
  const [quizAnswers, setQuizAnswers] = useState<Array<{ answer: string; studentName: string }>>([]);
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: string }>>([]);
  const [studentFeedback, setStudentFeedback] = useState<Array<{ id: number; emoji: string; label: string; studentName: string }>>([]);
  const [challengeTimer, setChallengeTimer] = useState<{ seconds: number; remaining: number } | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationType, setCelebrationType] = useState<'confetti' | 'fireworks' | 'stars'>('confetti');

  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(true);
  const [studentInteractionAllowed, setStudentInteractionAllowed] = useState(false);
  const [attention, setAttention] = useState<Record<string, StudentAttention>>({});
  const [attentionAcks, setAttentionAcks] = useState<Array<{ studentName: string; timestamp: number }>>([]);

  const [leaderboard, setLeaderboard] = useState<Array<{ studentName: string; xp: number; streak: number }>>([]);
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStep, setMaxStep] = useState(0);
  const [stepLockEnabled, setStepLockEnabled] = useState(false);
  const [gates, setGates] = useState<Record<number, GateData>>({});
  const [zoomLevel, setZoomLevel] = useState(1);

  const [notification, setNotification] = useState("");
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);

  const reactionIdRef = useRef(0);
  const feedbackIdRef = useRef(0);
  const skipOwnPreviewRef = useRef(false);
  const notifTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const challengeTimerRef = useRef<ReturnType<typeof setInterval>>();

  const showNotif = (msg: string) => {
    if (notifTimeoutRef.current) clearTimeout(notifTimeoutRef.current);
    setNotification(msg);
    notifTimeoutRef.current = setTimeout(() => setNotification(""), 3000);
  };

  useEffect(() => {
    if (!roomId) return;
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
      if (skipOwnPreviewRef.current) {
        skipOwnPreviewRef.current = false;
        return;
      }
      setPreviewHtml(prev => prev === html ? prev : html);
    });

    newSocket.on("chat_message", (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
      sounds.message();
      sessionRecorder.record('chat_message', msg);
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
      } else if (onRemoteInteraction) {
        const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
        onRemoteInteraction(remoteEvent);
      }
      sessionRecorder.record('interaction', event);
    });

    newSocket.on("student_feedback", ({ emoji, label, studentName }: { emoji: string; label: string; studentName: string }) => {
      const id = feedbackIdRef.current++;
      setStudentFeedback(prev => [...prev, { id, emoji, label, studentName }]);
      showNotif(`${emoji} ${studentName}: ${label}`);
      sounds.tick();
      setTimeout(() => setStudentFeedback(prev => prev.filter(f => f.id !== id)), 5000);
    });

    newSocket.on("timer_started", ({ seconds }: { seconds: number }) => {
      setChallengeTimer({ seconds, remaining: seconds });
    });

    newSocket.on("timer_stopped", () => {
      setChallengeTimer(null);
      if (challengeTimerRef.current) clearInterval(challengeTimerRef.current);
    });

    newSocket.on("celebration", ({ type }: { type?: string }) => {
      setCelebrationType((type as any) || 'confetti');
      setShowCelebration(true);
      sounds.celebration();
      setTimeout(() => setShowCelebration(false), 4000);
    });

    newSocket.on("request_html_sync", () => {
      if (onRequestHtmlSync) {
        onRequestHtmlSync();
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

    newSocket.on("student_attention", ({ studentId, studentName, isAttentive }: { studentId: string; studentName: string; isAttentive: boolean }) => {
      setAttention(prev => ({
        ...prev,
        [studentId]: { studentId, studentName, isAttentive, lastSeen: Date.now() },
      }));
    });

    newSocket.on("scroll_sync_changed", ({ enabled }: { enabled: boolean }) => {
      setScrollSyncEnabled(enabled);
    });

    newSocket.on("student_interaction_changed", ({ allowed }: { allowed: boolean }) => {
      setStudentInteractionAllowed(allowed);
    });

    newSocket.on("attention_ack", ({ studentName, timestamp }: { studentName: string; timestamp: number }) => {
      setAttentionAcks(prev => [...prev, { studentName, timestamp }]);
      showNotif(`${studentName} is here`);
    });

    newSocket.on("gate_answered", ({ studentName, step, correct }: { studentName: string; step: number; correct: boolean }) => {
      showNotif(`${correct ? '✅' : '❌'} ${studentName} ${correct ? 'passed' : 'failed'} gate on Step ${step}`);
      if (correct) sounds.success();
    });

    newSocket.on("leaderboard_update", (lb: Array<{ studentName: string; xp: number; streak: number }>) => {
      setLeaderboard(lb);
    });

    newSocket.on("room_reset", (payload?: { activeFileId?: string | null; files?: FileEntry[]; lastRunHtml?: string | null }) => {
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
      if (payload?.files) setFiles(payload.files);
      if (payload?.activeFileId !== undefined) setActiveFileId(payload.activeFileId);
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
  }, [roomId, teacherName]);

  // Challenge Timer Countdown
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

  // Sync code when active file changes
  useEffect(() => {
    if (activeFileId) {
      const file = files.find(f => f.id === activeFileId);
      if (file) { setHtmlCode(file.html); setPreviewHtml(file.html); }
    }
  }, [activeFileId, files]);

  // Attention timestamp updater
  useEffect(() => {
    const interval = setInterval(() => {
      setAttention(prev => ({ ...prev }));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return {
    socket,
    connected,
    files,
    setFiles,
    activeFileId,
    setActiveFileId,
    htmlCode,
    setHtmlCode,
    previewHtml,
    setPreviewHtml,
    users,
    cursors,
    isPaused,
    setIsPaused,
    chatMessages,
    handRaised,
    quizAnswers,
    setQuizAnswers,
    reactions,
    studentFeedback,
    challengeTimer,
    setChallengeTimer,
    showCelebration,
    celebrationType,
    scrollSyncEnabled,
    setScrollSyncEnabled,
    studentInteractionAllowed,
    setStudentInteractionAllowed,
    attention,
    attentionAcks,
    setAttentionAcks,
    leaderboard,
    currentStep,
    setCurrentStep,
    maxStep,
    setMaxStep,
    stepLockEnabled,
    setStepLockEnabled,
    gates,
    setGates,
    zoomLevel,
    setZoomLevel,
    notification,
    showNotif,
    lastSyncTime,
    setLastSyncTime,
    skipOwnPreviewRef,
    challengeTimerRef
  };
}
