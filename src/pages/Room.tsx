import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { seededSyncScript } from "../lib/syncScript";
import { stepLockScript } from "../lib/stepLockScript";
import { DEMO_LESSON_HTML, DEMO_LESSON_NAME } from "../lib/demoLesson";
import { cleanDisplayName } from "../lib/displayName";
import { sessionRecorder } from "../lib/sessionRecorder";
import { sounds } from "../lib/sounds";
import { savedBoards, templates } from "../lib/prefs";
import { LESSON_IFRAME_SANDBOX, LESSON_IFRAME_ALLOW } from "../lib/iframeAttrs";
import SaveBoardBanner from "../components/SaveBoardBanner";

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
import StudentScreenPanel from "../components/StudentScreenPanel";
import SimulationLibrary from "../components/SimulationLibrary";
import ConnectionStatus from "../components/ConnectionStatus";
import Leaderboard from "../components/Leaderboard";
import Whiteboard from "../components/Whiteboard";
import { useAuth } from "../lib/auth";

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
  const auth = useAuth();
  // The signed-in teacher's Supabase token, mirrored into a ref so the socket
  // 'connect' handler (set up once) always reads the latest value. Sent on
  // join_room so the server can enforce class ownership (Stage 3). Undefined
  // when auth is disabled — server then skips enforcement.
  const authTokenRef = useRef<string | null>(null);
  useEffect(() => { authTokenRef.current = auth.session?.access_token ?? null; }, [auth.session]);
  const [searchParams] = useSearchParams();
  // Never teach under a raw email: Dashboard links historically passed the
  // account email as ?name= — students then saw it on cursors, chat and the
  // participants list. cleanDisplayName turns it into a humane name and
  // leaves normal names untouched.
  const teacherName = cleanDisplayName(searchParams.get('name')) || 'Teacher';
  // AUTONOMOUS: Lesson templates — when arriving with ?template=ID,
  // we hydrate the fresh room with the saved snapshot from localStorage
  // (see prefs.ts templates store). Applied at most once per session
  // via templateAppliedRef.
  const templateId = searchParams.get('template');
  const templateAppliedRef = useRef(false);

  // ── View Mode ──
  type ViewMode = 'split' | 'code' | 'preview';
  const [viewMode, setViewMode] = useState<ViewMode>(
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'preview' : 'split'
  );

  // ── Core State ──
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  // AUTONOMOUS: When the teacher opens the same room in two browser
  // tabs, only the most recently joined window owns the teacher seat
  // server-side (PR #42 takeover gate). The OLD window keeps running
  // — its student-cursor cards still update, the UI looks healthy —
  // but every teacher-only emit silently fails the requireTeacher
  // check. The tutor would think "sync is broken" without realising
  // they're on the wrong tab. This banner makes the demotion explicit
  // and disables all write actions on the dethroned tab until the
  // user reloads.
  const [teacherReplaced, setTeacherReplaced] = useState(false);
  // Server rejected this teacher join (ownership enforcement, or another
  // teacher already seated). Surfaces a blocking banner instead of failing
  // silently.
  const [joinErrorMsg, setJoinErrorMsg] = useState<string | null>(null);
  // Saving the current board to this student's history (Stage 4).
  const [savingHistory, setSavingHistory] = useState(false);
  const sessionParam = searchParams.get('session');
  const sessionAppliedRef = useRef(false);
  // AUTONOMOUS: Miro-style claim status.
  // claimed=false → 24h auto-expiry; banner shows "X left to save".
  // claimed=true  → 30d expiry; banner hidden.
  // expiresAt is server-authoritative; we just countdown locally.
  const [claimed, setClaimed] = useState(false);
  const [claimedBy, setClaimedBy] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [savingBoard, setSavingBoard] = useState(false);
  // AUTONOMOUS: Tracks whether we've successfully connected at least once.
  // The "connect" event fires on initial connect AND on every reconnect;
  // we want to distinguish them to drive the re-seed-server-with-cached-
  // HTML logic (only re-seed on reconnects, not the first connect).
  const hasEverConnectedRef = useRef(false);
  // Refs that mirror state we need to read from inside the socket
  // setup useEffect (which has a small dep list and would otherwise
  // see stale closure values).
  const previewHtmlRef = useRef('');
  const activeFileIdRef = useRef<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [htmlCode, setHtmlCode] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  // Server-issued deterministic RNG seed for the current lesson - injected
  // into the sim so the teacher and every student draw the same Math.random()
  // sequence (keeps non-deterministic sims, e.g. random quizzes, in lockstep).
  const [randomSeed, setRandomSeed] = useState(0);
  // AUTONOMOUS: keep ref in sync so the connect handler can read the
  // current value without going stale.
  useEffect(() => { previewHtmlRef.current = previewHtml; }, [previewHtml]);
  useEffect(() => { activeFileIdRef.current = activeFileId; }, [activeFileId]);
  const [iframeUrl, setIframeUrl] = useState("");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});

  // ── Feature State ──
  const [isPaused, setIsPaused] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [showQuizModal, setShowQuizModal] = useState(false);
  const [quizQuestion, setQuizQuestion] = useState("");
  // Optional multiple-choice answers. ≥2 non-blank → students get tap-to-answer
  // buttons; otherwise the quiz stays free-text exactly as before.
  const [quizOptions, setQuizOptions] = useState<string[]>(["", "", "", ""]);
  const [quizAnswers, setQuizAnswers] = useState<Array<{ answer: string; studentName: string }>>([]);
  const [handRaised, setHandRaised] = useState<{ studentName: string } | null>(null);
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: string }>>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [notification, setNotification] = useState("");
  const [sessionTimer, setSessionTimer] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteCode, setPasteCode] = useState("");
  // AI lesson generation
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // AUTONOMOUS: "Explain over this" can be a file OR pasted HTML.
  // showExplainModal opens a small chooser; the user picks file or
  // types HTML into the inline textarea. Separate from the main paste
  // flow (showPasteModal) because that flow adds to room.files,
  // whereas explanation submits via show_temp_content.
  const [showExplainModal, setShowExplainModal] = useState(false);
  const [explainHtml, setExplainHtml] = useState("");
  const [explainName, setExplainName] = useState("");
  const [pasteFileName, setPasteFileName] = useState("");

  // ── Drawing & Annotation ──
  const [drawMode, setDrawMode] = useState(false);
  const [laserMode, setLaserMode] = useState(false);
  // Annotation eraser tool (overlay-on-iframe). 'off' by default; 'stroke'
  // deletes whole strokes by click; 'pixel' drags to cut.
  const [eraserMode, setEraserMode] = useState<'off' | 'stroke' | 'pixel'>('off');
  // Annotation shape tool (overlay-on-iframe). 'off' by default; click and
  // drag commits a vector shape using the current pen colour and width.
  const [shapeTool, setShapeTool] = useState<'off' | 'line' | 'rect' | 'circle' | 'arrow'>('off');
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
    const scripts = seededSyncScript(randomSeed) + stepLockScript;
    let content = tempContent.html;
    if (content.includes("<head>")) {
      content = content.replace("<head>", "<head>" + scripts);
    } else {
      content = scripts + content;
    }
    const blob = new Blob([content], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [tempContent?.html, tempContent?.name, randomSeed]);

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
  const [whiteboardState, setWhiteboardState] = useState<any>(null);
  // AUTONOMOUS: Persisted HTML-overlay annotations. Snapshot arrives
  // with room_state / session_state / sync_full_state; AnnotationLayer
  // re-seeds its strokes from this on every update so a reconnect or
  // late-join shows the canonical canvas.
  const [annotations, setAnnotations] = useState<Array<{ senderId: string; stroke: any }> | undefined>(undefined);
  const whiteboardRef = useRef<import('../components/Whiteboard').WhiteboardRef>(null);

  // ── Student Interaction Mode ──
  const [studentInteractionAllowed, setStudentInteractionAllowed] = useState(false);

  // ── Whiteboard Mutual Sync (Miro/Canva "shared book" model) ──
  // Default ON — both sides see each other's pan/zoom in real time. Toggle
  // off to get an independent canvas for either side. `peerSyncEnabled`
  // tracks whether the OTHER side currently has sync on (purely for the
  // "Independent" badge; the local side is the one that drives this side's
  // emit/receive behaviour).
  const [whiteboardSyncEnabled, setWhiteboardSyncEnabled] = useState(true);
  const [peerSyncEnabled, setPeerSyncEnabled] = useState(true);

  // ── Attention Check ──
  const [attentionAcks, setAttentionAcks] = useState<Array<{ studentName: string; timestamp: number }>>([]);
  const [attentionCheckActive, setAttentionCheckActive] = useState(false);

  // ── Follow Clicks ──
  const [followStudentClicks, setFollowStudentClicks] = useState(false);
  const [studentClickIndicators, setStudentClickIndicators] = useState<Array<{ id: number; x: number; y: number; name: string; color: string }>>([]);
  // Ref-mirror for the socket "interaction" listener — that listener is
  // installed inside a useEffect with a small dep list, so the closure
  // captures followStudentClicks at mount-time. Without this ref, toggling
  // the button after mount silently does nothing because the listener still
  // sees the stale value.
  const followStudentClicksRef = useRef(false);
  useEffect(() => { followStudentClicksRef.current = followStudentClicks; }, [followStudentClicks]);

  // ── Iframe readiness ──
  const iframeReadyRef = useRef(false);
  const pendingMessagesRef = useRef<any[]>([]);

  // ── Dual View (split: teacher | student mirror) ──
  const [dualView, setDualView] = useState(false);
  const dualViewRef = useRef(false);
  useEffect(() => { dualViewRef.current = dualView; }, [dualView]);
  const mirrorIframeRef = useRef<HTMLIFrameElement>(null);
  const mirrorReadyRef = useRef(false);
  const pendingMirrorMessagesRef = useRef<any[]>([]);

  // ── Step-Lock ──
  const [stepLockEnabled, setStepLockEnabled] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStep, setMaxStep] = useState(0);
  const [gates, setGates] = useState<Record<number, GateData>>({});
  const [showGateModal, setShowGateModal] = useState(false);

  // ── Control handoff ("the chalk") ──
  const [controlHolderName, setControlHolderName] = useState<string | null>(null);
  // ── Student Peek (view a student's real screen) ──
  const [peekStudent, setPeekStudent] = useState<{ id: string; name: string } | null>(null);
  const [peekHtml, setPeekHtml] = useState<string | null>(null);
  const [peekUpdatedAt, setPeekUpdatedAt] = useState(0);
  const peekStudentRef = useRef<{ id: string; name: string } | null>(null);
  useEffect(() => { peekStudentRef.current = peekStudent; }, [peekStudent]);
  // ── Lesson Time Machine ──
  const [bookmarks, setBookmarks] = useState<Array<{ id: string; name: string; ts: number }>>([]);
  const [showTimeMachine, setShowTimeMachine] = useState(false);

  // ── Attention Detection ──
  const [attention, setAttention] = useState<Record<string, StudentAttention>>({});

  // ── Simulation Library ──
  const [showLibrary, setShowLibrary] = useState(false);

  // ── Recording ──
  const [isRecording, setIsRecording] = useState(false);
  // Ref-mirror, same reasoning as followStudentClicksRef above. Without this
  // the socket "interaction" listener captured isRecording=false at mount and
  // never recorded anything even after the user clicked Record.
  const isRecordingRef = useRef(false);
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

  // ── Sound ──
  // AUTONOMOUS: [ORDER-2 ESSENTIAL] - hydrate from persisted mute pref so the
  // toggle survives reloads instead of resetting on every page load.
  const [soundMuted, setSoundMuted] = useState(() => sounds.isMuted());

  // ── User Panel ──
  const [showUserPanel, setShowUserPanel] = useState(false);

  // AUTONOMOUS: [ORDER-2 ESSENTIAL] - beforeunload guard.
  // The server persists every 5 minutes, so an accidental tab close can lose
  // up to 5 min of work between saves. We install a "Leave site?" prompt
  // when there's something in the room worth saving — uploaded HTML or any
  // whiteboard activity. Browsers show a generic dialog (the message is
  // ignored by Chrome/Firefox/Safari), but the prompt itself is enough to
  // catch the "Cmd+W with five other tabs open" mistake.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const hasFiles = files.length > 0;
      const hasIframe = !!iframeUrl;
      const hasWhiteboardActivity = whiteboardMode ||
        ((whiteboardState?.objects?.length ?? 0) > 0) ||
        ((whiteboardState?.strokes?.length ?? 0) > 0) ||
        ((whiteboardState?.shapes?.length ?? 0) > 0);
      if (!hasFiles && !hasIframe && !hasWhiteboardActivity) return;
      e.preventDefault();
      // Required for the prompt in older browsers.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [files.length, iframeUrl, whiteboardMode, whiteboardState]);

  // ── Room Password ──
  const [roomPassword, setRoomPassword] = useState<string>('');
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [shareMenuPos, setShareMenuPos] = useState<{ top: number; right: number; width: number }>({
    top: 72,
    right: 16,
    width: 420,
  });

  // ── Flag to skip our own run_preview echo ──
  const skipOwnPreviewRef = useRef(false);
  const syncEpochRef = useRef(0);
  const lastInboundSeqRef = useRef(0);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotRequestRef = useRef<string | null>(null);
  const lastRevisionRef = useRef(0);
  // Last DOM we broadcast — lets the idle heartbeat skip identical re-sends.
  const lastSentSnapshotRef = useRef<string>('');

  // THE single entry point for changing the lesson sim's HTML. Dedupe lives
  // here (identical html → no rebuild, sim instance survives) and a genuine
  // change zeroes the applied-seq tracker SYNCHRONOUSLY — it belongs to the
  // sim instance, so the next journal replay re-lives the lesson into the
  // fresh sim from seq 0. (See the matching helper in StudentView.)
  const setSimPreviewHtml = useCallback((html: string | null | undefined) => {
    if (typeof html !== 'string' || html.length === 0) return;
    setPreviewHtml((prev: string) => {
      if (prev === html) return prev;
      lastInboundSeqRef.current = 0; // idempotent — safe under StrictMode double-invoke
      return html;
    });
  }, []);

  const applySessionState = useCallback((state: any) => {
    if (typeof state.revision === 'number') {
      if (state.revision < lastRevisionRef.current) return;
      lastRevisionRef.current = state.revision;
    }
    if (state.files) setFiles(state.files);
    if (state.activeFileId !== undefined) setActiveFileId(state.activeFileId);
    if (typeof state.isPaused === 'boolean') setIsPaused(state.isPaused);
    if (typeof state.scrollSyncEnabled === 'boolean') setScrollSyncEnabled(state.scrollSyncEnabled);
    if (typeof state.studentInteractionAllowed === 'boolean') setStudentInteractionAllowed(state.studentInteractionAllowed);
    if (typeof state.currentStep === 'number') setCurrentStep(state.currentStep);
    if (typeof state.zoomLevel === 'number') setZoomLevel(state.zoomLevel);
    if (state.gates) setGates(state.gates);
    if (typeof state.randomSeed === 'number') setRandomSeed(state.randomSeed);
    if ('controlHolderName' in state) setControlHolderName(state.controlHolderName ?? null);
    if (Array.isArray(state.bookmarks)) setBookmarks(state.bookmarks);
    if (state.tempContent) {
      setTempContent(state.tempContent);
      setShowTempContent(true);
    } else if ('tempContent' in state) {
      // Reconnect after a clear: explicitly tear down. Without this, the
      // local temp-content view would stay mounted forever.
      setTempContent(null);
      setShowTempContent(false);
    }
    if (state.whiteboard) setWhiteboardState(state.whiteboard);
    if (Array.isArray(state.annotations)) setAnnotations(state.annotations);
    // Whiteboard mode is server-persisted; restore on reconnect so the
    // teacher lands on the same surface they were on before disconnect.
    if (typeof state.whiteboardMode === 'boolean') setWhiteboardMode(state.whiteboardMode);
    // AUTONOMOUS: Claim status — drives the "X hours left to save" banner.
    if (typeof state.claimed === 'boolean') setClaimed(state.claimed);
    if (state.claimedBy !== undefined) setClaimedBy(state.claimedBy);
    if (typeof state.expiresAt === 'number') setExpiresAt(state.expiresAt);
    const html = state.effectiveHtml || state.liveSnapshotHtml || state.lastRunHtml || state.sourceHtml;
    if (html) {
      setHtmlCode(state.sourceHtml || html);
      setSimPreviewHtml(html);
    }
    setLastSyncTime(Date.now());
  }, []);

  // ── Refs ──
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Re-anchor a remote SYNC_CURSOR to the element the sender was hovering,
  // resolved against THIS client's iframe layout (same-origin). Raw viewport
  // percentages put the cursor an option or two off whenever layouts differ
  // (centered fixed-width lessons, different window sizes). Falls back to the
  // sender's viewport fractions when the path doesn't resolve.
  const resolveCursorPosition = useCallback((event: any): { x: number; y: number } => {
    try {
      if (event?.path && iframeRef.current) {
        const doc = iframeRef.current.contentDocument;
        const el = doc?.querySelector(event.path);
        const iw = iframeRef.current.clientWidth;
        const ih = iframeRef.current.clientHeight;
        if (el && iw > 0 && ih > 0) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const ex = typeof event.ex === 'number' && isFinite(event.ex) ? Math.max(0, Math.min(1, event.ex)) : 0.5;
            const ey = typeof event.ey === 'number' && isFinite(event.ey) ? Math.max(0, Math.min(1, event.ey)) : 0.5;
            const x = (r.left + ex * r.width) / iw;
            const y = (r.top + ey * r.height) / ih;
            if (isFinite(x) && isFinite(y)) {
              return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
            }
          }
        }
      }
    } catch { /* detached iframe — fall through */ }
    return { x: event?.x ?? 0, y: event?.y ?? 0 };
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inviteButtonRef = useRef<HTMLButtonElement>(null);
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

  const updateShareMenuPosition = useCallback(() => {
    if (!inviteButtonRef.current || typeof window === 'undefined') return;
    const rect = inviteButtonRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const panelWidth = Math.min(420, Math.max(280, viewportWidth - 24));
    const right = Math.max(12, viewportWidth - rect.right);
    const top = rect.bottom + 10;
    setShareMenuPos({ top, right, width: panelWidth });
  }, []);

  const toggleShareMenu = useCallback(() => {
    if (showShareMenu) {
      setShowShareMenu(false);
      return;
    }
    updateShareMenuPosition();
    setShowShareMenu(true);
  }, [showShareMenu, updateShareMenuPosition]);

  useEffect(() => {
    if (!showShareMenu) return;
    updateShareMenuPosition();
    const handleViewportChange = () => updateShareMenuPosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [showShareMenu, updateShareMenuPosition]);

  // ── Socket Connection ──
  useEffect(() => {
    if (!roomId) { navigate("/"); return; }
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on("connect", () => {
      const wasReconnect = hasEverConnectedRef.current;
      hasEverConnectedRef.current = true;
      setConnected(true);
      // Revision guard resets on (re)connect (a recreated room restarts
      // revisions at 0; re-applying identical state is harmless).
      lastRevisionRef.current = 0;
      // lastInboundSeqRef is deliberately NOT reset: it now tracks the
      // highest serverSeq THIS SIM INSTANCE applied, which is what lets the
      // journal replay fill exactly the missed gap after a reconnect without
      // double-applying. It resets only when the iframe genuinely rebuilds.
      // (The room-recreated-at-seq-0 edge resolves itself: fresh rooms have
      // fresh content → the iframe rebuilds → the tracker resets with it.)
      // Re-claim the teacher seat on (re)connect. If a different tab is
      // already in the room we'll be allowed (same name) and that other
      // tab will receive a `teacher_replaced` notification.
      setTeacherReplaced(false);
      newSocket.emit("join_room", { roomId, userName: teacherName, role: 'teacher', authToken: authTokenRef.current ?? undefined });

      // AUTONOMOUS: On a reconnect (NOT the initial connect), re-seed the
      // server with our cached HTML state. Render's free tier filesystem
      // is ephemeral — between teacher upload and student join, a
      // redeploy can wipe the .rooms/ JSON and the server has no record
      // of the lesson HTML, while THIS browser still has it loaded.
      // Re-emitting run_preview after reconnect makes the teacher's
      // local state the source of truth for the server. Idempotent —
      // bumps revision and broadcasts; students with the same content
      // already see no change (setPreviewHtml is value-equality
      // checked).
      if (wasReconnect && activeFileIdRef.current && previewHtmlRef.current) {
        newSocket.emit("run_preview", {
          roomId,
          fileId: activeFileIdRef.current,
          html: previewHtmlRef.current,
        });
        console.info('[reconnect] re-seeded server with cached HTML');
      }
    });
    newSocket.on("disconnect", () => setConnected(false));

    // AUTONOMOUS: deposed by another tab — show the banner and stop
    // pretending we still own the teacher seat. We DON'T navigate away
    // or close the tab automatically; the user might want to read what
    // they had open. Just block writes (UI-side) and tell them clearly.
    newSocket.on("teacher_replaced", () => setTeacherReplaced(true));
    newSocket.on("join_error", ({ message }: { message: string }) => {
      setJoinErrorMsg(message || 'Unable to join this room.');
    });

    // AUTONOMOUS: Room claim broadcast — fires when ANYONE in the room
    // clicks "Save to my boards". Banner hides for everyone (the room is
    // now safe for 30 days), expiry advances accordingly.
    newSocket.on("room_claimed", (data: { claimed: boolean; claimedBy: string | null; expiresAt: number }) => {
      setClaimed(!!data.claimed);
      setClaimedBy(data.claimedBy ?? null);
      if (typeof data.expiresAt === 'number') setExpiresAt(data.expiresAt);
      setSavingBoard(false);
    });

    newSocket.on("room_state", (state: any) => {
      applySessionState(state);
      setFiles(state.files || []);
      setActiveFileId(state.activeFileId);
      setIsPaused(state.isPaused);
      if (typeof state.scrollSyncEnabled === 'boolean') setScrollSyncEnabled(state.scrollSyncEnabled);
      if (typeof state.studentInteractionAllowed === 'boolean') setStudentInteractionAllowed(state.studentInteractionAllowed);
      setUsers(state.users || []);
      setChatMessages(state.chat || []);
      if (typeof state.revision === 'number') lastRevisionRef.current = state.revision;
      if (state.activeFileId && state.files) {
        const f = state.files.find((f: FileEntry) => f.id === state.activeFileId);
        if (state.lastRunHtml) {
          setHtmlCode(state.lastRunHtml);
          setSimPreviewHtml(state.lastRunHtml);
        } else if (f) { setHtmlCode(f.html); setSimPreviewHtml(f.html); }
      }
    });

    newSocket.on("session_state", applySessionState);
    newSocket.on("sync_full_state", applySessionState);

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
    // Server flips whiteboardMode off on upload so the new HTML actually
    // reaches the student — mirror it locally so the teacher's own surface
    // also follows the file, instead of staying stuck on the whiteboard.
    newSocket.on("whiteboard_mode_changed", ({ active }: { active: boolean }) => {
      setWhiteboardMode(active);
    });
    newSocket.on("upload_error", ({ message }: { message: string }) => {
      showNotif(`⚠️ Upload failed: ${message}`);
    });
    newSocket.on("generate_lesson_done", ({ name }: { name: string }) => {
      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
      setAiGenerating(false);
      setShowAiModal(false);
      setAiPrompt("");
      setAiError(null);
      showNotif(`✨ Generated & loaded: ${name}`);
    });
    newSocket.on("generate_lesson_error", ({ message }: { message: string }) => {
      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
      setAiGenerating(false);
      setAiError(message || 'AI generation failed.');
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
    newSocket.on("run_preview", ({ html, revision }: { fileId: string; html: string; revision?: number }) => {
      if (typeof revision === 'number') {
        if (revision < lastRevisionRef.current) return;
        lastRevisionRef.current = revision;
      }
      // Skip if this is our own echo from run_preview we just emitted
      if (skipOwnPreviewRef.current) {
        skipOwnPreviewRef.current = false;
        return;
      }
      // Only rebuild iframe if HTML actually changed
      setSimPreviewHtml(html);
    });
    newSocket.on("chat_message", (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
      sounds.message();
      if (isRecordingRef.current) sessionRecorder.record('chat_message', msg);
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
      // Do NOT filter by syncEpoch here. syncEpoch is a per-client local counter
      // (not coordinated by the server), so comparing a student's epoch to the
      // teacher's would silently drop every student event whenever the two
      // counters drift — e.g. after a teacher-only state change. serverSeq above
      // already prevents stale/replayed events.
      if (event.type === "SYNC_CURSOR") {
        // Element-anchored: place the student's cursor on the same CONTENT in
        // OUR layout (see resolveCursorPosition) — raw viewport percentages
        // drift across differing window sizes / centered content.
        const pos = resolveCursorPosition(event);
        setCursors(prev => ({
          ...prev,
          [event.userId]: {
            x: pos.x, y: pos.y,
            color: CURSOR_COLORS[event.userId.charCodeAt(0) % CURSOR_COLORS.length],
            name: cleanDisplayName(event.userName) || 'Student',
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

          // Auto-scroll to student click if following is enabled.
          // Read through the ref so toggling Follow-Clicks AFTER mount actually
          // takes effect (the surrounding useEffect captures the closure once).
          if (followStudentClicksRef.current && iframeRef.current) {
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
        if (dualViewRef.current && mirrorIframeRef.current?.contentWindow) {
          if (mirrorReadyRef.current) {
            mirrorIframeRef.current.contentWindow.postMessage(remoteEvent, '*');
          } else if (pendingMirrorMessagesRef.current.length < 500) {
            pendingMirrorMessagesRef.current.push(remoteEvent);
          }
        }
      } else {
        const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
        postToIframe(remoteEvent);
        if (dualViewRef.current && mirrorIframeRef.current?.contentWindow) {
          if (mirrorReadyRef.current) {
            mirrorIframeRef.current.contentWindow.postMessage(remoteEvent, '*');
          } else if (pendingMirrorMessagesRef.current.length < 500) {
            pendingMirrorMessagesRef.current.push(remoteEvent);
          }
        }
      }
      // Same stale-closure reasoning: read through the ref so flipping Record
      // on after mount actually starts recording from that moment forward.
      if (isRecordingRef.current) sessionRecorder.record('interaction', event);
    });

    // ── Student absolute-state snapshot ──
    // INTENTIONALLY NOT applied to the teacher's iframe anymore.
    //
    // We run a single-authoritative-sim model: the teacher's iframe is the live,
    // interactive simulation; the student is a mirror whose own handlers are
    // stripped, so its clicks just relay up to us and drive THIS sim (replayed
    // as REMOTE_CLICK), and we broadcast the result back via live_dom. In that
    // model the student's DOM is only ever an echo of ours — so soft-swapping it
    // back onto the teacher was redundant AND destructive: an innerHTML swap
    // drops every addEventListener the lesson wired up on load, after which the
    // teacher's buttons (and the relayed student clicks) hit dead handlers. That
    // was the "interactive buttons stop working / next-step button does nothing"
    // bug. The teacher already sees the student's exact state because both run
    // the same authoritative sim. (syncScript also hard-guards this: a presenter
    // iframe ignores REMOTE_DOM.)
    newSocket.on("student_state", (_data: { html: string; studentId?: string; studentName?: string }) => {
      /* no-op — see comment above */
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
    newSocket.on("request_html_sync", ({ requestId }: { requestId?: string } = {}) => {
      // Primary path: ask the iframe for its current DOM via syncScript.
      postToIframe({ type: 'REQUEST_HTML', requestId: requestId || `teacher-${Date.now()}` });

      // AUTONOMOUS: Belt-and-braces fallback. The iframe might not
      // respond promptly (still loading, syncScript hasn't injected, the
      // teacher is on whiteboard mode so no iframe is visible). A
      // student joining right now is stuck on "Waiting for teacher" until
      // the chain unwinds. So we ALSO re-emit run_preview from the
      // teacher's local cache — server stores it as canonical, then
      // delivers run_preview to every pending student. Idempotent: if
      // the iframe DOES respond later, the dom_snapshot will overwrite
      // with the same content.
      // Edge: only fires when there's actually HTML to send. Teacher on
      // a blank whiteboard with no HTML uploaded → no fallback needed.
      if (previewHtmlRef.current && activeFileIdRef.current) {
        newSocket.emit("run_preview", {
          roomId,
          fileId: activeFileIdRef.current,
          html: previewHtmlRef.current,
        });
        console.info('[sync] teacher re-seeded HTML from cache in response to request_html_sync');
      }
    });
    newSocket.on("force_sync_state", (state: any) => {
      if (typeof state.revision === 'number') {
        if (state.revision < lastRevisionRef.current) return;
        lastRevisionRef.current = state.revision;
      }
      if (state.activeFileId && state.lastRunHtml) {
        // Equality short-circuit (parity with StudentView): a duplicated
        // force_sync_state with the same html shouldn't trip the iframe-URL
        // useEffect to rebuild. React 18's setState bail handles it for
        // identical strings, but being explicit makes the intent obvious.
        setSimPreviewHtml(state.lastRunHtml);
        setActiveFileId(prev => prev === state.activeFileId ? prev : state.activeFileId);
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

    // ── Whiteboard Mutual Sync ──
    newSocket.on("whiteboard_sync_changed", ({ userId, enabled }: { userId: string; userName: string; enabled: boolean }) => {
      // Self-echo: keep local in lock-step with the canonical server value
      // in case anyone reasons about it across reconnects.
      if (userId === newSocket.id) {
        setWhiteboardSyncEnabled(enabled);
      } else {
        // It's the other side. For 1-on-1 there's only one peer, so we
        // overwrite directly.
        setPeerSyncEnabled(enabled);
      }
    });

    // ── Attention Check Acks ──
    newSocket.on("attention_ack", ({ studentName, timestamp }: { studentName: string; timestamp: number }) => {
      setAttentionAcks(prev => [...prev, { studentName, timestamp }]);
      showNotif(`${studentName} is here`);
    });

    // ── Step-Lock events ──
    // ── Event-journal replay (teacher reload convergence) ──
    // A reloaded teacher boots the PRISTINE lesson (effectiveHtml policy) and
    // re-lives the journal — their authoritative sim returns to exactly the
    // state the class is at. Seq-filtered against what this sim instance
    // already applied, so a mere socket blip replays nothing.
    newSocket.on("interaction_replay", ({ events }: { events: any[] }) => {
      if (!Array.isArray(events) || events.length === 0) return;
      let applied = 0;
      for (const ev of events.slice(0, 400)) {
        if (!ev || typeof ev.type !== 'string' || !ev.type.startsWith('SYNC_')) continue;
        if (typeof ev.serverSeq !== 'number' || ev.serverSeq <= lastInboundSeqRef.current) continue;
        lastInboundSeqRef.current = ev.serverSeq;
        postToIframe({ ...ev, type: ev.type.replace('SYNC_', 'REMOTE_') });
        applied++;
      }
      if (applied > 0) showNotif(`⚡ Restored your lesson — replayed ${applied} steps`);
    });

    // ── Control handoff ──
    newSocket.on("control_changed", ({ holderName }: { holderName: string | null }) => {
      setControlHolderName(holderName);
      showNotif(holderName ? `✋ ${holderName} now has control` : '👁️ You took back control');
    });

    // ── Student peek: a student answered our snapshot request ──
    newSocket.on("student_snapshot", ({ html, studentId, studentName }: { html: string; studentId: string; studentName: string }) => {
      const peeking = peekStudentRef.current;
      if (peeking && peeking.id === studentId) {
        setPeekHtml(html);
        setPeekUpdatedAt(Date.now());
      } else if (peeking && peeking.name === studentName) {
        // Student reconnected with a new socket id mid-peek — re-anchor.
        setPeekStudent({ id: studentId, name: studentName });
        setPeekHtml(html);
        setPeekUpdatedAt(Date.now());
      }
    });

    // ── Time Machine: bookmark list changed ──
    newSocket.on("bookmarks_changed", ({ bookmarks: bm }: { bookmarks: Array<{ id: string; name: string; ts: number }> }) => {
      setBookmarks(bm || []);
    });

    newSocket.on("gate_answered", ({ studentName, step, correct }: { studentName: string; step: number; correct: boolean }) => {
      showNotif(`${correct ? '✅' : '❌'} ${studentName} ${correct ? 'passed' : 'failed'} gate on Step ${step}`);
      if (correct) sounds.success();
    });

    // ── Gamification ──
    newSocket.on("leaderboard_update", (lb: Array<{ studentName: string; xp: number; streak: number }>) => {
      setLeaderboard(lb);
    });

    // ── Room Hard Reset (files are PRESERVED — only progress/session state is cleared) ──
    newSocket.on("room_reset", (payload?: { activeFileId?: string | null; files?: FileEntry[]; lastRunHtml?: string | null; revision?: number }) => {
      // Track the bumped revision so subsequent session_state isn't dropped
      // by the freshness guard against this client's pre-reset value.
      if (typeof payload?.revision === 'number' && payload.revision > lastRevisionRef.current) {
        lastRevisionRef.current = payload.revision;
      }
      // Clear session progress/state
      setChatMessages([]);
      setCursors({});
      setCurrentStep(1);
      setMaxStep(0);
      setGates({});
      setStepLockEnabled(false);
      setZoomLevel(1);
      // Server unpauses on reset (room.isPaused = false); mirror it locally so a
      // reset-while-paused doesn't leave the PausedOverlay stuck on screen.
      setIsPaused(false);
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
          setSimPreviewHtml(active.html);
        }
      }
      showNotif("🔄 Session reset — starting from the beginning");
    });

    return () => { newSocket.disconnect(); };
  }, [roomId, navigate, teacherName]);

  // ── Apply lesson template (one-shot, on fresh-room mount) ──
  // AUTONOMOUS: When the teacher opens a new room with ?template=ID,
  // hydrate the fresh canvas with the saved snapshot. We wait for the
  // initial room_state to land (whiteboardState !== null OR a beat after
  // connect) so the server has acknowledged our teacher seat — emitting
  // whiteboard_add_shape etc. before that would be rejected by the
  // requireTeacher gate on the server.
  //
  // Idempotent guards:
  //   1) templateAppliedRef — apply at most once per page load
  //   2) "is the whiteboard already populated?" — if shapes/texts/etc
  //      already exist (eg the user refreshed the URL with ?template=
  //      still present), do NOT re-apply. Just strip the param.
  //   3) URL param is cleared after applying so any future refresh of
  //      this tab is a no-op.
  useEffect(() => {
    if (!socket || !connected || !roomId || !templateId) return;
    if (templateAppliedRef.current) return;
    // Wait until we've received at least one room_state (lastSyncTime is
    // set by applySessionState) so we know our teacher seat is registered
    // server-side. Emitting whiteboard_add_* before that point would be
    // rejected by the server's requireTeacher gate.
    if (!lastSyncTime) return;

    templateAppliedRef.current = true; // claim the slot before doing work

    // Always clear the URL param so refresh/share doesn't re-apply.
    const stripTemplateParam = () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('template');
        window.history.replaceState({}, '', url.toString());
      } catch { /* tolerate non-browser env */ }
    };

    const tpl = templates.get(templateId);
    if (!tpl) {
      // Template not found in this browser's localStorage — perhaps the
      // user followed a link from another device. Nothing to apply.
      stripTemplateParam();
      return;
    }

    // If the room already has any whiteboard content, don't pile the
    // template on top. The user either refreshed or someone else
    // already populated the room — treat as no-op.
    const wb: any = whiteboardState || {};
    const hasContent =
      (wb.objects?.length ?? 0) > 0 ||
      (wb.strokes?.length ?? 0) > 0 ||
      (wb.shapes?.length ?? 0) > 0 ||
      (wb.texts?.length ?? 0) > 0 ||
      (wb.instruments?.length ?? 0) > 0;
    if (hasContent) {
      stripTemplateParam();
      return;
    }

    // Apply the template by replaying each item as an add-event. The
    // server validates and persists each one, then broadcasts to all
    // members of the room — including ourselves. So our local
    // whiteboardState catches up via the normal Whiteboard component
    // listeners, no double-render needed.
    const snap: any = tpl.whiteboard || {};
    try {
      if (snap.gridMode) socket.emit('whiteboard_set_grid_mode', { roomId, gridMode: snap.gridMode });
      for (const shape of (snap.shapes || [])) socket.emit('whiteboard_add_shape', { roomId, shape });
      for (const text of (snap.texts || [])) socket.emit('whiteboard_add_text', { roomId, text });
      for (const inst of (snap.instruments || [])) socket.emit('whiteboard_add_instrument', { roomId, instrument: inst });
      for (const obj of (snap.objects || [])) socket.emit('whiteboard_add_image', { roomId, object: obj });
      for (const stroke of (snap.strokes || [])) socket.emit('whiteboard_draw', { roomId, stroke });
      // Flip into whiteboard mode so the teacher sees the result. The
      // server broadcasts whiteboard_mode_changed back to us; if we're
      // already on whiteboard this is a no-op.
      socket.emit('whiteboard_mode_toggle', { roomId, active: true });
      showNotif(`📐 Loaded template: ${tpl.name}`);
    } catch (err) {
      console.warn('[template] failed to apply', err);
    } finally {
      stripTemplateParam();
    }
  }, [socket, connected, roomId, templateId, whiteboardState, lastSyncTime]);

  // ── Reopen a saved session (?session=ID) — Stage 4 ──
  // Once our teacher seat is registered, fetch the saved session and re-seed
  // this room: the HTML lesson via upload_file (so it syncs to students), and
  // the whiteboard via the same add-event replay the template hydrator uses.
  // One-shot, idempotent, clears the URL param.
  useEffect(() => {
    if (!socket || !connected || !roomId || !sessionParam || !auth.enabled) return;
    if (sessionAppliedRef.current) return;
    if (!lastSyncTime) return;
    sessionAppliedRef.current = true;
    const stripParam = () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('session');
        window.history.replaceState({}, '', url.toString());
      } catch { /* tolerate non-browser env */ }
    };
    (async () => {
      try {
        const { getSession } = await import('../lib/sessions');
        const s = await getSession(sessionParam);
        if (!s) { showNotif('⚠️ Saved session not found'); stripParam(); return; }
        // Re-seed the HTML lesson as a fresh file so it renders + syncs.
        if (s.html_used) {
          const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          socket.emit('upload_file', { roomId, file: { id: fileId, name: s.topic || 'Reopened session', html: s.html_used, uploadedAt: Date.now() } });
          setSimPreviewHtml(s.html_used);
        }
        // Re-seed the whiteboard only if the room's board is currently empty
        // (same guard as the template hydrator — never pile on top).
        const wb: any = whiteboardState || {};
        const hasContent = (wb.objects?.length ?? 0) > 0 || (wb.strokes?.length ?? 0) > 0 || (wb.shapes?.length ?? 0) > 0 || (wb.texts?.length ?? 0) > 0 || (wb.instruments?.length ?? 0) > 0;
        const snap: any = s.whiteboard_snapshot || {};
        const snapHasContent = (snap.objects?.length ?? 0) > 0 || (snap.strokes?.length ?? 0) > 0 || (snap.shapes?.length ?? 0) > 0 || (snap.texts?.length ?? 0) > 0 || (snap.instruments?.length ?? 0) > 0;
        if (!hasContent && snapHasContent) {
          if (snap.gridMode) socket.emit('whiteboard_set_grid_mode', { roomId, gridMode: snap.gridMode });
          for (const shape of (snap.shapes || [])) socket.emit('whiteboard_add_shape', { roomId, shape });
          for (const text of (snap.texts || [])) socket.emit('whiteboard_add_text', { roomId, text });
          for (const inst of (snap.instruments || [])) socket.emit('whiteboard_add_instrument', { roomId, instrument: inst });
          for (const obj of (snap.objects || [])) socket.emit('whiteboard_add_image', { roomId, object: obj });
          for (const stroke of (snap.strokes || [])) socket.emit('whiteboard_draw', { roomId, stroke });
        }
        showNotif(`📂 Reopened: ${s.topic || 'saved session'}`);
      } catch {
        showNotif('⚠️ Could not reopen session');
      } finally {
        stripParam();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, connected, roomId, sessionParam, lastSyncTime, auth.enabled]);

  // ── Helper: safely post message to mirror iframe (queues if not ready) ──
  const postToMirror = useCallback((msg: any) => {
    if (mirrorReadyRef.current && mirrorIframeRef.current?.contentWindow) {
      mirrorIframeRef.current.contentWindow.postMessage(msg, '*');
    } else {
      if (pendingMirrorMessagesRef.current.length < 500) {
        pendingMirrorMessagesRef.current.push(msg);
      }
    }
  }, []);

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

  // ── Heartbeat snapshot (late-join freshness) ──
  // Re-snapshot every 2.5s so the server's liveSnapshotHtml stays close to the
  // teacher's current screen — that's what a LATE-JOINING student boots from.
  // It is no longer pushed to already-connected students (the live `live_dom`
  // body-swap mirror is retired — it destroyed sim listeners and broke
  // canvas/3D sims); connected students stay in step via interaction replay.
  // Identical-DOM change-detection above means an idle teacher costs nothing.
  useEffect(() => {
    // Skip while on the whiteboard OR showing temporary explanation content:
    // in those states iframeRef points at a DIFFERENT iframe (whiteboard has
    // none; explanation has the temp iframe), and snapshotting it would publish
    // the explainer DOM as the lesson's liveSnapshotHtml — corrupting what late
    // joiners boot from.
    if (whiteboardMode || showTempContent) return;
    const id = setInterval(() => {
      if (!iframeReadyRef.current || !previewHtmlRef.current) return;
      const requestId = `snap-hb-${Date.now()}`;
      snapshotRequestRef.current = requestId;
      postToIframe({ type: 'REQUEST_HTML', requestId });
    }, 2500);
    return () => clearInterval(id);
  }, [studentInteractionAllowed, whiteboardMode, showTempContent, postToIframe]);

  // ── Iframe onLoad: flush pending messages ──
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    // Flush any pending messages
    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    for (const msg of pending) {
      iframeRef.current?.contentWindow?.postMessage(msg, '*');
    }
    // Re-send current state. presenter/interaction follow sole-writer so a
    // teacher who handed off control reloads as a mirror, not a driver.
    const soleWriter = !controlHolderName;
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_PRESENTER_MODE', enabled: soleWriter }, '*');
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_INTERACTION_MODE', allowed: soleWriter }, '*');
    if (scrollSyncEnabled !== undefined) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled }, '*');
    }
    if (stepLockEnabled && currentStep) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_STEP', step: currentStep }, '*');
    }
    if (zoomLevel !== 1) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_ZOOM', zoom: zoomLevel }, '*');
    }
  }, [scrollSyncEnabled, stepLockEnabled, currentStep, zoomLevel, controlHolderName]);

  // ── Mirror iframe onLoad: behave like a passive student view ──
  const handleMirrorLoad = useCallback(() => {
    mirrorReadyRef.current = true;
    const pending = pendingMirrorMessagesRef.current;
    pendingMirrorMessagesRef.current = [];
    for (const msg of pending) {
      mirrorIframeRef.current?.contentWindow?.postMessage(msg, '*');
    }
    // Mirror is view-only and receives remote events only
    mirrorIframeRef.current?.contentWindow?.postMessage({ type: 'SET_PRESENTER_MODE', enabled: false }, '*');
    mirrorIframeRef.current?.contentWindow?.postMessage({ type: 'SET_INTERACTION_MODE', allowed: false }, '*');
    mirrorIframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCROLL_SYNC', enabled: true }, '*');
    if (stepLockEnabled && currentStep) {
      mirrorIframeRef.current?.contentWindow?.postMessage({ type: 'SET_STEP', step: currentStep }, '*');
    }
    if (zoomLevel !== 1) {
      mirrorIframeRef.current?.contentWindow?.postMessage({ type: 'REMOTE_ZOOM', zoom: zoomLevel }, '*');
    }
    // Catch up to teacher's current scroll position immediately
    setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'EMIT_CURRENT_SCROLL' }, '*');
    }, 250);
  }, [stepLockEnabled, currentStep, zoomLevel]);

  // ── Dual View: keep mirror aligned with teacher scroll ──
  useEffect(() => {
    if (!dualView) return;
    // Initial pulse shortly after toggle (server too, so any other students align)
    const initial = setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'EMIT_CURRENT_SCROLL' }, '*');
    }, 200);
    // Periodic convergence pulse — mirror only, no server traffic
    const interval = setInterval(() => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'EMIT_CURRENT_SCROLL', mirrorOnly: true }, '*');
    }, 1500);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [dualView]);

  // ── Relay iframe messages ──
  useEffect(() => {
    const requestSnapshot = () => {
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = setTimeout(() => {
        const requestId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        snapshotRequestRef.current = requestId;
        postToIframe({ type: 'REQUEST_HTML', requestId });
      }, 350);
    };

    const handler = (e: MessageEvent) => {
      if (!socket) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const type = e.data?.type;
      if (!type) return;

      // Internal sync events — not interactions
      if (type === 'SYNC_PROVIDE_HTML') {
        if (snapshotRequestRef.current && e.data.requestId === snapshotRequestRef.current) {
          const requestId = snapshotRequestRef.current;
          snapshotRequestRef.current = null;
          // Heartbeat snapshots only need to go out when the DOM actually
          // changed — skip identical re-sends so an idle teacher costs nothing.
          if (requestId.startsWith('snap-hb-') && e.data.html === lastSentSnapshotRef.current) {
            return;
          }
          lastSentSnapshotRef.current = e.data.html;
          console.info('[sync]', { eventType: 'snapshot_ack', roomId, requestId, role: 'teacher' });
          socket.emit("dom_snapshot", { roomId, html: e.data.html, requestId, hasCanvas: !!e.data.hasCanvas });
        } else {
          console.info('[sync]', { eventType: 'snapshot_ack_unrequested', roomId, requestId: e.data.requestId, role: 'teacher' });
          socket.emit("sync_html_update", { roomId, html: e.data.html, requestId: e.data.requestId, hasCanvas: !!e.data.hasCanvas });
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
        const mirrorOnly = !!e.data.mirrorOnly;
        if (!mirrorOnly) {
          socket.emit("interaction", {
            roomId,
            event: {
              ...e.data,
              syncEpoch: syncEpochRef.current,
              clientTs: Date.now(),
            },
          });
        }
        // Forward teacher-originated event to the student-mirror iframe so it
        // visually reflects exactly what students see in real-time.
        if (dualView && type !== 'SYNC_CURSOR') {
          const remoteEvent = { ...e.data, type: type.replace('SYNC_', 'REMOTE_') };
          postToMirror(remoteEvent);
        }
        if (!mirrorOnly && type !== 'SYNC_CURSOR' && type !== 'SYNC_SCROLL' && type !== 'SYNC_ZOOM' && type !== 'SYNC_MOUSEMOVE') {
          // SYNC_MOUSEMOVE streams during a drag; debouncing a snapshot per
          // move would storm the iframe. The trailing SYNC_MOUSEUP triggers
          // the authoritative snapshot once the gesture settles.
          requestSnapshot();
        }
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    };
  }, [socket, roomId, scrollSyncEnabled, dualView, postToMirror]);

  // SINGLE-WRITER: the teacher drives the sim by default, but when the teacher
  // hands the chalk to a student, the teacher becomes a MIRROR - its sim is
  // driven by the student's replayed events, so the teacher's local clicks
  // must be locked out (otherwise two drivers diverge). presenterMode +
  // interaction-allowed both follow "am I the sole writer right now" = no
  // student holds control.
  const teacherIsSoleWriter = !controlHolderName;
  useEffect(() => {
    postToIframe({ type: 'SET_INTERACTION_MODE', allowed: teacherIsSoleWriter });
    postToIframe({ type: 'SET_PRESENTER_MODE', enabled: teacherIsSoleWriter });
  }, [iframeUrl, teacherIsSoleWriter, postToIframe]);

  useEffect(() => {
    // syncEpoch must mirror the student-side dependency set so the two counters
    // stay in lock-step. Including teacher-only UI flags like dualView here used
    // to drift the teacher's epoch ahead of the student's, after which all
    // student interaction events were silently dropped.
    syncEpochRef.current += 1;
    iframeReadyRef.current = false;
  }, [iframeUrl, showTempContent, whiteboardMode]);


  // Mirror iframe readiness must reset when the mirror is created/destroyed
  // (dualView toggle) or when its content URL changes — but this is a local
  // ready-tracking concern, not a content-version reset.
  useEffect(() => {
    mirrorReadyRef.current = false;
    pendingMirrorMessagesRef.current = [];
  }, [iframeUrl, showTempContent, whiteboardMode, dualView]);

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
    const scripts = seededSyncScript(randomSeed) + stepLockScript;
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
    // NOT keyed on stepLockEnabled: the injected scripts are always present
    // (the lock is driven on the live iframe via SET_STEP / DISABLE_STEP_LOCK
    // postMessages in toggleStepLock). Rebuilding the blob on every toggle
    // reloaded the whole simulation — losing runtime state and broadcasting the
    // reset to students — for a routine toolbar button. Keyed on randomSeed so
    // a new lesson baseline rebuilds the sim with the matching seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewHtml, randomSeed]);

  // ── Sync code when active file changes ──
  useEffect(() => {
    if (activeFileId) {
      const file = files.find(f => f.id === activeFileId);
      if (file) { setHtmlCode(file.html); setSimPreviewHtml(file.html); }
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
    // presenterMode follows sole-writer (see the SET_INTERACTION_MODE effect):
    // a teacher who handed off control is a mirror, not the presenter.
    postToIframe({ type: 'SET_PRESENTER_MODE', enabled: teacherIsSoleWriter });
    postToIframe({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled });
  }, [scrollSyncEnabled, iframeUrl, teacherIsSoleWriter, postToIframe]);

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
  // Safety net for AI generation: if the done/error reply is lost (socket
  // reconnected mid-generation), this timer recovers the modal instead of
  // leaving it stuck on "Generating…" with both close buttons disabled.
  const aiTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
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
        setSimPreviewHtml(content);
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
        setSimPreviewHtml(content);
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

  const handleGenerateAi = () => {
    if (!socket || !aiPrompt.trim() || aiGenerating) return;
    setAiError(null);
    setAiGenerating(true);
    socket.emit("generate_lesson", { roomId, prompt: aiPrompt.trim() });
    if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
    aiTimeoutRef.current = setTimeout(() => {
      setAiGenerating(false);
      setAiError('The AI request timed out. Please try again.');
    }, 60000);
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
    setSimPreviewHtml(pasteCode);
    setShowPasteModal(false);
    setPasteCode("");
    setPasteFileName("");
    showNotif(`✅ Added: ${name}`);
  };

  // ── Save current board to this student's history (Stage 4) ──
  const saveToHistory = useCallback(async () => {
    if (!auth.enabled || !auth.user || !roomId || savingHistory) return;
    setSavingHistory(true);
    try {
      const { findClassIdByRoomCode, saveSession } = await import('../lib/sessions');
      const classId = await findClassIdByRoomCode(roomId);
      if (!classId) {
        showNotif('⚠️ Create a class for this room in your dashboard first to save history.');
        return;
      }
      const topic = files.find(f => f.id === activeFileId)?.name || (whiteboardMode ? 'Whiteboard session' : 'Session');
      await saveSession({ classId, topic, html: previewHtmlRef.current || null, whiteboard: whiteboardState });
      showNotif("💾 Saved to this student's history");
    } catch {
      showNotif('⚠️ Could not save to history');
    } finally {
      setSavingHistory(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.enabled, auth.user, roomId, savingHistory, files, activeFileId, whiteboardMode, whiteboardState]);

  const runPreview = () => {
    if (!socket || !activeFileId) return;
    // Flag to skip our own echo from the server broadcast
    skipOwnPreviewRef.current = true;
    socket.emit("run_preview", { roomId, fileId: activeFileId, html: htmlCode });
    setSimPreviewHtml(htmlCode);
    showNotif("▶ Preview updated & synced");
  };

  const switchFile = (fileId: string) => {
    if (!socket) return;
    const file = files.find(f => f.id === fileId);
    if (file) {
      setHtmlCode(file.html);
      setSimPreviewHtml(file.html);
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
    // Force Sync re-baselines the lesson from the teacher's live iframe DOM —
    // the server rewrites lastRunHtml AND the saved file.html from the snapshot.
    // During explanation or whiteboard mode, iframeRef points at the temp /
    // (no) iframe, so a force here would overwrite the real lesson source with
    // the explainer DOM, unrecoverably. Refuse and tell the teacher to return
    // to the lesson first.
    if (showTempContent || whiteboardMode) {
      showNotif('Return to the lesson before Force Sync (it would overwrite it).');
      return;
    }
    const requestId = `force-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    snapshotRequestRef.current = requestId;
    postToIframe({ type: 'REQUEST_HTML', requestId });
    setLastSyncTime(Date.now());
  };

  // ── Control handoff ──
  const grantControl = (holderName: string | null) => {
    if (!socket) return;
    socket.emit("grant_control", { roomId, holderName });
  };

  // ── Student peek ──
  const peekAtStudent = (studentId: string, studentName: string) => {
    if (!socket) return;
    setPeekStudent({ id: studentId, name: studentName });
    setPeekHtml(null);
    socket.emit("peek_student", { roomId, studentId });
  };
  const refreshPeek = () => {
    if (!socket || !peekStudentRef.current) return;
    socket.emit("peek_student", { roomId, studentId: peekStudentRef.current.id });
  };
  const resyncPeekStudent = () => {
    if (!socket || !peekStudentRef.current) return;
    socket.emit("resync_student", { roomId, studentId: peekStudentRef.current.id });
    showNotif(`⟳ Resyncing ${peekStudentRef.current.name}…`);
  };

  // ── Time Machine ──
  const createBookmark = () => {
    if (!socket) return;
    socket.emit("bookmark_create", { roomId });
    showNotif('🔖 Moment saved — you can rewind here later');
  };
  const restoreBookmark = (bookmarkId: string) => {
    if (!socket) return;
    socket.emit("bookmark_restore", { roomId, bookmarkId });
    showNotif('⏪ Rewound the class to a saved moment');
  };
  const deleteBookmark = (bookmarkId: string) => {
    if (!socket) return;
    socket.emit("bookmark_delete", { roomId, bookmarkId });
  };

  const toggleScrollSync = () => {
    if (!socket) return;
    const newEnabled = !scrollSyncEnabled;
    setScrollSyncEnabled(newEnabled);
    socket.emit("toggle_scroll_sync", { roomId, enabled: newEnabled });
    postToIframe({ type: 'SET_SCROLL_SYNC', enabled: newEnabled });
    showNotif(newEnabled ? '🔗 Scroll sync ON' : '🔓 Free scroll — everyone scrolls independently');
  };

  const toggleWhiteboardMode = () => {
    const newMode = !whiteboardMode;
    // When switching INTO whiteboard, drop any HTML-overlay tool that was
    // active (highlighter / pen / laser). Those tools belong to the
    // AnnotationLayer over the iframe; if they leak into whiteboard mode the
    // AnnotationLayer keeps capturing pointer events on top of the
    // whiteboard, and the whiteboard's own tools silently do nothing. The
    // teacher's whiteboard-side tool selection lives inside <Whiteboard/>
    // and is unaffected by this reset.
    if (newMode) {
      setDrawMode(false);
      setLaserMode(false);
    }
    setWhiteboardMode(newMode);
    if (socket) {
      socket.emit('whiteboard_mode_toggle', { roomId, active: newMode });
    }
  };

  const startWithWhiteboard = () => {
    if (!whiteboardMode) toggleWhiteboardMode();
  };

  const toggleWhiteboardSync = () => {
    if (!socket) return;
    const next = !whiteboardSyncEnabled;
    setWhiteboardSyncEnabled(next);
    socket.emit('set_whiteboard_sync', { roomId, enabled: next });
    showNotif(next ? '📖 Shared view: pan and zoom mirror both sides' : '🔓 Independent view: your canvas moves only for you');
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
    const options = quizOptions.map(o => o.trim()).filter(Boolean);
    socket.emit("send_quiz", {
      roomId,
      question: quizQuestion.trim(),
      // ≥2 choices → multiple-choice on student screens; else free-text.
      ...(options.length >= 2 ? { options } : {}),
    });
    setQuizAnswers([]);
    setShowQuizModal(false);
    setQuizOptions(["", "", "", ""]);
    showNotif("🎯 Quiz sent!");
  };

  // ── Temporary Explanation Content ──
  // AUTONOMOUS: Single commit path for both file-uploaded and pasted
  // explanation content. Used by handleUploadExplanation (file) and the
  // Explain modal's "Show" button (paste). Keeps behaviour identical
  // between the two paths and ensures any future change (eg
  // additional payload fields, validation) only needs one update.
  const submitExplanation = (html: string, name: string) => {
    if (!socket) return;
    const trimmed = html.trim();
    if (!trimmed) return;
    const safeName = name.trim() || `Explanation-${new Date().toLocaleTimeString()}`;
    setTempContent({ html: trimmed, name: safeName });
    socket.emit('show_temp_content', { roomId, html: trimmed, name: safeName });
    setShowTempContent(true);
    showNotif(`📚 Showing explanation: ${safeName}`);
  };

  const handleUploadExplanation = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { showNotif(`⚠️ File too large (max 2MB)`); return; }
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = String(event.target?.result || '');
      const name = file.name.replace(/\.html?$/i, '');
      submitExplanation(content, name);
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
      // Tell the SERVER too — room.currentStep is canonical (late joiners and
      // reconnects hydrate from it). Without this emit, toggling the lock was
      // local-only and a reconnect snapped everyone back to the stale step.
      // 999 is the established "no lock / show all" sentinel (stepLockScript
      // defaults to it; students broadcast it on step_changed).
      if (socket) socket.emit('set_step', { roomId, step: 999 });
    }
    if (newEnabled) {
      setCurrentStep(1);
      postToIframe({ type: 'GET_MAX_STEP' });
      postToIframe({ type: 'SET_STEP', step: 1 });
      if (socket) socket.emit('set_step', { roomId, step: 1 });
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
    setSimPreviewHtml(html);
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
  // The left panel is the HTML code-editor pane. It's only useful when the
  // teacher is actually working with HTML files — not on a blank empty room
  // (the upload buttons live in the right-hand mode picker now), and not in
  // whiteboard mode (the whiteboard is canvas-only, no files to edit).
  // Suppressing it in those two cases lets the right side fill the full width.
  const hasFilesOrIframe = files.length > 0 || !!iframeUrl;
  const leftPanelUseful = hasFilesOrIframe && !whiteboardMode;
  const showLeftPanel = (viewMode === 'split' || viewMode === 'code') && leftPanelUseful;
  const showPreview = (viewMode === 'split' || viewMode === 'preview') || !leftPanelUseful;
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
      <header className="app-header">
        <div className="header-section">
          <button onClick={() => navigate('/')} className="flex items-center hover:opacity-80 transition-opacity"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            <span className="font-display font-extrabold text-[15px]" style={{ color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
              Maths<span style={{ color: 'var(--accent-indigo)' }}>Live</span>
            </span>
          </button>

          <div className="header-divider hidden sm:block" />

          <span className="hidden sm:inline text-[12px] font-mono font-semibold" style={{ color: 'var(--text-muted)' }}>{roomId}</span>

          <div className="header-divider hidden sm:block" />

          {/* View Mode Toggles */}
          <div style={{ display: 'flex', gap: '2px' }}>
            {(['code', 'split', 'preview'] as ViewMode[]).map(mode => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={`tb-btn ${viewMode === mode ? 'active' : ''}`}
                data-tip={mode.charAt(0).toUpperCase() + mode.slice(1)}>
                {mode === 'code' && (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                  </svg>
                )}
                {mode === 'split' && (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
                  </svg>
                )}
                {mode === 'preview' && (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="header-section">
          <ConnectionStatus socket={socket} connected={connected} />

          <span className="text-[12px] font-mono hidden sm:block" style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {formatTime(sessionTimer)}
          </span>

          <div className="header-divider hidden sm:block" />

          {/* Students pill */}
          <div className="relative">
            <button onClick={() => setShowUserPanel(!showUserPanel)} className="status-pill" style={{ cursor: 'pointer', border: 'none' }}>
              <div className={`connection-dot ${studentCount > 0 ? 'online' : 'offline'}`} />
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{studentCount}</span>
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
                    <UserList users={users} attention={attention} isTeacher={true} socket={socket} roomId={roomId!}
                      controlHolderName={controlHolderName}
                      onGrantControl={grantControl}
                      onPeek={peekAtStudent} />
                  )}
                </div>
              </>
            )}
          </div>

          {/* Control banner — who's driving right now */}
          {controlHolderName && (
            <button onClick={() => grantControl(null)}
              className="ml-btn ml-btn-sm"
              title="Take back control"
              style={{ background: 'rgba(244,63,94,0.12)', color: '#E11D48', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              ✋ {controlHolderName} driving · take back
            </button>
          )}

          {/* Time Machine — bookmark + rewind the whole class */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowTimeMachine(v => !v)}
              className={`tb-btn ${showTimeMachine ? 'active' : ''}`}
              data-tip="Time Machine — save & rewind moments"
              aria-haspopup="menu" aria-expanded={showTimeMachine}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>
              </svg>
            </button>
            {showTimeMachine && (
              <>
                <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setShowTimeMachine(false)} />
                <div className="ml-surface-elevated" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, width: 260, zIndex: 50, borderRadius: 12, padding: 8, boxShadow: 'var(--shadow-xl)' }}>
                  <button onClick={() => { createBookmark(); }}
                    className="ml-btn ml-btn-sm ml-btn-primary ml-btn-block" style={{ marginBottom: 6 }}>
                    🔖 Save this moment
                  </button>
                  {bookmarks.length === 0 ? (
                    <div className="ml-caption" style={{ padding: '8px 6px', color: 'var(--text-muted)', textAlign: 'center' }}>
                      No saved moments yet. Save one, then jump back to it anytime.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 240, overflowY: 'auto' }}>
                      {[...bookmarks].reverse().map(bm => (
                        <div key={bm.id} className="flex items-center gap-1 group" style={{ borderRadius: 8, padding: '2px 4px' }}>
                          <button onClick={() => { restoreBookmark(bm.id); setShowTimeMachine(false); }}
                            className="flex-1 text-left" title="Rewind the class to here"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', borderRadius: 6 }}>
                            <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>⏪ {bm.name}</div>
                            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{new Date(bm.ts).toLocaleTimeString()}</div>
                          </button>
                          <button onClick={() => deleteBookmark(bm.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px]"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                            title="Delete moment">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Invite */}
          <button
            ref={inviteButtonRef}
            onClick={toggleShareMenu}
            className={`ml-btn ml-btn-sm ${linkCopied ? 'ml-btn-success' : 'ml-btn-secondary'}`}
            aria-haspopup="dialog"
            aria-expanded={showShareMenu}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
            </svg>
            {linkCopied ? 'Copied' : 'Invite'}
          </button>
          {showShareMenu && createPortal(
            <div className="ml-share-overlay" role="presentation">
              <div className="ml-share-backdrop" onClick={() => setShowShareMenu(false)} />
              <div
                role="dialog"
                aria-label="Invite students"
                className="ml-share-popover ml-surface-elevated animate-slide-down"
                style={{ top: shareMenuPos.top, right: shareMenuPos.right, width: shareMenuPos.width }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="ml-eyebrow">Invite</div>
                    <div className="ml-headline mt-1" style={{ fontSize: 18 }}>Share this room</div>
                    <p className="ml-caption mt-1">Copy the student link, or share the room code.</p>
                  </div>
                  <button
                    onClick={() => setShowShareMenu(false)}
                    aria-label="Close invite dialog"
                    className="ml-icon-btn ml-icon-btn-sm"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                  </button>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-[1.35fr_0.8fr]">
                  <div>
                    <label className="ml-field-label" htmlFor="invite-link">Student link</label>
                    <input
                      id="invite-link"
                      readOnly
                      value={`${window.location.origin}/live/${roomId}`}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.currentTarget.select()}
                      className="ml-input"
                      style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}
                    />
                  </div>
                  <div>
                    <label className="ml-field-label" htmlFor="invite-code">Room code</label>
                    <input
                      id="invite-code"
                      readOnly
                      value={roomId || ''}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.currentTarget.select()}
                      className="ml-input ml-input-mono"
                      style={{ letterSpacing: '0.12em' }}
                    />
                  </div>
                </div>

                <div className="mt-3">
                  <label className="ml-field-label" htmlFor="invite-pass">
                    Passcode <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>(optional)</span>
                  </label>
                  <input
                    id="invite-pass"
                    type="text"
                    placeholder="e.g. math123"
                    value={roomPassword}
                    onChange={(e) => saveRoomPassword(e.target.value)}
                    className="ml-input"
                  />
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button onClick={copyStudentLink} className="ml-btn ml-btn-primary ml-btn-block sm:flex-1">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                    {roomPassword ? 'Copy link + passcode' : 'Copy link'}
                  </button>
                  <a
                    href={`${window.location.origin}/live/${roomId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-btn ml-btn-secondary ml-btn-block sm:flex-1"
                    style={{ textDecoration: 'none' }}
                  >
                    Open student view
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M7 17L17 7M9 7h8v8"/>
                    </svg>
                  </a>
                </div>
              </div>
            </div>,
            document.body
          )}

          <div className="header-divider hidden sm:block" />

          {/* Icon buttons: Library, Record, Fullscreen, Sound */}
          <button onClick={() => setShowLibrary(true)} className="btn-icon hidden sm:inline-flex" data-tip="Library">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
            </svg>
          </button>

          <button onClick={toggleRecording}
            className={`btn-icon hidden sm:inline-flex ${isRecording ? 'active-rose' : ''}`}
            data-tip={isRecording ? 'Stop Recording' : 'Record'}>
            {isRecording ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="6"/></svg>
            )}
          </button>

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
        </div>
      </header>

      {/* AUTONOMOUS: Teacher-replaced banner. Shown when another tab of
          the same teacher took over the room. The banner is non-dismissible
          (a hard reload fixes it; the user shouldn't keep editing on a
          dead-write tab). */}
      {joinErrorMsg && (
        <div className="animate-slide-down px-4 py-2.5 flex items-center justify-center gap-3 text-sm font-semibold"
          style={{ background: '#FEF2F2', color: '#991B1B', borderBottom: '1px solid #FCA5A5' }}>
          <span>⚠️ {joinErrorMsg}</span>
          <button
            onClick={() => navigate('/')}
            style={{ padding: '4px 12px', borderRadius: 8, border: '1px solid #DC2626', background: '#fff', color: '#991B1B', fontWeight: 600, cursor: 'pointer' }}
          >
            Back to home
          </button>
        </div>
      )}
      {teacherReplaced && (
        <div className="animate-slide-down px-4 py-2.5 flex items-center justify-center gap-3 text-sm font-semibold"
          style={{ background: '#FEF2F2', color: '#991B1B', borderBottom: '1px solid #FCA5A5' }}>
          <span>⚠️ Another tab of yours took over the teacher seat — your changes here are no longer syncing.</span>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '4px 12px',
              borderRadius: 8,
              border: '1px solid #DC2626',
              background: '#fff',
              color: '#991B1B',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      )}

      {/* AUTONOMOUS: Miro-style "Save to my boards" banner.
          Shown when the room is anonymous (claimed=false) — counts down
          to expiry and offers a single-click save. Once saved (claimed)
          the banner hides for everyone. */}
      {!claimed && expiresAt && (
        <SaveBoardBanner
          expiresAt={expiresAt}
          saving={savingBoard}
          onSave={() => {
            if (!socket) return;
            setSavingBoard(true);
            socket.emit('claim_room', { roomId, name: teacherName });
            // Persist locally so Home's "My boards" can list it.
            try {
              savedBoards.add({
                roomId: roomId!,
                name: teacherName,
                claimedAt: Date.now(),
                label: activeFile?.name || (whiteboardMode ? 'Whiteboard board' : 'Untitled board'),
              });
            } catch { /* localStorage failure is non-fatal */ }
          }}
        />
      )}
      {auth.enabled && auth.user && (
        <div className="px-4 py-1.5 flex items-center justify-center gap-2 text-xs font-semibold"
          style={{ background: '#EEF2FF', color: '#3730A3', borderBottom: '1px solid rgba(99,102,241,0.18)' }}>
          <span>Keep a record of this lesson for the student</span>
          <button
            onClick={saveToHistory}
            disabled={savingHistory}
            style={{ padding: '3px 12px', borderRadius: 8, border: '1px solid #6366F1', background: '#fff', color: '#3730A3', fontWeight: 700, cursor: savingHistory ? 'default' : 'pointer' }}
          >
            {savingHistory ? 'Saving…' : '💾 Save to history'}
          </button>
        </div>
      )}
      {claimed && claimedBy && (
        <div className="px-4 py-1.5 flex items-center justify-center gap-2 text-xs font-semibold"
          style={{ background: '#ECFDF5', color: '#065F46', borderBottom: '1px solid rgba(16,185,129,0.18)' }}>
          <span>✓ Saved by {claimedBy}</span>
          <span style={{ opacity: 0.7 }}>· This board will keep working for the next 30 days</span>
        </div>
      )}

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
              <button onClick={() => fileInputRef.current?.click()} className="btn-accent text-[12px]">
                📤 Upload HTML
              </button>
              <button onClick={() => setShowPasteModal(true)} className="btn text-[12px]">
                📋 Paste Code
              </button>
              <button onClick={() => { setAiError(null); setShowAiModal(true); }} className="btn-accent text-[12px]" title="Describe a concept; AI builds an interactive lesson">
                ✨ AI Lesson
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
                /* Empty left panel — the right-hand mode picker is now the
                   single source of upload actions (Choose file + Paste
                   snippet, both rendered inside the "Start with HTML" card).
                   We deliberately render nothing here so the user has one
                   clear path instead of two duplicate empty states. */
                null
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
              onToggleWhiteboard={toggleWhiteboardMode}
              followStudentClicks={followStudentClicks}
              onToggleFollowStudentClicks={() => setFollowStudentClicks(v => !v)}
              whiteboardMode={whiteboardMode}
              explanationActive={showTempContent && !!tempContent}
              explanationName={tempContent?.name ?? null}
              onUploadExplanation={() => setShowExplainModal(true)}
              onExitExplanation={clearTempContent}
              eraserMode={eraserMode}
              onSetEraserMode={setEraserMode}
              shapeTool={shapeTool}
              onSetShapeTool={setShapeTool}
            />

            {/* Hidden file input for explanation upload — triggered by the
                Explanation pill in TeacherControls (next to Whiteboard). */}
            <input
              ref={tempFileInputRef}
              type="file"
              accept=".html,.htm"
              onChange={handleUploadExplanation}
              className="hidden"
            />

            {/* Hidden HTML upload input — must live outside the left panel so
                the mode picker's "Browse files" button still works when the
                room is empty (the left panel is suppressed in that state). */}
            <input
              type="file"
              accept=".html,.htm"
              ref={fileInputRef}
              onChange={uploadFileFromInput}
              className="hidden"
              multiple
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

            {/* Iframe or Whiteboard */}
            <div className="flex-1 relative overflow-hidden m-3 rounded-xl preview-frame">
              {/* AUTONOMOUS: Quick-access cluster on the HTML view.
                  The Whiteboard + Explanation buttons live in the teacher
                  toolbar too, but the toolbar is horizontally scrollable
                  and on smaller screens these critical actions get pushed
                  off-screen. Surfacing them here as floating pills makes
                  them discoverable: while explaining HTML the teacher can
                  one-click drop into the whiteboard for a quick math step,
                  or layer another HTML explanation on top of an example,
                  without hunting through the toolbar.
                  Hidden when the surface is already whiteboard or temp
                  content — those modes have their own affordances. */}
              {iframeUrl && !showTempContent && !whiteboardMode && (
                <div className="absolute top-2 left-2 z-20 flex items-center gap-2">
                  <button
                    onClick={toggleWhiteboardMode}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md flex items-center gap-1.5"
                    style={{
                      background: 'rgba(255,255,255,0.95)',
                      color: '#4F46E5',
                      border: '1px solid rgba(79,70,229,0.25)',
                    }}
                    title="Open the shared whiteboard temporarily — your HTML is paused but kept loaded"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="13" rx="1.6" />
                      <path d="M8 21l4-4 4 4" />
                      <path d="M7 12l3-3 3 2 4-4" />
                    </svg>
                    Whiteboard
                  </button>
                  <button
                    onClick={() => setShowExplainModal(true)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md flex items-center gap-1.5"
                    style={{
                      background: 'rgba(255,255,255,0.95)',
                      color: '#B45309',
                      border: '1px solid rgba(245,158,11,0.30)',
                    }}
                    title="Upload an HTML explainer or paste HTML code to overlay on top of the current example"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4z" />
                      <path d="M20 4h-6a3 3 0 00-3 3v13a2 2 0 012-2h7z" />
                    </svg>
                    Explain over this
                  </button>
                </div>
              )}

              {/* AUTONOMOUS: When showing temp explanation content,
                  surface a quick "Back to main" button and a "Whiteboard"
                  shortcut. Without these, the teacher had to scroll the
                  toolbar to find the Exit / Whiteboard pills. */}
              {showTempContent && tempContent && !whiteboardMode && (
                <div className="absolute top-2 left-2 z-20 flex items-center gap-2">
                  <button
                    onClick={clearTempContent}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md flex items-center gap-1.5"
                    style={{
                      background: '#0F172A',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.12)',
                    }}
                    title={`Showing: ${tempContent.name} — click to return to the main HTML`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
                    </svg>
                    Back to main
                  </button>
                  <button
                    onClick={toggleWhiteboardMode}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md flex items-center gap-1.5"
                    style={{
                      background: 'rgba(255,255,255,0.95)',
                      color: '#4F46E5',
                      border: '1px solid rgba(79,70,229,0.25)',
                    }}
                    title="Open the shared whiteboard"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="13" rx="1.6" />
                      <path d="M8 21l4-4 4 4" />
                      <path d="M7 12l3-3 3 2 4-4" />
                    </svg>
                    Whiteboard
                  </button>
                </div>
              )}

              {/* AUTONOMOUS: When the whiteboard is open, surface a quick
                  "Back to HTML" pill (top-left) so the teacher can return
                  to the simulation without scrolling the toolbar. Only
                  shows if there's an HTML to return to. */}
              {whiteboardMode && iframeUrl && (
                <button
                  onClick={toggleWhiteboardMode}
                  className="absolute top-2 left-2 z-30 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md flex items-center gap-1.5"
                  style={{
                    background: '#0F172A',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                  title="Return to the HTML simulation — your whiteboard work is saved"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
                  </svg>
                  Back to HTML
                </button>
              )}

              {/* Dual View toggle — appears once content is loaded */}
              {iframeUrl && !showTempContent && !whiteboardMode && (
                <button
                  onClick={() => setDualView(v => !v)}
                  className="absolute top-2 right-2 z-20 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-md"
                  style={{
                    background: dualView ? '#10B981' : 'rgba(255,255,255,0.95)',
                    color: dualView ? '#fff' : '#111827',
                    border: '1px solid rgba(0,0,0,0.08)',
                  }}
                  title="Show a live mirror of what students see"
                >
                  {dualView ? '✕ Exit Dual View' : '👥 Dual View'}
                </button>
              )}
              {/* AUTONOMOUS: [ORDER-1 CRITICAL] - <Whiteboard> is mounted
                  ONCE and stays mounted for the entire room session, even
                  when the teacher toggles to HTML mode. Visibility is
                  controlled via the `isActive` prop — the component returns
                  null internally when isActive is false, so it disappears
                  visually, but its useState (objects, strokes, shapes,
                  texts, view, gridMode, instruments, undo stack) is
                  preserved by React across the null render.
                  Before this fix, mounting was inside a conditional ternary
                  — toggling HTML mode UNMOUNTED the Whiteboard and dropped
                  every local state value. On remount the component
                  rehydrated from `whiteboardState`, which was the snapshot
                  captured at session-join (long stale). Result: every
                  stroke/shape/text drawn during the lesson vanished the
                  moment the teacher peeked at HTML and came back.
                  Server-side persistence (5-min snapshot, 48h cap) was
                  always working — this was purely a client-side state
                  loss. */}
              <Whiteboard
                ref={whiteboardRef}
                socket={socket}
                roomId={roomId!}
                isTeacher={true}
                interactive={true}
                zoomLevel={zoomLevel}
                scrollX={whiteboardScrollX}
                scrollY={whiteboardScrollY}
                isActive={whiteboardMode && !showTempContent}
                initialState={whiteboardState}
                whiteboardSyncEnabled={whiteboardSyncEnabled}
              />
              {/* Whiteboard mutual-sync toggle (the "shared book" switch).
                  Only renders when the whiteboard is the visible surface. */}
              {whiteboardMode && !showTempContent && (
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    zIndex: 30,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 6,
                  }}
                >
                  <button
                    onClick={toggleWhiteboardSync}
                    title={whiteboardSyncEnabled ? 'Pan/zoom mirrors both sides — click to go independent' : 'Independent view — click to share again'}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 12px',
                      borderRadius: 10,
                      background: whiteboardSyncEnabled ? 'rgba(37,99,235,0.95)' : 'rgba(255,255,255,0.95)',
                      color: whiteboardSyncEnabled ? '#fff' : '#0F172A',
                      boxShadow: '0 6px 18px rgba(15,23,42,0.18), 0 0 0 1px rgba(15,23,42,0.08)',
                      fontSize: 12.5, fontWeight: 600,
                      border: 'none', cursor: 'pointer',
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {whiteboardSyncEnabled ? (
                        <><path d="M2 7h11l-3-3" /><path d="M22 17H11l3 3" /></>
                      ) : (
                        <><circle cx="12" cy="12" r="9" /><path d="M5 5l14 14" /></>
                      )}
                    </svg>
                    {whiteboardSyncEnabled ? 'Shared view' : 'Independent view'}
                  </button>
                  {whiteboardSyncEnabled && !peerSyncEnabled && (
                    <div style={{
                      background: 'rgba(245, 158, 11, 0.95)',
                      color: '#fff',
                      padding: '4px 10px',
                      borderRadius: 8,
                      fontSize: 11,
                      fontWeight: 600,
                      boxShadow: '0 4px 12px rgba(15,23,42,0.18)',
                    }}>
                      Student is on independent view
                    </div>
                  )}
                </div>
              )}

              {showTempContent && tempContent && tempContentUrl ? (
                // Temporary explanation content overlay — uses same ref so scroll sync works
                <iframe
                  ref={iframeRef}
                  src={tempContentUrl}
                  className="w-full h-full border-none"
                  style={{ background: '#ffffff' }}
                  onLoad={handleIframeLoad}
                  sandbox={LESSON_IFRAME_SANDBOX}
                  allow={LESSON_IFRAME_ALLOW}
                  allowFullScreen
                />
              ) : whiteboardMode ? (
                /* Whiteboard is rendered above (always mounted). When
                   active, this branch is empty so we don't double-up. */
                null
              ) : iframeUrl ? (
                <div className="w-full h-full flex">
                  <div className={dualView ? "relative flex-1 border-r border-gray-300" : "relative w-full h-full"}>
                    {dualView && (
                      <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded text-xs font-semibold"
                        style={{ background: 'rgba(59,130,246,0.9)', color: '#fff' }}>
                        Teacher View
                      </div>
                    )}
                    <iframe ref={iframeRef} src={iframeUrl} className="w-full h-full border-none"
                      style={{ background: '#ffffff' }}
                      onLoad={handleIframeLoad}
                      sandbox={LESSON_IFRAME_SANDBOX}
                      allow={LESSON_IFRAME_ALLOW}
                      allowFullScreen />
                  </div>
                  {dualView && (
                    <div className="relative flex-1">
                      <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded text-xs font-semibold"
                        style={{ background: 'rgba(16,185,129,0.9)', color: '#fff' }}>
                        Student Mirror (live)
                      </div>
                      <iframe ref={mirrorIframeRef} src={iframeUrl} className="w-full h-full border-none"
                        style={{ background: '#ffffff' }}
                        onLoad={handleMirrorLoad}
                        sandbox={LESSON_IFRAME_SANDBOX}
                        allow={LESSON_IFRAME_ALLOW}
                        allowFullScreen />
                      {/* Block all pointer interactions inside the mirror so it stays passive */}
                      <div className="absolute inset-0" style={{ pointerEvents: 'auto', cursor: 'not-allowed' }} />
                    </div>
                  )}
                </div>
              ) : (
                /* Empty room — let the teacher pick a starting surface.
                   Whiteboard for a blank shared canvas; HTML to upload an
                   interactive simulation. The teacher can switch any time
                   from the toolbar pills (Whiteboard / Explanation). */
                <div className="ml-mode-picker-wrap">
                  <div className="ml-mode-picker">
                    <span className="ml-eyebrow" style={{ color: 'var(--accent-indigo)', marginBottom: 6 }}>Pick a starting surface</span>
                    <h2 className="ml-mode-picker-title">How are you teaching today?</h2>
                    <p className="ml-mode-picker-sub">You can switch between Whiteboard and HTML any time from the toolbar.</p>

                    <div className="ml-mode-picker-cards">
                      <button onClick={startWithWhiteboard} className="ml-mode-card ml-mode-card-indigo">
                        <span className="ml-mode-card-icon" aria-hidden="true">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="18" height="13" rx="1.6" />
                            <path d="M8 21l4-4 4 4" />
                            <path d="M7 12l3-3 3 2 4-4" />
                          </svg>
                        </span>
                        <span className="ml-mode-card-title">Start with Whiteboard</span>
                        <span className="ml-mode-card-body">A blank shared canvas. Pen, shapes, images, mutual sync — everything you'd expect.</span>
                        <span className="ml-mode-card-cta">
                          Open whiteboard
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M5 12h14M13 6l6 6-6 6" />
                          </svg>
                        </span>
                      </button>

                      <div className="ml-mode-card ml-mode-card-amber ml-mode-card-static">
                        <span className="ml-mode-card-icon" aria-hidden="true">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="9" y1="13" x2="15" y2="13"/>
                            <line x1="9" y1="17" x2="13" y2="17"/>
                          </svg>
                        </span>
                        <span className="ml-mode-card-title">Start with HTML</span>
                        <span className="ml-mode-card-body">Upload an interactive HTML simulation, quiz, or worksheet. Pan/zoom mirrors both ways.</span>
                        <div className="ml-mode-card-actions">
                          <button onClick={() => fileInputRef.current?.click()} className="ml-mode-card-action ml-mode-card-action-primary">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                            Browse files
                          </button>
                          <button onClick={() => setShowPasteModal(true)} className="ml-mode-card-action ml-mode-card-action-ghost">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="2" width="6" height="4" rx="1" />
                              <path d="M9 4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
                            </svg>
                            Paste snippet
                          </button>
                          <button
                            onClick={() => {
                              if (!socket) return;
                              const file: FileEntry = {
                                id: `demo-${Date.now()}`,
                                name: DEMO_LESSON_NAME,
                                html: DEMO_LESSON_HTML,
                                uploadedAt: Date.now(),
                              };
                              socket.emit("upload_file", { roomId, file });
                              showNotif('▶ Demo lesson loaded — try Step Lock, pings and control handoff');
                            }}
                            className="ml-mode-card-action ml-mode-card-action-ghost"
                            title="No file handy? Load the built-in Equivalent Fractions Lab"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polygon points="6 3 20 12 6 21 6 3" />
                            </svg>
                            Try the demo lesson
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* No "Tip" hint any more — both upload paths now live
                        directly under the Start with HTML card above. */}
                  </div>
                </div>
              )}

              {/* Drawing/Annotation Layer
                  Only meaningful when there's an HTML iframe (or temp
                  explanation content) underneath to annotate. In whiteboard
                  mode the Whiteboard owns its own pen/highlighter tools, and
                  rendering AnnotationLayer here would put an invisible event
                  trap over the whiteboard whenever drawMode/laserMode were
                  left active from an earlier HTML session. */}
              {!whiteboardMode && (iframeUrl || (showTempContent && !!tempContent)) && (
                <AnnotationLayer
                  socket={socket} roomId={roomId!}
                  drawMode={drawMode} laserMode={laserMode}
                  penType={penType} penColor={penColor} penWidth={penWidth}
                  iframeRef={iframeRef} interactive={true}
                  eraserMode={eraserMode}
                  // AUTONOMOUS: eraser floor bumped from 18 to 32. Combined
                  // with the 24px hit-radius minimum and drag interpolation
                  // in AnnotationLayer, the eraser now reliably catches a
                  // stroke under your cursor every time. Default felt too
                  // tight before — users reported "sometimes works,
                  // sometimes not."
                  eraserWidth={Math.max(penWidth * 4, 32)}
                  shapeTool={shapeTool}
                  initialAnnotations={annotations}
                />
              )}

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

      {/* ═══ AI LESSON MODAL ═══ */}
      {showAiModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-2xl animate-bounce-in"
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="flex items-center justify-between p-5 pb-0">
              <h3 className="font-display text-lg font-bold">✨ Generate a lesson with AI</h3>
              <button onClick={() => { if (!aiGenerating) { setShowAiModal(false); setAiPrompt(''); setAiError(null); } }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
            </div>
            <div className="p-5 space-y-4">
              <textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="e.g. Teach long division of 391 by 17, step by step, with a button to reveal each step"
                disabled={aiGenerating}
                className="input-field text-sm"
                style={{ minHeight: '120px', resize: 'vertical', lineHeight: '1.6' }} />
              {aiError && <p style={{ color: '#DC2626', fontSize: 13 }}>{aiError}</p>}
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                A self-contained interactive widget is generated and loaded into the room for everyone. Takes a few seconds.
              </p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => { if (!aiGenerating) { setShowAiModal(false); setAiPrompt(''); setAiError(null); } }}
                  className="btn-secondary" disabled={aiGenerating}>Cancel</button>
                <button onClick={handleGenerateAi} disabled={!aiPrompt.trim() || aiGenerating}
                  className="btn-primary disabled:opacity-40">
                  {aiGenerating ? 'Generating…' : 'Generate & Run ▶'}
                </button>
              </div>
            </div>
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

      {/* AUTONOMOUS: EXPLAIN OVER THIS modal — file OR paste path.
          Previously the Explain button jumped straight to the OS file
          picker; the user reported they wanted to paste HTML code
          directly too. This modal offers both: a primary textarea for
          paste, with a secondary "Choose a file" button. The two paths
          flow through the same submitExplanation() helper so behaviour
          is identical from there on. Name input is optional — falls
          back to a timestamp label. */}
      {showExplainModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}>
          <div className="w-full max-w-2xl animate-bounce-in"
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="flex items-center justify-between p-5 pb-0">
              <h3 className="font-display text-lg font-bold">📚 Explain Over This</h3>
              <button
                onClick={() => { setShowExplainModal(false); setExplainHtml(''); setExplainName(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}
              >✕</button>
            </div>
            <div className="p-5 space-y-4">
              <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
                Layer an HTML explainer on top of the current example. Paste the code below, or pick a file.
              </p>
              <input
                value={explainName}
                onChange={(e) => setExplainName(e.target.value)}
                placeholder="Title (optional, e.g. Step-by-step quadratic)"
                className="input-field text-sm"
              />
              <textarea
                value={explainHtml}
                onChange={(e) => setExplainHtml(e.target.value)}
                placeholder="Paste your HTML code here..."
                className="input-field code-editor"
                style={{ minHeight: '250px', resize: 'vertical', lineHeight: '1.6', background: 'var(--bg-code)', color: '#D4D4D8' }}
              />
              <div className="flex gap-3 justify-end items-center">
                <button
                  onClick={() => {
                    // "Or choose a file" — trigger the existing file
                    // input. The picker's onChange handler routes to
                    // submitExplanation just like the textarea path.
                    setShowExplainModal(false);
                    setExplainHtml('');
                    setExplainName('');
                    tempFileInputRef.current?.click();
                  }}
                  className="btn-secondary"
                  title="Pick an .html file from your computer instead"
                >
                  Or choose a file…
                </button>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => { setShowExplainModal(false); setExplainHtml(''); setExplainName(''); }}
                  className="btn-secondary"
                >Cancel</button>
                <button
                  onClick={() => {
                    submitExplanation(explainHtml, explainName);
                    setShowExplainModal(false);
                    setExplainHtml('');
                    setExplainName('');
                  }}
                  disabled={!explainHtml.trim()}
                  className="btn-primary disabled:opacity-40"
                >
                  Show explainer ▶
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
                className="input-field mb-3" style={{ minHeight: '90px', resize: 'vertical' }} />
              <div className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                CHOICES (OPTIONAL — FILL 2+ FOR MULTIPLE CHOICE, LEAVE BLANK FOR FREE TEXT)
              </div>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {quizOptions.map((opt, i) => (
                  <input key={i} value={opt}
                    onChange={(e) => setQuizOptions(prev => prev.map((o, j) => j === i ? e.target.value : o))}
                    placeholder={`${String.fromCharCode(65 + i)})`}
                    className="input-field" style={{ height: 36, fontSize: 13 }} />
                ))}
              </div>
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

      {/* ═══ LEADERBOARD ═══ */}
      <Leaderboard
        entries={leaderboard}
        open={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
      />

      {peekStudent && (
        <StudentScreenPanel
          studentName={peekStudent.name}
          html={peekHtml}
          updatedAt={peekUpdatedAt}
          hasControl={controlHolderName === peekStudent.name}
          onClose={() => { setPeekStudent(null); setPeekHtml(null); }}
          onRefresh={refreshPeek}
          onResync={resyncPeekStudent}
          onToggleControl={() => grantControl(controlHolderName === peekStudent.name ? null : peekStudent.name)}
        />
      )}

    </div>
  );
}
