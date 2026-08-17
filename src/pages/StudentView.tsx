import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { seededSyncScript } from "../lib/syncScript";
import { mirrorScriptFor, stripLessonScripts } from "../lib/mirrorScript";
import { cleanDisplayName } from "../lib/displayName";
import { stepLockScript } from "../lib/stepLockScript";
import { setupAttentionDetection } from "../lib/attentionDetector";
import { localTimezone } from "../lib/tz";
import { socketAuth, isPasscodeError } from "../lib/passcode";
import { ScreenPeer, screenShareSupported } from "../lib/screenShare";
import ScreenSharePrompt from "../components/ScreenSharePrompt";
import TeacherScreenView from "../components/TeacherScreenView";
import { sounds } from "../lib/sounds";
import { LESSON_IFRAME_SANDBOX, LESSON_IFRAME_ALLOW } from "../lib/iframeAttrs";

// ── Components ──
import ChatPanel from "../components/ChatPanel";
import VideoCall from "../components/VideoCall";
import VideoOverlay from "../components/VideoOverlay";
import { Narrator, narrationSupported, getNarrationChoice, setNarrationChoice } from "../lib/narration";
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

// ── LIVE MIRROR ("impossible to desync") ──
// When on (the default), a student's lesson iframe is a script-STRIPPED shell
// that renders a live mirror of the teacher's REAL DOM (+ canvas). It never runs
// the lesson's own JS, so it literally cannot be on a different screen than the
// teacher — the class of "student stuck on the map / wrong quiz question" bugs
// becomes structurally impossible. A driving student's input is forwarded to the
// teacher's authoritative lesson and the resulting DOM streams back.
// Escape hatch: localStorage.mathslive_sync === 'replay' falls back to the
// classic input-replay engine (no redeploy needed) if a specific lesson ever
// misbehaves under mirroring.
const MIRROR_MODE = (() => {
  try { return localStorage.getItem('mathslive_sync') !== 'replay'; } catch { return true; }
})();

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
  // blob: URL of the lesson document handed to the iframe (see the build effect
  // below for why this is a blob URL and not srcdoc). Truthy = a lesson to show.
  const [lessonUrl, setLessonUrl] = useState("");
  // The URL the iframe is currently showing, so the build effect can revoke the
  // one it REPLACES rather than the one it just created.
  const lessonUrlRef = useRef<string | null>(null);
  // Has the teacher's screen actually been painted into the shell yet?
  // A follower shell has the lesson's own scripts stripped, so a lesson that
  // builds its page in JS shows NOTHING until the first mirrored frame lands.
  // Blank white with no explanation is indistinguishable from "broken" — which
  // is exactly how it was reported from an iPad.
  const [mirrorPainted, setMirrorPainted] = useState(false);
  // "You tapped, but it's locked" — shown when a view-only student tries to
  // touch the lesson, with a button that actually asks the teacher.
  const [lockedNudge, setLockedNudge] = useState(false);
  const [askedAt, setAskedAt] = useState(0);
  // The teacher has asked the room to capture speech as text. This student is
  // ASKED before their microphone is ever used, and can stop at any time.
  const [narrationOn, setNarrationOn] = useState(false);
  const narratorRef = useRef<Narrator | null>(null);
  const narrationStartRef = useRef(0);
  // A room the teacher has not opened yet is the NORMAL state for a student
  // who clicks their link a few minutes early. Kept apart from joinError so it
  // renders as "waiting", and so the retry loop knows it is worth retrying.
  const [waitingForRoom, setWaitingForRoom] = useState(false);
  const [joinAttempts, setJoinAttempts] = useState(0);
  const socketRef = useRef<typeof socket>(null);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  /** Open the microphone and relay lines. Only ever called after a yes. */
  const beginNarrating = useCallback(() => {
    if (narratorRef.current) return true;
    const n = new Narrator((text) => {
      socketRef.current?.emit('narration_line', {
        roomId, text, t: Date.now() - narrationStartRef.current,
      });
    });
    if (!n.start()) return false;
    narratorRef.current = n;
    setNarrationOn(true);
    return true;
  }, [roomId]);
  // ── Screen sharing (the teacher watching this student's real screen) ──
  // Everything here is gated on the student pressing a button, because
  // getDisplayMedia refuses to run without a gesture. Nothing starts on its own.
  const [shareAsk, setShareAsk] = useState<string | null>(null);   // who is asking
  const [sharing, setSharing] = useState(false);
  const screenPeerRef = useRef<ScreenPeer | null>(null);
  // ── Receiving the TUTOR's screen ──
  // The direction that works on this device. iPadOS Safari cannot capture a
  // screen, but receiving video is ordinary WebRTC — so when the lesson will
  // not render here, the tutor can still show it.
  const [teacherScreen, setTeacherScreen] = useState<MediaStream | null>(null);
  const [teacherScreenName, setTeacherScreenName] = useState('Your teacher');
  const teacherScreenPeerRef = useRef<ScreenPeer | null>(null);

  const endShare = useCallback((tell = true) => {
    screenPeerRef.current?.close();
    screenPeerRef.current = null;
    setSharing(false);
    if (tell) socketRef.current?.emit('screen_state', { roomId, state: 'stopped' });
  }, [roomId]);

  const beginShare = useCallback(async () => {
    setShareAsk(null);
    if (!screenShareSupported()) {
      socketRef.current?.emit('screen_state', { roomId, state: 'unsupported' });
      showNotification('This device cannot share its screen — your teacher has been told.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const peer = new ScreenPeer({
        send: (signal) => socketRef.current?.emit('screen_signal', { roomId, signal }),
        onState: (s) => { if (s === 'failed' || s === 'closed') endShare(true); },
      });
      screenPeerRef.current = peer;
      // The browser's own "Stop sharing" bar is the one most people use. Without
      // this the tutor would keep a frozen last frame on screen and think they
      // were still watching.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => endShare(true));
      await peer.share(stream);
      setSharing(true);
      socketRef.current?.emit('screen_state', { roomId, state: 'sharing' });
    } catch (e) {
      screenPeerRef.current?.close();
      screenPeerRef.current = null;
      const declined = (e as { name?: string })?.name === 'NotAllowedError';
      socketRef.current?.emit('screen_state', { roomId, state: declined ? 'declined' : 'failed' });
    }
  }, [roomId, endShare]);

  const declineShare = useCallback(() => {
    setShareAsk(null);
    socketRef.current?.emit('screen_state', { roomId, state: 'declined' });
  }, [roomId]);

  // The socket effect subscribes once and must not re-run when endShare's
  // identity changes, so it reaches the current one through a ref.
  const endShareRef = useRef(endShare);
  useEffect(() => { endShareRef.current = endShare; }, [endShare]);
  // Leaving the page must release the capture. A tab closed mid-share would
  // otherwise keep the screen-capture indicator up with nobody watching.
  useEffect(() => () => { screenPeerRef.current?.close(); }, []);

  // Keep knocking until the teacher opens the room.
  //
  // This is the whole fix for "I have to join and join and ultimately it
  // connects": the student's link now works whenever they open it, and the
  // lesson starts by itself the moment the teacher arrives. Every 3s, because
  // this is one tiny emit on an idle socket and a student waiting to start a
  // lesson should not sit through a backoff.
  useEffect(() => {
    if (!waitingForRoom || !socket || !connected) return;
    const id = setInterval(() => {
      setJoinAttempts(n => n + 1);
      socket.emit('join_room', { roomId, userName: studentName, role: 'student', tz: localTimezone() });
    }, 3000);
    return () => clearInterval(id);
  }, [waitingForRoom, socket, connected, roomId, studentName]);

  const [currentHtml, setCurrentHtml] = useState("");
  // Server-issued deterministic RNG seed for the current lesson - injected
  // into the sim so Math.random() matches the teacher's exactly.
  const [randomSeed, setRandomSeed] = useState(0);
  const [currentFileName, setCurrentFileName] = useState("");
  const [isPaused, setIsPaused] = useState(false);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  // Whiteboard mutual sync ("shared book"). Default ON: this student's
  // pan/zoom mirrors to the teacher and vice-versa. Toggle off for an
  // independent canvas. peerSyncEnabled tracks the teacher's toggle, used
  // only for a small "Teacher is on independent view" badge.
  const [whiteboardSyncEnabled, setWhiteboardSyncEnabled] = useState(true);
  const [peerSyncEnabled, setPeerSyncEnabled] = useState(true);

  // ── Chat ──
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);

  // ── Reactions ──
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: string; x: number }>>([]);
  const reactionIdRef = useRef(0);

  // ── Quiz ──
  const [quizModal, setQuizModal] = useState<{ question: string; options?: string[] } | null>(null);
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
  // Checkpoint gates by step (question + options; correctIndex is never sent to
  // students — graded server-side). Hydrated from session_state and gate_added.
  const [gates, setGates] = useState<Record<number, GateData>>({});
  // Steps we've already auto-opened the gate for, so reaching the same gated
  // step again (or re-hydration) doesn't keep re-popping the modal.
  const promptedGatesRef = useRef<Set<number>>(new Set());
  // Mirror of the open gate so the once-bound gate_result handler can tell
  // which step was just answered without a stale closure.
  const gateModalRef = useRef<{ step: number; gate: GateData } | null>(null);
  useEffect(() => { gateModalRef.current = gateModal; }, [gateModal]);
  // Correctly-answered gates survive a page refresh via sessionStorage (per
  // room, per tab) — without this the modal re-opened on every reload because
  // currentStep + gates re-hydrate identically. Server-side anti-farm already
  // makes re-answering worthless; this removes the UX annoyance.
  const gateDoneKey = `mathlive:gatesDone:${roomId ?? ''}`;
  const readGatesDone = useCallback((): number[] => {
    try { const raw = sessionStorage.getItem(gateDoneKey); const arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr) ? arr.filter((n: unknown) => typeof n === 'number') : []; } catch { return []; }
  }, [gateDoneKey]);
  const markGateDone = useCallback((step: number) => {
    try { const next = Array.from(new Set([...readGatesDone(), step])); sessionStorage.setItem(gateDoneKey, JSON.stringify(next)); } catch { /* storage unavailable — modal may re-open after refresh, harmless */ }
  }, [gateDoneKey, readGatesDone]);

  // ── Scroll Sync ──
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(true);

  // ── Zoom Sync (read-only; controlled by teacher) ──
  const [zoomLevel, setZoomLevel] = useState(1);

  // ── Gamification ──
  const [myXp, setMyXp] = useState(0);
  const [myStreak, setMyStreak] = useState(0);
  const [myLevel, setMyLevel] = useState(1);
  const [xpFloater, setXpFloater] = useState<{ id: number; amount: number } | null>(null);
  const [levelUpBanner, setLevelUpBanner] = useState(false);
  const [leaderboard, setLeaderboard] = useState<Array<{ studentName: string; xp: number; streak: number }>>([]);
  const [showLeaderboard, setShowLeaderboard] = useState(false);

  // ── Whiteboard ──
  const [whiteboardMode, setWhiteboardMode] = useState(false);
  const [whiteboardScrollX, setWhiteboardScrollX] = useState(0);
  const [whiteboardScrollY, setWhiteboardScrollY] = useState(0);
  const [whiteboardState, setWhiteboardState] = useState<any>(null);
  // AUTONOMOUS: HTML-overlay annotations (server-persisted). Snapshot
  // arrives on join via session_state so a late-joining student sees
  // the same markup the teacher built up earlier in the class.
  const [annotations, setAnnotations] = useState<Array<{ senderId: string; stroke: any }> | undefined>(undefined);
  const whiteboardRef = useRef<import('../components/Whiteboard').WhiteboardRef>(null);

  // ── Follow Teacher Clicks ──
  const [followTeacherClicks, setFollowTeacherClicks] = useState(false);

  // ── Temporary Explanation Content ──
  const [tempContent, setTempContent] = useState<{ html: string; name: string } | null>(null);
  const [showTempContent, setShowTempContent] = useState(false);

  // Built once per explanation and handed over as srcdoc — same reasoning as
  // the lesson document: no object URL means no revoke to race the load.
  const tempContentDoc = useMemo(() => {
    if (!tempContent) return null;
    const scripts = seededSyncScript(randomSeed) + stepLockScript;
    let content = tempContent.html;
    if (content.includes("<head>")) {
      content = content.replace("<head>", "<head>" + scripts);
    } else {
      content = scripts + content;
    }
    return content;
  }, [tempContent?.html, tempContent?.name, randomSeed]);

  // ── Student Interaction Mode ──
  const [interactionAllowed, setInteractionAllowed] = useState(false);
  // ── Control grant ("the chalk") ──
  // The teacher can hand exclusive drive rights to ONE student. When this
  // student holds it, their interactions drive the shared sim even if the
  // room-wide interaction toggle is off. controlHolderName mirrors the
  // canonical field; hasControl is the derived "is it me".
  const [controlHolderName, setControlHolderName] = useState<string | null>(null);
  const hasControl = !!controlHolderName && controlHolderName === studentName;
  // SINGLE-WRITER: a student may drive the shared lesson sim ONLY while they
  // personally hold the control grant ("the chalk"). The room-wide interaction
  // toggle does NOT make a student a sim driver - two independent drivers
  // each roll their own Math.random() and diverge instantly. (The toggle
  // still enables annotations / whiteboard collaboration, which need no
  // determinism and live in a layer above the sim.)
  const canDrive = hasControl;
  const canDriveRef = useRef(false);
  useEffect(() => { canDriveRef.current = canDrive; }, [canDrive]);
  // Tracks the last touch-Y so the view-only overlay can translate a finger
  // drag into iframe scrolling (forward scroll while still blocking clicks).
  const overlayTouchYRef = useRef(0);
  // canInteract = may this student CLICK / TYPE into the lesson sim (press its
  // buttons, answer the quiz)? True when the teacher has enabled interactive
  // mode OR handed this student control. In a 1-to-1 lesson "interactive mode"
  // literally means "your turn — use the buttons", so the student's pointer
  // MUST reach the sim. A non-control student's events stay LOCAL: the relay
  // below only forwards to the server when canDrive, and the server drops
  // non-holder events — so they work their own copy without driving the class.
  //  - View-only (canInteract=false): a transparent overlay blocks taps so the
  //    student purely mirrors the teacher (can't click ahead). Scroll still
  //    works — the overlay forwards wheel/touch into the iframe.
  //  - Interactive (canInteract=true): NO blocking overlay — taps reach the sim.
  //    The student chooses Pointer (default = click) / Pen / Eraser in the rail.
  const canInteract = interactionAllowed || hasControl;
  const canInteractRef = useRef(false);
  useEffect(() => { canInteractRef.current = canInteract; }, [canInteract]);
  // Whether the student may SKETCH over the lesson (Pen / Eraser). Unlocked
  // whenever interaction is — kept as its own flag so the two can diverge later.
  const canAnnotate = interactionAllowed || hasControl;

  // ── Student Annotation Tools ──
  // Students can scribble on the HTML overlay - but ONLY when sketching is
  // unlocked (canAnnotate: interactive mode or this student holds control).
  // When the teacher is presenting (view-only) the student is a pure viewer:
  // the sketch toolbar is hidden, the overlay is non-interactive, and the
  // server rejects stray strokes. Pen colour defaults to rose so a student's
  // strokes are visually distinct from the teacher's indigo.
  const [studentDrawMode, setStudentDrawMode] = useState(false);
  const [studentEraser, setStudentEraser] = useState<'off' | 'stroke'>('off');
  // The moment sketching is revoked (teacher switches to view-only / takes
  // back control), drop any active pen/eraser so a mid-draw student stops
  // immediately instead of finishing the current stroke.
  useEffect(() => {
    if (!canAnnotate) {
      setStudentDrawMode(false);
      setStudentEraser('off');
    }
  }, [canAnnotate]);
  const STUDENT_COLORS = ['#F43F5E', '#F59E0B', '#10B981', '#0EA5E9', '#8B5CF6', '#0F172A'];
  const [studentPenColor, setStudentPenColor] = useState<string>(STUDENT_COLORS[0]);

  // ── Attention Check ──
  const [attentionCheckModal, setAttentionCheckModal] = useState(false);
  const attentionTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // ── Teacher Status ──
  const [teacherDisconnected, setTeacherDisconnected] = useState(false);
  const teacherDisconnectedRef = useRef(false);

  // ── Join Error ──
  const [joinError, setJoinError] = useState<string | null>(null);

  // ── Sound ──
  // AUTONOMOUS: [ORDER-2 ESSENTIAL] - hydrate from persisted mute pref.
  const [soundMuted, setSoundMuted] = useState(() => sounds.isMuted());

  // ── Iframe readiness ──
  const iframeReadyRef = useRef(false);
  const pendingMessagesRef = useRef<any[]>([]);
  const syncEpochRef = useRef(0);
  const lastInboundSeqRef = useRef(0);
  const lastStudentMissAtRef = useRef(0);
  // Debounce for streaming the student's own DOM snapshot up to the teacher
  // (absolute-state sync so the teacher tracks the student's true state).
  const studentSnapTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const lastRevisionRef = useRef(0);
  // Refs the once-set-up socket handlers read for live values.
  const interactionAllowedRef = useRef(false);
  const currentHtmlRef = useRef('');
  useEffect(() => { interactionAllowedRef.current = interactionAllowed; }, [interactionAllowed]);
  useEffect(() => { currentHtmlRef.current = currentHtml; }, [currentHtml]);

  // THE single entry point for changing the sim's HTML. Dedupe lives here
  // (identical html → no rebuild, sim instance survives), and when the html
  // genuinely changes we zero the applied-seq tracker SYNCHRONOUSLY — the
  // tracker belongs to the sim instance, and the next journal replay must
  // re-live the lesson into the fresh sim from seq 0. Doing this inside the
  // setter (not a post-render effect) closes the race where a replay
  // arriving between render and effect would be mis-filtered.
  const setSimHtml = useCallback((html: string | null | undefined) => {
    if (typeof html !== 'string' || html.length === 0) return;
    setCurrentHtml(prev => {
      if (prev === html) return prev;
      lastInboundSeqRef.current = 0; // idempotent — safe under StrictMode double-invoke
      return html;
    });
  }, []);

  const applySessionState = useCallback((state: any) => {
    // ── Server-restart detection ──
    // The room's interaction counter can only be BEHIND our applied-seq
    // filter if the room was rebuilt (redeploy / cold-start / reset). The
    // seq filter deliberately survives socket blips — but after a restart
    // with IDENTICAL lesson HTML the iframe never rebuilds, the filter is
    // never zeroed, and every fresh event (seq restarting from 1) is
    // silently dropped as "stale". Adopt the server's counter instead.
    if (typeof state.interactionSeq === 'number' && state.interactionSeq < lastInboundSeqRef.current) {
      lastInboundSeqRef.current = state.interactionSeq;
      lastRevisionRef.current = 0;
    }
    if (typeof state.revision === 'number') {
      if (state.revision < lastRevisionRef.current) return;
      lastRevisionRef.current = state.revision;
    }
    if (state.files) setFiles(state.files);
    if (state.activeFileId !== undefined) setActiveFileId(state.activeFileId);
    if (typeof state.isPaused === 'boolean') setIsPaused(state.isPaused);
    if (typeof state.scrollSyncEnabled === 'boolean') setScrollSyncEnabled(state.scrollSyncEnabled);
    if (typeof state.studentInteractionAllowed === 'boolean') setInteractionAllowed(state.studentInteractionAllowed);
    if (typeof state.currentStep === 'number') setCurrentStep(state.currentStep);
    if (typeof state.zoomLevel === 'number') setZoomLevel(state.zoomLevel);
    if (state.gates && typeof state.gates === 'object') setGates(state.gates);
    if (typeof state.randomSeed === 'number') setRandomSeed(state.randomSeed);
    if ('controlHolderName' in state) setControlHolderName(state.controlHolderName ?? null);
    if (state.chat) setChatMessages(state.chat);
    if (state.whiteboard) setWhiteboardState(state.whiteboard);
    if (Array.isArray(state.annotations)) setAnnotations(state.annotations);
    // Whiteboard mode (teacher is on the whiteboard surface, not HTML) is
    // server-persisted so a late-joining student lands on the right surface.
    // Without this, a student joining mid-lesson would sit on "Waiting for
    // teacher" forever — the server has no lastRunHtml to deliver because
    // the teacher chose whiteboard instead of uploading HTML.
    if (typeof state.whiteboardMode === 'boolean') setWhiteboardMode(state.whiteboardMode);
    // Temp explanation content: handle BOTH branches explicitly. If the
    // teacher cleared temp content while this student was offline, the
    // reconnect's session_state arrives with tempContent: null — the old
    // code's `if (state.tempContent)` only handled truthy, so the student
    // stayed stuck on the cleared explanation forever.
    if (state.tempContent) {
      setTempContent(state.tempContent);
      setShowTempContent(true);
    } else if ('tempContent' in state) {
      setTempContent(null);
      setShowTempContent(false);
    }
    if (state.lastTeacherScroll) {
      const remoteScroll = { ...state.lastTeacherScroll, type: 'REMOTE_SCROLL' };
      pendingMessagesRef.current = pendingMessagesRef.current
        .filter((msg: any) => msg.type !== 'REMOTE_SCROLL')
        .concat(remoteScroll)
        .slice(-500);
    }
    const html = state.effectiveHtml || state.liveSnapshotHtml || state.lastRunHtml || state.sourceHtml;
    if (html) {
      const activeFile = state.files?.find((f: FileEntry) => f.id === state.activeFileId);
      setCurrentFileName(activeFile?.name || 'Simulation');
      setSimHtml(html);
    }
  }, []);

  // Auto-open the checkpoint gate when the class reaches a gated step the
  // student hasn't been prompted for yet. This is the trigger that was missing
  // — gates were created and stored but never shown to students. Reacting to
  // currentStep/gates state covers every path (step_changed, gate_added, and
  // session_state hydration on join/reconnect). promptedGatesRef makes it
  // fire once per step so frequent re-hydration doesn't re-pop the modal.
  useEffect(() => {
    if (currentStep >= 999) return; // 999 = no step lock active
    const gate = gates[currentStep];
    if (!gate || !Array.isArray(gate.options) || gate.options.length < 2) return;
    if (promptedGatesRef.current.has(currentStep)) return;
    if (readGatesDone().includes(currentStep)) return; // answered before refresh
    promptedGatesRef.current.add(currentStep);
    setGateModal({ step: currentStep, gate });
  }, [currentStep, gates, readGatesDone]);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Re-anchor a remote SYNC_CURSOR to the element the sender was hovering,
  // resolved against THIS client's iframe layout (same-origin, so we can read
  // it). Returns normalized overlay coordinates; falls back to the sender's
  // raw viewport fractions when there's no path or it doesn't resolve.
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
    } catch { /* cross-origin or detached iframe — fall through */ }
    return { x: event?.x ?? 0, y: event?.y ?? 0 };
  }, []);

  const notifTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const showNotification = (msg: string) => {
    if (notifTimeoutRef.current) clearTimeout(notifTimeoutRef.current);
    setNotification(msg);
    notifTimeoutRef.current = setTimeout(() => setNotification(""), 4000);
  };

  const toggleWhiteboardSync = () => {
    if (!socket) return;
    const next = !whiteboardSyncEnabled;
    setWhiteboardSyncEnabled(next);
    socket.emit('set_whiteboard_sync', { roomId, enabled: next });
    showNotification(next ? '📖 Shared view: pan and zoom mirror both sides' : '🔓 Independent view: your canvas moves only for you');
  };

  // Release the document still on screen when the student leaves the room.
  // Separate from the build effect, which deliberately only ever revokes the
  // document it replaced.
  useEffect(() => () => {
    if (lessonUrlRef.current) URL.revokeObjectURL(lessonUrlRef.current);
  }, []);

  // ── Build iframe URL ──
  useEffect(() => {
    if (!currentHtml) { setLessonUrl(""); setMirrorPainted(false); return; }
    setMirrorPainted(false);   // a rebuilt shell is blank again until repainted
    // Mark iframe as not ready while we rebuild it
    iframeReadyRef.current = false;
    // LIVE MIRROR: build a follower shell — the lesson's own <script>s are
    // STRIPPED so it never runs the lesson (that would make it a diverging
    // instance); only the follower agent runs, painting the teacher's streamed
    // DOM. Keeps <head>/<style>/<link> so the mirror looks identical.
    const scripts = MIRROR_MODE
      ? mirrorScriptFor('follower')
      : seededSyncScript(randomSeed) + stepLockScript;
    let content = MIRROR_MODE ? stripLessonScripts(currentHtml) : currentHtml;
    if (content.includes("<head>")) {
      content = content.replace("<head>", "<head>" + scripts);
    } else if (content.includes("<html>")) {
      content = content.replace("<html>", "<html><head>" + scripts + "</head>");
    } else {
      content = scripts + content;
    }
    // Handed to the iframe as a blob: URL — the same mechanism the teacher's
    // own iframe uses (Room.tsx). Keeping the two sides symmetrical matters.
    //
    // This was srcdoc for a while, to dodge a revoke race: the effect re-runs
    // whenever the lesson or the seed changes — twice in quick succession on a
    // normal join (html lands, then the seed) — and revoking a URL whose load
    // was still in flight blanked the frame permanently on slower devices.
    //
    // But srcdoc traded that bug for a worse one. WebKit is far less tolerant
    // of a multi-megabyte srcdoc than of a blob: URL, and lessons run to the
    // 2MB file cap. The teacher, on a blob URL, saw the lesson fine; the
    // student on an iPad got a white rectangle. Whiteboard unaffected, because
    // it is not an iframe — which is exactly how it was reported.
    //
    // So: blob URL, and fix the revoke race properly instead of avoiding it.
    // Only the PREVIOUS document is ever revoked, never the one just handed
    // over, and only after a delay long enough that no load can still be using
    // it. A stale blob is a few hundred KB held a minute longer; a revoked
    // live one is a blank screen for the rest of the lesson.
    const url = URL.createObjectURL(new Blob([content], { type: 'text/html' }));
    const previous = lessonUrlRef.current;
    lessonUrlRef.current = url;
    setLessonUrl(url);
    if (previous) {
      // Deliberately NOT cleared on re-run. If this effect fires again before
      // the timer elapses, that older URL still needs releasing, and cancelling
      // the timer would leak it for the whole session.
      setTimeout(() => URL.revokeObjectURL(previous), 60_000);
    }
    // Keyed on randomSeed too: a new lesson baseline reseeds, and the iframe
    // must rebuild so the sim picks up the matching seed from question one.
  }, [currentHtml, randomSeed]);

  // ── Socket Connection ──
  useEffect(() => {
    if (!roomId) { navigate("/"); return; }

    // The passcode rides on the handshake — the server refuses the connection
    // without it, so this is the only place it needs to be presented.
    const newSocket = io({ auth: socketAuth() });
    newSocket.on('connect_error', (err) => {
      // A refused handshake means the stored code is wrong or stale. Tell the
      // gate so it can ask again, rather than leaving a room that silently
      // never connects.
      if (isPasscodeError(err)) window.dispatchEvent(new Event('mathslive:passcode-refused'));
    });
    setSocket(newSocket);

    let cleanupAttention: (() => void) | null = null;

    newSocket.on("connect", () => {
      setConnected(true);
      // Revision guard resets on (re)connect: a room recreated after expiry
      // restarts revisions at 0 and a stale high guard would silently drop
      // every fresh session_state. Re-applying an identical state is
      // harmless (hydration is idempotent), so zeroing is safe.
      lastRevisionRef.current = 0;
      // NOTE: lastInboundSeqRef is deliberately NOT reset here. It tracks the
      // highest serverSeq THIS SIM INSTANCE has applied — that's what lets a
      // reconnect replay exactly the missed gap and nothing twice. It resets
      // only when the iframe genuinely rebuilds (new sim instance).
      newSocket.emit("join_room", { roomId, userName: studentName, role: 'student', tz: localTimezone() });
      // Start attention detection
      cleanupAttention = setupAttentionDetection(newSocket, roomId, studentName);
    });

    // ── Event-journal replay (late-join + reconnect convergence) ──
    // The server attaches the full journal (discrete events since the last
    // content baseline) to every hydration. We apply ONLY events newer than
    // what this sim instance already lived (serverSeq filter), through the
    // queued transport — so a fresh iframe re-lives the whole lesson, a
    // kicked-and-reloaded tab catches up exactly, and a tab whose socket
    // merely blipped replays nothing it already applied.
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
      if (applied > 0) showNotification(`⚡ Catching you up — replayed ${applied} class steps`);
    });

    newSocket.on("disconnect", () => {
      setConnected(false);
      showNotification("⚠️ Disconnected. Reconnecting...");
    });

    newSocket.on("reconnect" as any, () => {
      setConnected(true);
      lastRevisionRef.current = 0;
      // lastInboundSeqRef intentionally kept — see the connect handler.
      newSocket.emit("join_room", { roomId, userName: studentName, role: 'student', tz: localTimezone() });
      showNotification("✅ Reconnected!");
    });

    // AUTONOMOUS: The server forcibly disconnected us because another
    // tab joined with the same name. The new tab is now the
    // authoritative session; this stale one should not keep emitting.
    // Tell the user with a friendly notification, then disconnect
    // ourselves so the auto-reconnect loop doesn't immediately rejoin
    // and kick the user OUT of their good tab.
    newSocket.on("session_taken_over" as any, () => {
      showNotification("📱 Your session moved to another tab.");
      newSocket.io.opts.reconnection = false;
      newSocket.disconnect();
    });

    newSocket.on("room_state", (state: any) => {
      applySessionState(state);
      setFiles(state.files || []);
      setActiveFileId(state.activeFileId);
      setIsPaused(state.isPaused);
      if (typeof state.scrollSyncEnabled === 'boolean') setScrollSyncEnabled(state.scrollSyncEnabled);
      if (typeof state.studentInteractionAllowed === 'boolean') setInteractionAllowed(state.studentInteractionAllowed);
      if (typeof state.currentStep === 'number') setCurrentStep(state.currentStep);
      setChatMessages(state.chat || []);
      if (typeof state.revision === 'number') lastRevisionRef.current = state.revision;
      if (state.lastRunHtml) {
        const f = state.files?.find((f: FileEntry) => f.id === state.activeFileId);
        setCurrentFileName(f?.name || 'Simulation');
        setSimHtml(state.lastRunHtml);
      } else if (state.activeFileId && state.files) {
        const f = state.files.find((f: FileEntry) => f.id === state.activeFileId);
        if (f) { setCurrentFileName(f.name); setSimHtml(f.html); }
      }
    });

    newSocket.on("session_state", applySessionState);
    newSocket.on("sync_full_state", applySessionState);

    newSocket.on("file_uploaded", (file: FileEntry) => {
      setFiles(prev => [...prev, file]);
      showNotification(`📄 Teacher uploaded: ${file.name}`);
      sounds.join();
    });

    newSocket.on("active_file_changed", (data: { fileId: string; fileName?: string; html?: string; currentStep?: number; revision?: number }) => {
      if (typeof data.revision === 'number') {
        if (data.revision < lastRevisionRef.current) return;
        lastRevisionRef.current = data.revision;
      }
      setActiveFileId(data.fileId);
      if (typeof data.currentStep === 'number') {
        setCurrentStep(data.currentStep);
      }
      if (data.html) {
        setCurrentFileName(data.fileName || 'Simulation');
        // File switch is a genuine reload — update HTML
        setSimHtml(data.html);
        showNotification(`Switched to: ${data.fileName || 'new file'}`);
      }
    });

    newSocket.on("run_preview", ({ html, revision }: { fileId: string; html: string; revision?: number }) => {
      if (typeof revision === 'number') {
        if (revision < lastRevisionRef.current) return;
        lastRevisionRef.current = revision;
      }
      // Only update if HTML actually changed — avoids full iframe reload (blink + scroll reset)
      setSimHtml(html);
    });

    newSocket.on("dom_snapshot", ({ html, revision }: { fileId: string; html: string; revision?: number }) => {
      if (typeof revision === 'number') {
        if (revision < lastRevisionRef.current) return;
        lastRevisionRef.current = revision;
      }
      // dom_snapshot now only arrives on explicit Force Sync (server no longer
      // streams per-interaction snapshots to joined students). Treat it as a
      // genuine content load: full iframe rebuild so the sim's scripts re-run
      // from a clean state. The old REMOTE_DOM body-swap "soft mirror" is
      // retired — swapping body.innerHTML destroyed the sim's event listeners
      // (student clicks stopped doing anything), detached the nodes the sim's
      // own scripts animate (canvas/3D froze or blanked), and raced the
      // click-replay stream (quiz drift). Live following is done by replaying
      // interaction events into the student's own live sim instance.
      setSimHtml(html);
    });

    // NOTE: the legacy `live_dom` continuous follow-mirror is retired (see
    // dom_snapshot above). The server no longer emits it; no listener here.

    // ── LIVE MIRROR (source → follower) ──
    // The teacher's authoritative DOM/canvas, relayed by the server. Paint it
    // into the follower shell. This is the "impossible to desync" path: the
    // student renders exactly what the teacher's real lesson produced.
    newSocket.on("mirror_dom", ({ body, scrollX, scrollY, attrs, head, h }: { body: string; scrollX?: number; scrollY?: number; attrs?: string; head?: string | null; h?: string }) => {
      if (typeof body !== 'string') return;
      setMirrorPainted(true);
      postToIframe({ type: 'MIRROR_APPLY', body, scrollX, scrollY, attrs, head, h });
    });
    // Fingerprint of the teacher's current screen. The follower compares it with
    // what it actually rendered and asks for a resync if a frame was lost.
    newSocket.on("narration_request", ({ on, elapsed }: { on: boolean; elapsed?: number }) => {
      if (!on) {
        setNarrationOn(false);
        narratorRef.current?.stop();
        narratorRef.current = null;
        return;
      }
      if (!narrationSupported()) return;   // nothing to offer on this browser
      // Anchor to the teacher's lesson clock: our lines are stamped as
      // (their elapsed at this instant) + (time since). Stamping from our own
      // arrival would put every student line near zero and scramble the order
      // of the merged transcript.
      narrationStartRef.current = Date.now() - Math.max(0, Number(elapsed) || 0);
      // Start straight away. The tutor obtains consent from the student and
      // parent outside the app, so asking again here only interrupted a lesson
      // that already had permission. A student who presses Stop is not
      // restarted — that choice is remembered.
      if (getNarrationChoice(roomId || '') === 'no') return;
      beginNarrating();
    });
    // ── Screen share ──
    newSocket.on("screen_request", ({ teacherName }: { teacherName?: string }) => {
      // Answer for the device before troubling the student: on an iPad there is
      // no getDisplayMedia at all, so a prompt here would ask them to do
      // something their browser cannot do and leave the teacher waiting.
      if (!screenShareSupported()) {
        newSocket.emit('screen_state', { roomId, state: 'unsupported' });
        return;
      }
      setShareAsk(teacherName || 'Your teacher');
    });
    newSocket.on("screen_signal", ({ signal }: { signal: any }) => {
      // Two conversations share this channel: our own share (we offered, they
      // answer) and the tutor's share (they offer, we answer). An offer is
      // always theirs — we never answer our own.
      if (signal?.description?.type === 'offer') {
        if (!teacherScreenPeerRef.current) {
          const peer = new ScreenPeer({
            send: (sig) => newSocket.emit('screen_signal', { roomId, signal: sig }),
            onStream: (stream) => setTeacherScreen(stream),
            onState: (st) => { if (st === 'failed' || st === 'closed') setTeacherScreen(null); },
          });
          teacherScreenPeerRef.current = peer;
        }
        void teacherScreenPeerRef.current.accept(signal);
        return;
      }
      // A candidate could belong to either. Give it to whichever exists;
      // ScreenPeer holds candidates that arrive before their description.
      if (teacherScreenPeerRef.current) void teacherScreenPeerRef.current.accept(signal);
      if (screenPeerRef.current) void screenPeerRef.current.accept(signal);
    });

    newSocket.on("teacher_screen", ({ on, name }: { on: boolean; name?: string }) => {
      if (name) setTeacherScreenName(name);
      if (on) {
        showNotification(`🖥️ ${name || 'Your teacher'} is sharing their screen`);
        return;   // the offer follows; the handler above builds the peer
      }
      teacherScreenPeerRef.current?.close();
      teacherScreenPeerRef.current = null;
      setTeacherScreen(null);
    });
    newSocket.on("screen_state", ({ state }: { state: string }) => {
      // The teacher closed the window. Stop capturing — leaving the screen
      // captured because nobody is looking is exactly the wrong default.
      if (state === 'stopped') {
        endShareRef.current?.(false);
        setShareAsk(null);
      }
    });

    // Arriving room state IS the join succeeding — stop waiting and stop
    // knocking.
    newSocket.on("room_state", () => { setWaitingForRoom(false); setJoinAttempts(0); });

    newSocket.on("mirror_ping", ({ h }: { h?: string }) => {
      if (typeof h !== 'string') return;
      postToIframe({ type: 'MIRROR_PING', h });
    });
    newSocket.on("mirror_canvas", ({ canvases }: { canvases: any[] }) => {
      if (!Array.isArray(canvases)) return;
      postToIframe({ type: 'MIRROR_CANVAS', canvases });
    });
    newSocket.on("mirror_scroll", ({ scrollX, scrollY }: { scrollX?: number; scrollY?: number }) => {
      postToIframe({ type: 'MIRROR_SCROLL', scrollX, scrollY });
    });

    newSocket.on("force_sync_state", (state: any) => {
      if (typeof state.revision === 'number') {
        if (state.revision < lastRevisionRef.current) return;
        lastRevisionRef.current = state.revision;
      }
      if (state.files) setFiles(state.files);
      if (state.activeFileId) setActiveFileId(state.activeFileId);
      if (state.lastRunHtml) {
        // Only rebuild iframe if HTML actually changed
        setSimHtml(state.lastRunHtml);
        const f = state.files?.find((f: FileEntry) => f.id === state.activeFileId);
        setCurrentFileName(f?.name || 'Simulation');
      }
      if (typeof state.isPaused === 'boolean') setIsPaused(state.isPaused);
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

    newSocket.on("quiz", ({ question, options }: { question: string; options?: string[] }) => {
      const validOptions = Array.isArray(options) ? options.filter(o => typeof o === 'string' && o.trim()) : [];
      setQuizModal({ question, options: validOptions.length >= 2 ? validOptions : undefined });
      setQuizAnswer("");
      setQuizSubmitted(false);
      showNotification("🎯 You have a question from your teacher!");
      sounds.raiseHand();
    });

    // ── Temporary Explanation Content ──
    newSocket.on("temp_content", ({ html, name }: { html: string; name: string }) => {
      setTempContent({ html, name });
      setShowTempContent(true);
      showNotification(`📚 Teacher is showing explanation: ${name}`);
    });
    newSocket.on("clear_temp_content", () => {
      setShowTempContent(false);
      showNotification('↩️ Back to main content');
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
      if (typeof event.serverSeq === 'number') {
        if (event.serverSeq <= lastInboundSeqRef.current) return;
        lastInboundSeqRef.current = event.serverSeq;
      }
      // syncEpoch comparison was removed (it was already removed on the
      // teacher side). syncEpoch is a per-CLIENT local counter — comparing
      // the teacher's number to the student's silently dropped every event
      // whenever the two counters drifted (eg after the student rebuilt the
      // iframe on a file switch — first teacher event after that arrived
      // with a smaller epoch and was discarded). serverSeq above is the
      // canonical, server-issued ordering and is sufficient on its own.
      // Track zoom level so we can re-apply on iframe reload
      if (event.type === "SYNC_ZOOM" && typeof event.zoom === 'number') {
        setZoomLevel(event.zoom);
      }
      if (event.type === "SYNC_CURSOR") {
        // Element-anchored cursor: re-resolve the sender's hovered element in
        // OUR layout so the dot sits on the same CONTENT (e.g. the end of
        // option C), not the same screen percentage — centered fixed-width
        // lessons made raw percentages land an option or two off. Falls back
        // to the viewport fractions when the path doesn't resolve.
        const pos = resolveCursorPosition(event);
        setCursors(prev => ({
          ...prev,
          [event.userId]: {
            x: pos.x, y: pos.y,
            color: CURSOR_COLORS[event.userId.charCodeAt(0) % CURSOR_COLORS.length],
            name: cleanDisplayName(event.userName) || 'Teacher',
          },
        }));
      } else if (event.type === "SYNC_CLICK") {
        // Auto-scroll to teacher click if following is enabled
        if (followTeacherClicks && iframeRef.current) {
          iframeRef.current.contentWindow?.postMessage({
            type: 'FOLLOW_CLICK',
            x: event.clientX,
            y: event.clientY
          }, '*');
        }
        const remoteEvent = { ...event, type: event.type.replace("SYNC_", "REMOTE_") };
        postToIframe(remoteEvent);
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

    newSocket.on("gate_added", ({ step, question, options }: { step: number; question?: string; options?: string[] }) => {
      showNotification(`🚧 Checkpoint added at Step ${step}`);
      // Store the gate so the auto-open effect can prompt the student when the
      // class reaches this step. correctIndex stays -1 (graded server-side).
      if (question && Array.isArray(options) && options.length >= 2) {
        setGates(prev => ({ ...prev, [step]: { question, options, correctIndex: -1 } }));
      }
    });

    // ── Scroll Sync ──
    newSocket.on("scroll_sync_changed", ({ enabled }: { enabled: boolean }) => {
      setScrollSyncEnabled(enabled);
      showNotification(enabled ? '🔗 Scroll sync enabled' : '🔓 Free scroll — you can scroll independently');
    });

    // ── Student Interaction Mode ──
    newSocket.on("student_interaction_changed", ({ allowed }: { allowed: boolean }) => {
      setInteractionAllowed(allowed);
      showNotification(allowed ? '🖐️ You can now interact with the simulation' : '👁️ View-only mode — teacher is presenting');
    });

    // ── Control grant ("the chalk") ──
    newSocket.on("control_changed", ({ holderName }: { holderName: string | null }) => {
      setControlHolderName(holderName);
      if (holderName === studentName) {
        showNotification('✋ You have control — your screen now drives the class');
        sounds.success();
      } else if (holderName) {
        showNotification(`🎯 ${holderName} is driving the class`);
      } else {
        showNotification('👁️ Control returned to the teacher');
      }
    });

    // ── Teacher peek: serialize this student's REAL screen and send it up ──
    newSocket.on("request_student_snapshot", ({ requestId }: { requestId?: string }) => {
      postToIframe({ type: 'REQUEST_HTML', requestId: requestId || `peek-${Date.now()}` });
    });

    // ── Whiteboard Mutual Sync ──
    newSocket.on("whiteboard_sync_changed", ({ userId, enabled }: { userId: string; userName: string; enabled: boolean }) => {
      if (userId === newSocket.id) {
        setWhiteboardSyncEnabled(enabled);
      } else {
        setPeerSyncEnabled(enabled);
      }
    });

    // ── Whiteboard Mode ──
    newSocket.on("whiteboard_mode_changed", ({ active }: { active: boolean }) => {
      setWhiteboardMode(active);
    });

    // ── Whiteboard Scroll Sync ──
    newSocket.on("whiteboard_scroll", ({ scrollX, scrollY }: { scrollX: number; scrollY: number }) => {
      setWhiteboardScrollX(scrollX);
      setWhiteboardScrollY(scrollY);
    });

    // ── Zoom Sync ──
    newSocket.on("zoom_changed", ({ zoom }: { zoom: number }) => {
      setZoomLevel(zoom);
    });

    // ── Reset View ──
    newSocket.on("reset_view", () => {
      postToIframe({ type: 'RESET_VIEW' });
    });

    // ── Join Error ──
    newSocket.on("join_error", ({ message, retryable }: { message: string; retryable?: boolean }) => {
      if (retryable) {
        // Do NOT show the dead end. The student did nothing wrong and the
        // situation fixes itself the moment the teacher opens the room; the
        // retry effect below keeps knocking so they never touch the page.
        setWaitingForRoom(true);
        setJoinError(null);
        return;
      }
      setWaitingForRoom(false);
      setJoinError(message);
    });

    // ── Teacher Disconnected ──
    // AUTONOMOUS: track current "is teacher disconnected" state via a ref
    // so the user_list listener doesn't capture a stale value. Without
    // this, "Teacher reconnected!" toast never fired because the listener's
    // closure saw teacherDisconnected = false from mount.
    newSocket.on("teacher_disconnected", () => {
      setTeacherDisconnected(true);
      teacherDisconnectedRef.current = true;
      showNotification("⚠️ Teacher disconnected — waiting for reconnection...");
    });

    // Clear teacher disconnected when a new user list arrives with a teacher
    newSocket.on("user_list", (list: Array<{ role: string }>) => {
      const hasTeacher = list.some(u => u.role === 'teacher');
      if (hasTeacher && teacherDisconnectedRef.current) {
        setTeacherDisconnected(false);
        teacherDisconnectedRef.current = false;
        showNotification("✅ Teacher reconnected!");
      }
    });

    // ── Attention Check ──
    newSocket.on("attention_check", () => {
      setAttentionCheckModal(true);
      if (sounds && !soundMuted) sounds.raiseHand();
      // Auto-dismiss after 30s if student doesn't respond
      if (attentionTimeoutRef.current) clearTimeout(attentionTimeoutRef.current);
      attentionTimeoutRef.current = setTimeout(() => setAttentionCheckModal(false), 30000);
    });

    // ── Kick ──
    newSocket.on("kicked", () => {
      showNotification("You have been removed from the session");
      setTimeout(() => navigate("/"), 2000);
    });

    // ── Gamification ──
    newSocket.on("gate_result", ({ correct, xpGained, xp, streak, level, levelUp }: {
      correct: boolean; xpGained?: number; xp?: number; streak?: number; level?: number; levelUp?: boolean;
    }) => {
      // Remember a correct answer for this tab so a refresh doesn't re-open
      // the same checkpoint (the server already refuses to re-award XP).
      if (correct && gateModalRef.current) {
        markGateDone(gateModalRef.current.step);
      }
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
      // Keep student's own stats in sync from authoritative server data
      const mine = lb.find(e => e.studentName === studentName);
      if (mine) {
        setMyXp(mine.xp);
        setMyStreak(mine.streak);
        setMyLevel(Math.floor(mine.xp / 100) + 1);
      }
    });

    // ── Hard Reset (content preserved — only session progress is cleared) ──
    newSocket.on("room_reset", (payload?: { activeFileId?: string | null; files?: FileEntry[]; lastRunHtml?: string | null; revision?: number }) => {
      // Track the bumped revision so subsequent session_state isn't dropped
      // by the freshness guard against this client's pre-reset value.
      if (typeof payload?.revision === 'number' && payload.revision > lastRevisionRef.current) {
        lastRevisionRef.current = payload.revision;
      }
      // Clear session progress/state
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
      setGates({});
      promptedGatesRef.current = new Set();
      try { sessionStorage.removeItem(gateDoneKey); } catch { /* ignore */ }
      // Keep uploaded files list in sync with authoritative server state
      if (payload?.files) setFiles(payload.files);
      if (payload?.activeFileId !== undefined) setActiveFileId(payload.activeFileId);
      // Reload the active file into preview so it restarts fresh from the top —
      // but DO NOT blank out the iframe (content stays visible)
      if (payload?.activeFileId && payload.files) {
        const active = payload.files.find(f => f.id === payload.activeFileId);
        if (active) {
          setSimHtml(active.html);
          setCurrentFileName(active.name);
        }
      } else if (payload?.lastRunHtml) {
        setSimHtml(payload.lastRunHtml);
      }
      showNotification("🔄 Teacher restarted the session");
    });

    return () => {
      cleanupAttention?.();
      if (attentionTimeoutRef.current) clearTimeout(attentionTimeoutRef.current);
      newSocket.disconnect();
    };
  }, [roomId, navigate, studentName]);

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
        if (data.html && (typeof data.revision !== 'number' || data.revision >= lastRevisionRef.current) && !currentHtml) {
          if (typeof data.revision === 'number') lastRevisionRef.current = data.revision;
          setCurrentFileName(data.fileName || 'Simulation');
          setSimHtml(data.html);
          showNotification("✅ Content loaded");
        }
      }
    } catch {
      // Silently fail — socket path may still deliver
    }
  }, [roomId, currentHtml, socket, connected]);

  useEffect(() => {
    // AUTONOMOUS: Aggressive retry ladder for stuck students.
    //
    // When a student joins and the server has no HTML yet (post-redeploy,
    // teacher's iframe slow to respond, etc), they sit on "Waiting for
    // teacher" with no recovery. The previous code tried ONE HTTP
    // fallback at 2s; if that returned 204 (server had nothing yet) the
    // student stayed stuck forever.
    //
    // Now: retry at 2s, 5s, 10s, 20s. Each attempt re-emits
    // request_content via socket (which makes the server re-ping the
    // teacher) AND tries the HTTP endpoint. As soon as currentHtml is
    // set, the effect tears down. Total max wait: 20s, then user can
    // click the Retry Loading button manually.
    if (!connected || currentHtml) return;
    const retries = [2000, 5000, 10000, 20000];
    const timers = retries.map(ms => setTimeout(() => {
      // Re-check currentHtml inside the callback in case a prior attempt
      // landed during the wait.
      fetchContentViaHttp();
    }, ms));
    return () => { timers.forEach(t => clearTimeout(t)); };
  }, [connected, currentHtml, fetchContentViaHttp]);

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
    // Flush pending messages
    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    for (const msg of pending) {
      iframeRef.current?.contentWindow?.postMessage(msg, '*');
    }
    // ALWAYS re-push SET_INTERACTION_MODE on every iframe load. allowed=canInteract
    // means the student's pointer reaches the sim whenever interactive mode is on
    // (or they hold control) — so in a 1-to-1 lesson they can actually click the
    // buttons. In view-only it stays false and the mirror overlay blocks taps.
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_INTERACTION_MODE', allowed: canInteractRef.current }, '*');
    // LIVE MIRROR: mirror the same drive gate onto the follower agent.
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_MIRROR_INTERACT', allowed: canInteractRef.current }, '*');
    // ...and the scroll lock, so a reloading student is locked from frame one
    // instead of being briefly free to scroll away.
    //
    // Read from scrollLockedRef rather than recomputing the rule here. This
    // line used to carry its own copy — `scrollSyncEnabled && !canInteractRef
    // .current` — and a duplicated rule is how the original bug survived: the
    // effect below was corrected while this one, which fires on EVERY iframe
    // load, kept re-pushing the old answer and quietly undid it at the start of
    // every lesson. One rule, one place: see scrollPolicy.ts.
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_MIRROR_SCROLLLOCK', locked: scrollLockedRef.current }, '*');
    // Re-send current state
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled }, '*');
    if (currentStep < 999) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'SET_STEP', step: currentStep }, '*');
    }
    if (zoomLevel !== 1) {
      // Use REMOTE_ZOOM on student side so it applies silently without echoing back
      iframeRef.current?.contentWindow?.postMessage({ type: 'REMOTE_ZOOM', zoom: zoomLevel }, '*');
    }
  }, [scrollSyncEnabled, currentStep, zoomLevel]);

  // Re-push zoom when level changes
  useEffect(() => {
    postToIframe({ type: 'REMOTE_ZOOM', zoom: zoomLevel });
  }, [zoomLevel, postToIframe]);

  // ── Relay iframe messages ──
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!socket) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const type = e.data?.type;
      if (!type) return;

      // ── LIVE MIRROR (follower → source) ──
      // Forward this follower's input to the teacher's authoritative lesson, and
      // announce readiness so we pull a fresh snapshot (late-join / reconnect /
      // lesson switch). MUST be handled BEFORE the SYNC_ relay below —
      // 'SYNC_MIRROR_INPUT' starts with 'SYNC_' but is mirror input, not a
      // journaled interaction. The server re-checks drive eligibility.
      if (type === 'SYNC_MIRROR_INPUT') {
        socket.emit('mirror_input', {
          roomId,
          input: {
            kind: e.data.kind, path: e.data.path, value: e.data.value,
            deltaY: e.data.deltaY, key: e.data.key,
            // Scroll position must ride along too — without these a driving
            // student's scroll reached the teacher with no coordinates, so the
            // teacher's view never moved with them.
            scrollX: e.data.scrollX, scrollY: e.data.scrollY,
          },
        });
        return;
      }
      // The follower detected its screen no longer matches the teacher's
      // fingerprint (a frame was lost in transit) — pull a fresh full snapshot.
      // Rate-limited follower-side (two consecutive mismatches, ~4s).
      if (type === 'MIRROR_STALE') { socket.emit('mirror_request', { roomId }); return; }
      if (type === 'MIRROR_FOLLOWER_READY') {
        socket.emit('mirror_request', { roomId });
        // Tell the follower its permissions IMMEDIATELY on announce. The mirror
        // now boots scroll-LOCKED and waits for this; previously the lock only
        // arrived via an effect, leaving a gap at the very start of a lesson
        // where a view-only student could still scroll away.
        iframeRef.current?.contentWindow?.postMessage({ type: 'SET_MIRROR_INTERACT', allowed: canInteractRef.current }, '*');
        iframeRef.current?.contentWindow?.postMessage({ type: 'SET_MIRROR_SCROLLLOCK', locked: scrollLockedRef.current }, '*');
        return;
      }

      // Student → teacher absolute-state snapshot response: forward the
      // student's REAL DOM up so the teacher's view tracks the student's
      // actual state (self-heals quiz/sim drift). Triggered by the debounced
      // REQUEST_HTML below, tagged with an 'sstate-' requestId.
      if (type === 'SYNC_PROVIDE_HTML') {
        const rid = e.data.requestId;
        if (typeof rid === 'string' && rid.indexOf('peek-') === 0 && e.data.html) {
          // Teacher is peeking at this student's real screen — answer it.
          socket.emit('student_snapshot', { roomId, html: e.data.html, requestId: rid });
        } else if (typeof rid === 'string' && rid.indexOf('sstate-') === 0 && e.data.html) {
          socket.emit('student_state', { roomId, html: e.data.html });
        }
        return;
      }
      if (type === 'STEP_INFO') return;

      // Lesson-load diagnostics (CDN script blocked, WebGL failure, JS crash):
      // relay to the TEACHER via a dedicated event. Deliberately BEFORE the
      // canInteract gate — a view-only student's broken sim must still report —
      // and never through the 'interaction' path (it must not be replayed into
      // anyone's iframe as a REMOTE_* event).
      if (type === 'SYNC_SIM_ERROR') {
        socket.emit('sim_error', { roomId, message: e.data.message, source: e.data.source });
        return;
      }

      // Internal self-heal signal from THIS iframe (a replayed teacher click
      // couldn't find its target). It is NOT a real interaction — drop it so it
      // never gets emitted to the server and replayed into the room. (The
      // teacher-follows-student direction, where drift actually bites, self-heals
      // on the teacher side in Room.tsx. Requesting the current content is a
      // harmless nudge that re-delivers the journal.)
      if (type === 'SYNC_REPLAY_MISS') {
        const now = Date.now();
        if (now - lastStudentMissAtRef.current > 4000) {
          lastStudentMissAtRef.current = now;
          socket.emit('request_content', { roomId });
        }
        return;
      }

      if (!type.startsWith('SYNC_')) return;
      // Always allow cursor (teacher can see where students look) and pings
      // (Alt+click "look here" — anyone can point at confusion, even view-only).
      if (type === 'SYNC_CURSOR' || type === 'SYNC_PING') {
        socket.emit("interaction", {
          roomId,
          event: {
            ...e.data,
            syncEpoch: syncEpochRef.current,
            clientTs: Date.now(),
          },
        });
        return;
      }
      // Emit the student's interactions whenever they may interact (interactive
      // mode OR they hold control). The SERVER decides routing: a control-holder
      // drives the whole room; an interactive student's events are relayed to the
      // TEACHER ONLY, so the teacher SEES what the student does (bidirectional
      // sync) without driving other students. View-only students never reach here.
      if (!canInteractRef.current) return;
      if (type === 'SYNC_SCROLL' && !scrollSyncEnabled) return;
      socket.emit("interaction", {
        roomId,
        event: {
          ...e.data,
          syncEpoch: syncEpochRef.current,
          clientTs: Date.now(),
        },
      });

      // After a discrete interaction (not cursor/scroll/drag-move), debounce a
      // DOM snapshot of the student's own iframe up to the teacher. This is the
      // self-healing absolute-state channel: even if a replayed click was
      // dropped or mis-targeted, the teacher's view snaps to the student's TRUE
      // current state (e.g. the right quiz question).
      // Typing (SYNC_INPUT/SYNC_CHANGE) is synced field-by-field via
      // REMOTE_INPUT, which doesn't disturb the teacher's DOM — so it must NOT
      // trigger a full-DOM snapshot (that was wiping the teacher's focused
      // field). Snapshot only on discrete navigation (clicks, pointer, keys),
      // debounced so a burst collapses to one.
      if (type !== 'SYNC_SCROLL' && type !== 'SYNC_MOUSEMOVE' && type !== 'SYNC_INPUT' && type !== 'SYNC_CHANGE' && type !== 'SYNC_WHEEL') {
        if (studentSnapTimerRef.current) clearTimeout(studentSnapTimerRef.current);
        studentSnapTimerRef.current = setTimeout(() => {
          postToIframe({ type: 'REQUEST_HTML', requestId: 'sstate-' + Date.now() });
        }, 400);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [socket, roomId, scrollSyncEnabled, interactionAllowed, postToIframe]);

  useEffect(() => {
    syncEpochRef.current += 1;
    // Reset iframe readiness when content source changes — the new iframe needs to fire onLoad
    iframeReadyRef.current = false;
  }, [lessonUrl, showTempContent, whiteboardMode]);


  // ── Push interaction mode to iframe ──
  // allowed=canInteract: the student's pointer reaches the sim whenever the
  // teacher has enabled interactive mode (or granted control), so they can click
  // buttons / answer the quiz. In view-only it's false and the mirror overlay
  // blocks taps. Scroll works regardless (overlay forwards it; no scroll lock).
  useEffect(() => {
    postToIframe({ type: 'SET_INTERACTION_MODE', allowed: canInteract });
    // LIVE MIRROR: same gate controls whether the follower may forward its input
    // to the teacher's authoritative lesson (drive) or is a pure view-only mirror.
    postToIframe({ type: 'SET_MIRROR_INTERACT', allowed: canInteract });
  }, [canInteract, lessonUrl, postToIframe]);

  // ── Scroll lock ──
  // Who may scroll is a question about PERMISSION, so it depends only on
  // permission. A student who may not drive the lesson may not scroll it
  // either; grant them interaction and they can, because now they are driving.
  //
  // This used to also depend on scrollSyncEnabled — the "Linked" toggle:
  //
  //     const scrollLocked = scrollSyncEnabled && !canInteract;
  //
  // which conflated two unrelated ideas and produced three separate faults the
  // tutor hit in one lesson:
  //
  //   * With Linked OFF, a view-only student was unlocked and scrolled away
  //     mid-explanation — the exact thing the lock exists to prevent.
  //   * Revoking interaction did not reliably re-lock them, because whether it
  //     re-locked depended on a toggle that has nothing to do with permission.
  //   * A driving student's scroll never reached the teacher. The follower's
  //     scroll listener bails out early while scrollLocked is true, so the
  //     student→teacher scroll channel — which is fully implemented, all the
  //     way to window.scrollTo on the teacher's own lesson — was being
  //     suppressed before it could send anything.
  //
  // "Linked" keeps its own, narrower meaning: whether the TEACHER's scrolling
  // is pushed out to the students. That is the toggle's name and the only
  // behaviour it should govern.
  const scrollLocked = !canInteract;
  const scrollLockedRef = useRef(scrollLocked);
  useEffect(() => { scrollLockedRef.current = scrollLocked; }, [scrollLocked]);
  useEffect(() => {
    postToIframe({ type: 'SET_MIRROR_SCROLLLOCK', locked: scrollLocked });
  }, [scrollLocked, lessonUrl, postToIframe]);

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
  }, [scrollSyncEnabled, lessonUrl, postToIframe]);

  // ── Step sync to iframe ──
  useEffect(() => {
    if (currentStep < 999) {
      postToIframe({ type: 'SET_STEP', step: currentStep });
    }
  }, [currentStep, lessonUrl, postToIframe]);

  // ── Handlers ──
  const submitQuizAnswer = () => {
    if (!socket || !quizAnswer.trim()) return;
    socket.emit("quiz_answer", { roomId, answer: quizAnswer.trim(), studentName });
    setQuizSubmitted(true);
    sounds.success();
  };

  // Multiple-choice path: tapping a choice submits it directly.
  const submitQuizChoice = (choice: string) => {
    if (!socket) return;
    socket.emit("quiz_answer", { roomId, answer: choice, studentName });
    setQuizAnswer(choice);
    setQuizSubmitted(true);
    sounds.success();
  };

  const toggleChat = () => {
    setChatOpen(!chatOpen);
    if (!chatOpen) setUnreadChat(0);
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-primary)' }}>

      {teacherScreen && (
        <TeacherScreenView stream={teacherScreen} teacherName={teacherScreenName} />
      )}
      {shareAsk && (
        <ScreenSharePrompt teacherName={shareAsk} onShare={beginShare} onDecline={declineShare} />
      )}
      {sharing && (
        // Always visible while capturing. A student must never be in any doubt
        // that their screen is being watched, and stopping is one tap away.
        <div style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 60,
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(220,38,38,0.95)', color: '#fff',
          borderRadius: 999, padding: '8px 14px', boxShadow: 'var(--shadow-lg)',
          fontSize: 13, fontWeight: 600,
        }}>
          <span>🖥️ You're sharing your screen</span>
          <button onClick={() => endShare(true)} style={{
            background: 'rgba(255,255,255,0.2)', color: '#fff', border: 'none',
            borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>Stop</button>
        </div>
      )}

      {/* ══════ HEADER ══════ */}
      <header className="app-header">
        <div className="header-section">
          <span className="font-display font-extrabold text-[15px]" style={{ color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
            Maths<span style={{ color: 'var(--accent-indigo)' }}>Live</span>
          </span>

          <div className="header-divider hdr-hide-sm" />

          {/* File name is context, not a control — first to go on phones. */}
          <span className="text-[13px] font-semibold truncate hdr-hide-sm" style={{ color: 'var(--text-secondary)', maxWidth: 180 }}>
            {currentFileName || 'Session'}
          </span>

          <div className="header-divider" />

          {/* Level / XP pill */}
          <button
            className="flex items-center gap-2 px-2.5 py-1 rounded-full transition-all"
            data-tip="View leaderboard"
            onClick={() => setShowLeaderboard(true)}
            style={{
              background: 'rgba(79,70,229,0.10)',
              border: '1px solid rgba(79,70,229,0.22)',
              cursor: 'pointer',
              position: 'relative',
            }}
            onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-1px)')}
            onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
          >
            <span style={{ fontSize: 11, fontWeight: 800, color: '#6366F1', letterSpacing: 0.5 }}>
              LVL {myLevel}
            </span>
            <div style={{ width: 40, height: 4, borderRadius: 2, background: 'rgba(99,102,241,0.15)', overflow: 'hidden' }}>
              <div style={{
                width: `${myXp % 100}%`,
                height: '100%',
                background: '#4F46E5',
                transition: 'width 0.5s cubic-bezier(.34,1.56,.64,1)',
              }} />
            </div>
            <span style={{ fontSize: 11, fontWeight: 800, color: '#6366F1', fontVariantNumeric: 'tabular-nums' }}>
              {myXp} XP
            </span>
            {myStreak >= 2 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: '#F59E0B', marginLeft: 2 }}>
                🔥{myStreak}
              </span>
            )}
            {/* Floating +XP animation */}
            {xpFloater && (
              <span
                key={xpFloater.id}
                style={{
                  position: 'absolute',
                  top: -10, right: 8,
                  fontSize: 13,
                  fontWeight: 800,
                  color: '#10B981',
                  pointerEvents: 'none',
                  animation: 'xpFloat 1.8s cubic-bezier(.34,1.56,.64,1) forwards',
                  textShadow: '0 1px 2px rgba(255,255,255,0.9)',
                }}
              >
                +{xpFloater.amount}
              </span>
            )}
          </button>

          <div className="header-divider" />

          {/* Connection health (dot + RTT + reconnect toast) */}
          <ConnectionStatus socket={socket} connected={connected} />

          {/* Control / View-only / Interactive indicator */}
          {hasControl ? (
            <span className="status-pill" style={{
              background: 'rgba(244,63,94,0.14)', color: '#E11D48',
              fontSize: '11px', fontWeight: 800, letterSpacing: '0.03em', padding: '3px 10px',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              boxShadow: '0 0 0 1px rgba(244,63,94,0.35)', animation: 'pulse 2s ease-in-out infinite',
            }}>
              ✋ YOU HAVE CONTROL
            </span>
          ) : (
            <span className="status-pill" style={{
              background: 'var(--accent-indigo-light)',
              color: 'var(--accent-indigo)',
              fontSize: '11px', fontWeight: 700, letterSpacing: '0.03em', padding: '3px 10px',
            }}>
              {controlHolderName ? `🎯 ${controlHolderName} DRIVING` : (interactionAllowed ? 'INTERACTIVE' : 'FOLLOWING TEACHER')}
            </span>
          )}

          <div className="header-divider" />

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
      {/* Waiting room. NOT an error: the student's link is fine, the teacher
          simply is not in yet, and this clears itself. */}
      {waitingForRoom && !joinError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)' }}>
          <div className="w-full max-w-sm animate-bounce-in text-center"
            style={{ background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)', padding: '32px 24px' }}>
            <div className="text-4xl mb-4">⏳</div>
            <h3 className="font-display text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              Waiting for your teacher
            </h3>
            <p className="text-sm" style={{ color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              You&rsquo;re in the right place — the lesson starts by itself the moment they open the room.
              Keep this page open.
            </p>
            <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
              Checking every few seconds{joinAttempts > 0 ? ` · ${joinAttempts} ${joinAttempts === 1 ? 'try' : 'tries'}` : ''}
            </p>
          </div>
        </div>
      )}

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
        <div className="flex-1 relative overflow-hidden m-3 rounded-xl" style={{ background: '#ffffff', border: '1px solid var(--border-subtle)' }}>
          {/* AUTONOMOUS: [ORDER-1 CRITICAL] - Same fix as Room.tsx: keep
              Whiteboard mounted across surface toggles so the student
              doesn't lose their drawing state when the teacher flips back
              to HTML and forth again. */}
          <Whiteboard
            ref={whiteboardRef}
            socket={socket}
            roomId={roomId!}
            isTeacher={false}
            interactive={interactionAllowed}
            zoomLevel={zoomLevel}
            scrollX={whiteboardScrollX}
            scrollY={whiteboardScrollY}
            isActive={whiteboardMode && !showTempContent}
            initialState={whiteboardState}
            whiteboardSyncEnabled={whiteboardSyncEnabled}
          />
          {/* Whiteboard mutual-sync toggle (matches the teacher's). */}
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
                  Teacher is on independent view
                </div>
              )}
            </div>
          )}

          {showTempContent && tempContent && tempContentDoc ? (
            // Temporary explanation content overlay — uses same ref so scroll sync works
            <iframe
              ref={iframeRef}
              srcDoc={tempContentDoc}
              className="w-full h-full border-none"
              style={{ background: '#ffffff' }}
              onLoad={handleIframeLoad}
              sandbox={LESSON_IFRAME_SANDBOX}
              allow={LESSON_IFRAME_ALLOW}
              allowFullScreen
            />
          ) : whiteboardMode ? (
            // Whiteboard rendered above (always mounted; isActive controls visibility)
            null
          ) : lessonUrl ? (
            <>
              <iframe
                ref={iframeRef}
                src={lessonUrl}
                className="w-full h-full border-none"
                style={{ background: '#ffffff' }}
                onLoad={handleIframeLoad}
                sandbox={LESSON_IFRAME_SANDBOX}
                allow={LESSON_IFRAME_ALLOW}
                allowFullScreen
              />
              {/* Say so instead of showing a white rectangle. The shell has the
                  lesson's scripts stripped, so anything the lesson would have
                  drawn in JS isn't there until the teacher's first frame lands. */}
              {MIRROR_MODE && !mirrorPainted && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none"
                  style={{ background: '#ffffff', color: 'var(--text-secondary)' }}>
                  <div className="text-2xl" aria-hidden="true">⏳</div>
                  <div className="text-sm font-medium">Loading your teacher's screen…</div>
                  <div className="text-xs" style={{ maxWidth: 300, textAlign: 'center', lineHeight: 1.5 }}>
                    If this stays here, ask your teacher to press <strong>Force sync</strong>.
                  </div>
                </div>
              )}
              {/* Mirror overlay - shown ONLY in view-only (not interactive, not
                  control). It BLOCKS clicks/taps so a view-only student purely
                  mirrors the teacher, but FORWARDS wheel/touch so they can still
                  scroll their own view. Alt+click still pings "look here". In
                  interactive mode this is absent, so the student's pointer
                  reaches the sim and they can click buttons. */}
              {!canInteract && (
                <div
                  className="absolute inset-0"
                  style={{ pointerEvents: 'auto', zIndex: 1, cursor: 'crosshair', touchAction: 'none' }}
                  onWheel={(e) => {
                    // Forward the scroll to the lesson iframe instead of blocking it.
                    const win = iframeRef.current?.contentWindow;
                    if (win) win.scrollBy(e.deltaX, e.deltaY);
                  }}
                  onTouchStart={(e) => { overlayTouchYRef.current = e.touches[0]?.clientY ?? 0; }}
                  onTouchMove={(e) => {
                    const y = e.touches[0]?.clientY ?? 0;
                    const win = iframeRef.current?.contentWindow;
                    if (win) win.scrollBy(0, overlayTouchYRef.current - y);
                    overlayTouchYRef.current = y;
                  }}
                  onMouseDown={(e) => { if (!e.altKey) e.preventDefault(); }}
                  onPointerDown={(e) => {
                    // Tapping a locked lesson used to do NOTHING — no button
                    // moved, no message, nothing. The student assumes it's
                    // broken and the teacher never learns they forgot to
                    // unlock. Now the tap says so, and offers to ask.
                    if (e.altKey) return;
                    setLockedNudge(true);
                  }}
                  onClick={(e) => {
                    // The overlay swallows clicks to the sim, but a student can
                    // still Alt+click to ping "look here" - show it locally and
                    // relay it to the room.
                    if (!e.altKey || !socket) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const nx = (e.clientX - rect.left) / rect.width;
                    const ny = (e.clientY - rect.top) / rect.height;
                    postToIframe({ type: 'REMOTE_PING', clientX: nx, clientY: ny });
                    socket.emit('interaction', { roomId, event: { type: 'SYNC_PING', clientX: nx, clientY: ny } });
                  }}
                />
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full" style={{ background: 'var(--bg-primary)' }}>
              <div className="text-center animate-slide-up p-12 rounded-2xl"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-lg)' }}>
                <div className="text-5xl mb-5 animate-gentle-bounce">⏳</div>
                <h2 className="font-display text-2xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Waiting for teacher...</h2>
                <p className="text-sm" style={{ color: 'var(--text-muted)', lineHeight: '1.6' }}>
                  You're in! The lesson appears here the moment your teacher starts.
                </p>
                <div className="flex items-center justify-center gap-2 mt-4">
                  <span className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-md"
                    style={{ background: 'var(--accent-indigo-light)', color: 'var(--accent-indigo)', letterSpacing: '0.06em' }}>
                    ROOM {roomId}
                  </span>
                  <span className="text-[11px] font-semibold px-2.5 py-1 rounded-md inline-flex items-center gap-1.5"
                    style={{
                      background: connected ? 'var(--accent-emerald-light)' : 'rgba(244,63,94,0.10)',
                      color: connected ? 'var(--accent-emerald)' : '#E11D48',
                    }}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'currentColor' }} />
                    {connected ? 'Connected' : 'Reconnecting…'}
                  </span>
                </div>
                <div className="flex items-center justify-center gap-2 mt-6">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="w-2 h-2 rounded-full"
                      style={{ background: 'var(--accent-indigo)', animation: `dot-pulse 1.5s ease-in-out infinite`, animationDelay: `${i * 0.3}s` }} />
                  ))}
                </div>
                {connected && (
                  <button onClick={fetchContentViaHttp}
                    className="btn mt-6" style={{ fontSize: '13px' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                    </svg>
                    Retry Loading
                  </button>
                )}
              </div>
            </div>
          )}

          {/* AUTONOMOUS: Student annotation toolbar — small floating
              vertical strip on the left of the HTML area. Only shows
              when an HTML lesson is on-surface (not whiteboard, not
              temp-content) since whiteboard mode has its own rail and
              the temp-content overlay is meant to be a quick read.
              The toolbar lets the student opt in to drawing; until
              they activate a tool, taps still pass through to the
              simulation. */}
          {!whiteboardMode && !showTempContent && lessonUrl && canAnnotate && (
            <div
              role="toolbar"
              aria-label="Annotation tools"
              style={{
                position: 'absolute',
                left: 10,
                top: 10,
                zIndex: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                background: 'rgba(255,255,255,0.95)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                padding: 5,
                boxShadow: '0 4px 14px rgba(15,23,42,0.10)',
                backdropFilter: 'blur(6px)',
              }}
            >
              {/* Pointer / click (default) — taps go to the lesson so the
                  student can press its buttons. Picking this turns drawing off. */}
              <button
                onClick={() => { setStudentDrawMode(false); setStudentEraser('off'); }}
                aria-pressed={!studentDrawMode && studentEraser === 'off'}
                title="Pointer - click the lesson"
                style={{
                  width: 36, height: 36,
                  borderRadius: 8,
                  border: 'none',
                  background: (!studentDrawMode && studentEraser === 'off') ? 'var(--accent-indigo, #6366f1)' : 'transparent',
                  color: (!studentDrawMode && studentEraser === 'off') ? '#fff' : 'var(--text-primary)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.15s ease',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 3l6 18 2.5-7.5L21 11 5 3z" />
                </svg>
              </button>
              {/* Pen */}
              <button
                onClick={() => {
                  setStudentDrawMode(prev => !prev);
                  setStudentEraser('off');
                }}
                aria-pressed={studentDrawMode}
                title={studentDrawMode ? 'Stop drawing' : 'Draw on the lesson'}
                style={{
                  width: 36, height: 36,
                  borderRadius: 8,
                  border: 'none',
                  background: studentDrawMode ? studentPenColor : 'transparent',
                  color: studentDrawMode ? '#fff' : 'var(--text-primary)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.15s ease',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5L17 3z" />
                </svg>
              </button>
              {/* Eraser */}
              <button
                onClick={() => {
                  setStudentEraser(prev => prev === 'stroke' ? 'off' : 'stroke');
                  setStudentDrawMode(false);
                }}
                aria-pressed={studentEraser !== 'off'}
                title={studentEraser !== 'off' ? 'Stop erasing' : 'Erase strokes you drew'}
                style={{
                  width: 36, height: 36,
                  borderRadius: 8,
                  border: 'none',
                  background: studentEraser !== 'off' ? '#FBCFE8' : 'transparent',
                  color: studentEraser !== 'off' ? '#9D174D' : 'var(--text-primary)',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 21-4-4 11-11 4 4L7 21z" /><path d="M14 6l4-4 4 4-4 4" /><path d="M3 21h18" />
                </svg>
              </button>
              {/* Colour swatches — only when pen is active, to keep the
                  toolbar compact for the common "off" state. */}
              {studentDrawMode && (
                <>
                  <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 2px' }} />
                  {STUDENT_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setStudentPenColor(c)}
                      title={`Switch pen colour to ${c}`}
                      aria-label={`Pen colour ${c}`}
                      style={{
                        width: 26, height: 26,
                        borderRadius: '50%',
                        border: studentPenColor === c ? '2.5px solid #0F172A' : '1.5px solid rgba(15,23,42,0.15)',
                        background: c,
                        cursor: 'pointer',
                        margin: '2px auto',
                        padding: 0,
                      }}
                    />
                  ))}
                </>
              )}
            </div>
          )}

          {/* AUTONOMOUS: Annotation Layer is now student-writable.
              `interactive` becomes true while the student has a pen
              or eraser tool active, capturing pointer events on the
              overlay so they can scribble. When both are off, the
              layer falls back to view-only (just renders teacher
              strokes underneath, taps pass through to the iframe). */}
          <AnnotationLayer
            socket={socket} roomId={roomId!}
            drawMode={studentDrawMode}
            laserMode={false}
            penType="permanent"
            penColor={studentPenColor}
            penWidth={3}
            eraserMode={studentEraser}
            eraserWidth={22}
            iframeRef={iframeRef}
            interactive={canAnnotate && (studentDrawMode || studentEraser !== 'off')}
            laserPointer={laserPointer}
            initialAnnotations={annotations}
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
            isPaused={isPaused} visible={!!lessonUrl}
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

      {/* Face-to-face video. The student is the POLITE side: on a simultaneous
          call it yields to the teacher's offer rather than both stalling. */}
      <VideoCall socket={socket} roomId={roomId!} polite selfLabel="You" />

      {/* A clip the teacher is showing. It opens, plays, pauses and closes on
          their say-so — the student can only move it around and turn sound on. */}
      <VideoOverlay socket={socket} roomId={roomId!} isTeacher={false} />

      {/* While it is on, say so plainly and keep the off switch in reach. */}
      {narrationOn && (
        <button
          onClick={() => { narratorRef.current?.stop(); narratorRef.current = null; setNarrationOn(false); setNarrationChoice(roomId || '', 'no'); showNotification('🎙️ Stopped'); }}
          className="fixed bottom-3 left-3 z-[84] flex items-center gap-2 px-3 py-2 rounded-full text-xs font-semibold"
          style={{ background: '#7F1D1D', color: '#FEE2E2', boxShadow: 'var(--shadow-lg)' }}
          title="Stop writing down what is said">
          <span style={{ width: 8, height: 8, borderRadius: 999, background: '#F87171', display: 'inline-block' }} />
          Writing down what we say · Stop
        </button>
      )}

      {/* ── "It's locked" nudge ──
          A view-only tap used to be swallowed in silence, so the student sits
          there tapping a dead screen and the teacher never finds out they
          forgot to unlock. Now the tap explains itself and can ask for them.
          Disappears the moment interaction is actually allowed. */}
      {lockedNudge && !canInteract && (
        <div className="fixed inset-0 z-[85] flex items-end justify-center p-4 pb-24 sm:items-center sm:pb-4"
          style={{ background: 'rgba(0,0,0,0.28)' }}
          onClick={() => setLockedNudge(false)}>
          <div className="w-full max-w-sm animate-bounce-in" onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)', padding: 20 }}>
            <div className="text-3xl mb-2" aria-hidden="true">🔒</div>
            <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              You're watching, not driving
            </div>
            <div className="text-sm mt-1.5" style={{ color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              Your teacher hasn't handed over the controls yet, so tapping won't
              do anything. Want me to ask them?
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setLockedNudge(false)}
                className="flex-1 px-4 py-2.5 text-sm rounded-lg font-medium"
                style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                Not now
              </button>
              <button
                onClick={() => {
                  // Rate-limited so a bored student can't machine-gun the
                  // teacher's screen mid-explanation.
                  if (Date.now() - askedAt < 20000) { setLockedNudge(false); showNotification('✋ Already asked — hang on.'); return; }
                  socket?.emit('request_interaction', { roomId });
                  setAskedAt(Date.now());
                  setLockedNudge(false);
                  showNotification('✋ Asked your teacher to unlock it');
                }}
                className="flex-1 px-4 py-2.5 text-sm rounded-lg font-medium text-white"
                style={{ background: 'var(--accent-indigo)' }}>
                Ask my teacher
              </button>
            </div>
          </div>
        </div>
      )}

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
                quizModal.options ? (
                  <>
                    {/* Multiple choice — one tap answers. */}
                    <div className="flex flex-col gap-2 mb-4">
                      {quizModal.options.map((opt, i) => (
                        <button key={i} onClick={() => submitQuizChoice(opt)}
                          className="btn-secondary w-full text-left"
                          style={{ justifyContent: 'flex-start', padding: '12px 16px', fontSize: 15 }}>
                          <span style={{ fontWeight: 800, color: 'var(--accent-indigo)', marginRight: 10 }}>
                            {String.fromCharCode(65 + i)}
                          </span>
                          {opt}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setQuizModal(null)} className="btn-secondary w-full">Skip</button>
                  </>
                ) : (
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
                )
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

      {/* ══════ ATTENTION CHECK MODAL ══════ */}
      {attentionCheckModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)' }}>
          <div className="w-full max-w-sm animate-bounce-in text-center"
            style={{ background: 'var(--bg-card)', borderRadius: '12px', border: '2px solid #5B5FE6', boxShadow: '0 8px 32px rgba(91,95,230,0.25)', padding: '32px 24px' }}>
            <div className="text-5xl mb-4" style={{ animation: 'gentle-bounce 1s ease-in-out infinite' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#5B5FE6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto' }}>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
              </svg>
            </div>
            <h3 className="font-display text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              Attention Check
            </h3>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
              Your teacher wants to confirm you're here.
            </p>
            <button
              onClick={() => {
                setAttentionCheckModal(false);
                if (attentionTimeoutRef.current) clearTimeout(attentionTimeoutRef.current);
                if (socket) socket.emit('attention_ack', { roomId, studentName });
              }}
              className="btn-primary w-full justify-center"
              style={{ height: '44px', fontSize: '15px', borderRadius: '8px' }}>
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
              background: '#4F46E5',
              color: '#fff',
              boxShadow: '0 24px 60px -16px rgba(17,20,28,0.40), 0 0 0 1px rgba(255,255,255,0.12) inset',
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
