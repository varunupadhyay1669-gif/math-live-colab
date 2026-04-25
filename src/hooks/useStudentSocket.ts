import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { setupAttentionDetection } from '../lib/attentionDetector';
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

export interface GateData {
  question: string;
  options: string[];
  correctIndex: number;
}

const CURSOR_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#F43F5E", "#8B5CF6", "#EC4899"];

export function useStudentSocket(
  roomId: string,
  studentName: string,
  onRemoteInteraction?: (event: any) => void,
  onResetView?: () => void
) {
  const navigate = useNavigate();

  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [currentHtml, setCurrentHtml] = useState("");
  const [currentFileName, setCurrentFileName] = useState("");
  const [isPaused, setIsPaused] = useState(false);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: string; x: number }>>([]);
  const [quizModal, setQuizModal] = useState<{ question: string } | null>(null);
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  const [notification, setNotification] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  const [laserPointer, setLaserPointer] = useState<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const [challengeTimer, setChallengeTimer] = useState<{ seconds: number; remaining: number } | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationType, setCelebrationType] = useState<'confetti' | 'fireworks' | 'stars'>('confetti');
  const [spotlight, setSpotlight] = useState<{ x: number; y: number; active: boolean } | null>(null);

  const [currentStep, setCurrentStep] = useState(999);
  const [gateModal, setGateModal] = useState<{ step: number; gate: GateData } | null>(null);

  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [interactionAllowed, setInteractionAllowed] = useState(false);
  const [whiteboardMode, setWhiteboardMode] = useState(false);
  const [whiteboardScrollX, setWhiteboardScrollX] = useState(0);
  const [whiteboardScrollY, setWhiteboardScrollY] = useState(0);

  const [myXp, setMyXp] = useState(0);
  const [myStreak, setMyStreak] = useState(0);
  const [myLevel, setMyLevel] = useState(1);
  const [xpFloater, setXpFloater] = useState<{ id: number; amount: number } | null>(null);
  const [levelUpBanner, setLevelUpBanner] = useState(false);
  const [leaderboard, setLeaderboard] = useState<Array<{ studentName: string; xp: number; streak: number }>>([]);

  const [attentionCheckModal, setAttentionCheckModal] = useState(false);
  const [teacherDisconnected, setTeacherDisconnected] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const reactionIdRef = useRef(0);
  const notifTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const attentionTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const challengeTimerRef = useRef<ReturnType<typeof setInterval>>();

  const showNotification = useCallback((msg: string) => {
    if (notifTimeoutRef.current) clearTimeout(notifTimeoutRef.current);
    setNotification(msg);
    notifTimeoutRef.current = setTimeout(() => setNotification(""), 4000);
  }, []);

  useEffect(() => {
    if (!roomId) { navigate("/"); return; }

    const newSocket = io();
    setSocket(newSocket);

    let cleanupAttention: (() => void) | null = null;

    newSocket.on("connect", () => {
      setConnected(true);
      newSocket.emit("join_room", { roomId, userName: studentName, role: 'student' });
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
      if (typeof state.studentInteractionAllowed === 'boolean') setInteractionAllowed(state.studentInteractionAllowed);
      if (typeof state.currentStep === 'number') setCurrentStep(state.currentStep);
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

    newSocket.on("active_file_changed", (data: { fileId: string; fileName?: string; html?: string; currentStep?: number }) => {
      setActiveFileId(data.fileId);
      if (typeof data.currentStep === 'number') setCurrentStep(data.currentStep);
      if (data.html) {
        setCurrentFileName(data.fileName || 'Simulation');
        setCurrentHtml(data.html);
        showNotification(`Switched to: ${data.fileName || 'new file'}`);
      }
    });

    newSocket.on("run_preview", ({ html }: { fileId: string; html: string }) => {
      setCurrentHtml(prev => prev === html ? prev : html);
    });

    newSocket.on("force_sync_state", (state: any) => {
      if (state.files) setFiles(state.files);
      if (state.activeFileId) setActiveFileId(state.activeFileId);
      if (state.lastRunHtml) {
        setCurrentHtml(prev => prev === state.lastRunHtml ? prev : state.lastRunHtml);
        const f = state.files?.find((f: FileEntry) => f.id === state.activeFileId);
        setCurrentFileName(f?.name || 'Simulation');
      }
      if (typeof state.isPaused === 'boolean') setIsPaused(state.isPaused);
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
      setUnreadChat(c => c + 1); // Component will reset this if chat is open
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
      setQuizSubmitted(false);
      showNotification("🎯 You have a question from your teacher!");
      sounds.raiseHand();
    });

    newSocket.on("spotlight", (data: { x: number; y: number; active: boolean }) => {
      setSpotlight(data.active ? data : null);
    });

    newSocket.on("interaction", (event: any) => {
      if (event.type === "SYNC_ZOOM" && typeof event.zoom === 'number') {
        setZoomLevel(event.zoom);
      }
      if (event.type === "SYNC_CURSOR") {
        setCursors(prev => ({
          ...prev,
          [event.userId]: {
            x: event.x, y: event.y,
            color: CURSOR_COLORS[event.userId.charCodeAt(0) % CURSOR_COLORS.length],
            name: event.userName || 'Teacher',
          },
        }));
      } else if (onRemoteInteraction) {
        const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
        onRemoteInteraction(remoteEvent);
      }
    });

    newSocket.on("reset_view", () => {
      if (onResetView) {
        onResetView();
      }
    });

    newSocket.on("laser_pointer", (data: { x: number; y: number; active: boolean }) => {
      setLaserPointer(data);
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

    newSocket.on("step_changed", ({ step }: { step: number }) => {
      setCurrentStep(step);
    });

    newSocket.on("scroll_sync_changed", ({ enabled }: { enabled: boolean }) => {
      setScrollSyncEnabled(enabled);
      showNotification(enabled ? '🔗 Scroll sync enabled' : '🔓 Free scroll — you can scroll independently');
    });

    newSocket.on("student_interaction_changed", ({ allowed }: { allowed: boolean }) => {
      setInteractionAllowed(allowed);
      showNotification(allowed ? '🖐️ You can now interact with the simulation' : '👁️ View-only mode — teacher is presenting');
    });

    newSocket.on("whiteboard_mode_changed", ({ active }: { active: boolean }) => {
      setWhiteboardMode(active);
    });

    newSocket.on("whiteboard_scroll", ({ scrollX, scrollY }: { scrollX: number; scrollY: number }) => {
      setWhiteboardScrollX(scrollX);
      setWhiteboardScrollY(scrollY);
    });

    newSocket.on("zoom_changed", ({ zoom }: { zoom: number }) => {
      setZoomLevel(zoom);
    });

    newSocket.on("join_error", ({ message }: { message: string }) => {
      setJoinError(message);
    });

    newSocket.on("teacher_disconnected", () => {
      setTeacherDisconnected(true);
      showNotification("⚠️ Teacher disconnected — waiting for reconnection...");
    });

    newSocket.on("user_list", (list: Array<{ role: string }>) => {
      const hasTeacher = list.some(u => u.role === 'teacher');
      if (hasTeacher && teacherDisconnected) {
        setTeacherDisconnected(false);
        showNotification("✅ Teacher reconnected!");
      }
    });

    newSocket.on("attention_check", () => {
      setAttentionCheckModal(true);
      sounds.raiseHand();
      if (attentionTimeoutRef.current) clearTimeout(attentionTimeoutRef.current);
      attentionTimeoutRef.current = setTimeout(() => setAttentionCheckModal(false), 30000);
    });

    newSocket.on("kicked", () => {
      showNotification("You have been removed from the session");
      setTimeout(() => navigate("/"), 2000);
    });

    newSocket.on("gate_result", ({ correct, xpGained, xp, streak, level, levelUp }: any) => {
      if (correct && xpGained && xpGained > 0) {
        setMyXp(xp || 0);
        setMyStreak(streak || 0);
        setMyLevel(level || 1);
        setXpFloater({ id: Date.now(), amount: xpGained });
        setTimeout(() => setXpFloater(null), 1800);
        sounds.success();
        if (levelUp) {
          setLevelUpBanner(true);
          sounds.celebration();
          setTimeout(() => setLevelUpBanner(false), 3500);
        }
      } else if (!correct) {
        setMyStreak(0);
      }
    });

    newSocket.on("leaderboard_update", (lb: Array<{ studentName: string; xp: number; streak: number }>) => {
      setLeaderboard(lb);
      const mine = lb.find(e => e.studentName === studentName);
      if (mine) {
        setMyXp(mine.xp);
        setMyStreak(mine.streak);
        setMyLevel(Math.floor(mine.xp / 100) + 1);
      }
    });

    newSocket.on("room_reset", (payload?: any) => {
      setChatMessages([]);
      setCursors({});
      setCurrentStep(999);
      setZoomLevel(1);
      setMyXp(0);
      setMyStreak(0);
      setMyLevel(1);
      setLeaderboard([]);
      setQuizModal(null);
      setGateModal(null);
      if (payload?.files) setFiles(payload.files);
      if (payload?.activeFileId !== undefined) setActiveFileId(payload.activeFileId);
      if (payload?.activeFileId && payload.files) {
        const active = payload.files.find((f: FileEntry) => f.id === payload.activeFileId);
        if (active) {
          setCurrentHtml(active.html);
          setCurrentFileName(active.name);
        }
      } else if (payload?.lastRunHtml) {
        setCurrentHtml(payload.lastRunHtml);
      }
      showNotification("🔄 Teacher restarted the session");
    });

    return () => {
      cleanupAttention?.();
      if (attentionTimeoutRef.current) clearTimeout(attentionTimeoutRef.current);
      newSocket.disconnect();
    };
  }, [roomId, studentName, navigate, teacherDisconnected, showNotification, onRemoteInteraction, onResetView]);

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

  return {
    socket,
    connected,
    currentHtml,
    setCurrentHtml,
    currentFileName,
    setCurrentFileName,
    isPaused,
    cursors,
    chatMessages,
    unreadChat,
    setUnreadChat,
    reactions,
    quizModal,
    setQuizModal,
    quizSubmitted,
    setQuizSubmitted,
    notification,
    showNotification,
    laserPointer,
    challengeTimer,
    showCelebration,
    celebrationType,
    spotlight,
    currentStep,
    gateModal,
    setGateModal,
    scrollSyncEnabled,
    zoomLevel,
    interactionAllowed,
    whiteboardMode,
    setWhiteboardMode,
    whiteboardScrollX,
    whiteboardScrollY,
    myXp,
    myStreak,
    myLevel,
    xpFloater,
    levelUpBanner,
    leaderboard,
    attentionCheckModal,
    setAttentionCheckModal,
    teacherDisconnected,
    joinError,
    attentionTimeoutRef
  };
}
