import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { mirrorScriptFor, stripLessonScripts } from "../lib/mirrorScript";
import { checkLesson, type LessonIssue } from "../lib/lessonCheck";
import { stepLockScript } from "../lib/stepLockScript";
import { DEMO_LESSON_HTML, DEMO_LESSON_NAME } from "../lib/demoLesson";
import { cleanDisplayName } from "../lib/displayName";
import { sessionRecorder } from "../lib/sessionRecorder";
import { sounds } from "../lib/sounds";
import { savedBoards, templates } from "../lib/prefs";
import { LESSON_IFRAME_SANDBOX, LESSON_IFRAME_SANDBOX_VIEW_ONLY, LESSON_IFRAME_ALLOW } from "../lib/iframeAttrs";
import RoomStatusStrip from "../components/RoomStatusStrip";

// ── Components ──
import TeacherControls from "../components/TeacherControls";
import ChatPanel from "../components/ChatPanel";
import VideoCall from "../components/VideoCall";
import VideoOverlay from "../components/VideoOverlay";
import { ClassPack, type HomeworkItem } from "../lib/classPack";
import { savePack, loadPack, packKey, prunePacks } from "../lib/packStore";
import { captureLesson, shrinkImage } from "../lib/lessonShot";
import { buildPackJson, buildPackArchive, slugId, type RawSnapshot } from "../lib/packExport";
import { newStrokesSince, strokeBounds, boardRectToScreen, padRect, cropCanvas } from "../lib/inkDelta";
import { outlineExplainer, explainerTitle } from "../lib/explainerOutline";
import { closestQuestionBlock, optionIndexOf, readCorrectness, summariseInteractives, withUnattempted, type RecordedAttempt } from "../lib/interactives";
import type { PackEvent, PackSurface, PackExplainerOutline, PackInteractive } from "../lib/packSchema";
import SessionPrompt from '../components/SessionPrompt';
import { Narrator, narrationSupported, getNarrationChoice, setNarrationChoice } from "../lib/narration";
import { clientId } from '../lib/clientId';
import { localTimezone } from "../lib/tz";
import { socketAuth, isPasscodeError, refusePasscode } from "../lib/passcode";
import { getClassByRoomCode } from "../lib/classes";
import { ScreenPeer, shareFailureMessage, screenShareSupported, displayCaptureOptions, type ShareStatus } from "../lib/screenShare";
import ScreenShareViewer from "../components/ScreenShareViewer";
import { parseGoals } from "../lib/studentProfile";
import LessonSwitcher from "../components/LessonSwitcher";
import { boardHasContent } from "../lib/lessonNav";
import { shouldReseedBoard, boardPieceCount } from "../lib/boardRecovery";
import { TeachingClock, isTeaching } from "../lib/teachingTime";
import type { ClassRow } from "../lib/classes";
import type { SessionRow } from "../lib/sessions";
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
import { PRODUCT, subjectFor } from '../lib/product';

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
  tz?: string;
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
  // Class ownership used to be proved by reading an auth token out of storage
  // and sending it on join_room. The session is an HttpOnly cookie now: the
  // browser attaches it to the socket handshake by itself, and script cannot
  // read it even to try. The server verifies that cookie directly, so there is
  // nothing left for this component to carry.
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
  // What each student's screen actually holds, keyed by socket id. Fed by the
  // follower's ack on every ping — the only way a one-directional mirror can
  // tell a frozen student from a perfectly synced one.
  const [syncStatus, setSyncStatus] = useState<Record<string, { ok: boolean; at: number }>>({});
  // Is this tab in the background while a class is watching it?
  const [tabHidden, setTabHidden] = useState(false);
  // Does the current lesson implement the state contract? Drives the honest
  // warning below — a lesson that cannot say where it is really does restart
  // the class on reload, and the tutor should know that before it happens.
  const [lessonResumable, setLessonResumable] = useState<boolean | null>(null);
  // The position the room last knew about, waiting to be handed back to a
  // freshly-loaded lesson. Consumed once, then cleared.
  const pendingLessonStateRef = useRef<string | null>(null);
  // Re-render on a timer so "4s behind" keeps counting up rather than freezing
  // at whatever it said when the last ack landed. A stopped clock reading
  // "in sync" is worse than no clock at all.
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStatusTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // A backgrounded tab cannot stream.
  //
  // Chrome throttles timers in a hidden tab to once a second, and after five
  // minutes hidden to once a MINUTE. The mirror's DOM snapshots and its 120ms
  // canvas tick are both timer-driven, so putting MathsLive behind Zoom — or
  // behind the second browser opened to check on the student — quietly drops
  // the class to roughly one frame a minute. Nothing in the browser announces
  // this and nothing in the app noticed, so it read as "the lesson froze".
  //
  // The tutor cannot be expected to know that. Say it.
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  // Server rejected this teacher join (ownership enforcement, or another
  // teacher already seated). Surfaces a blocking banner instead of failing
  // silently.
  const [joinErrorMsg, setJoinErrorMsg] = useState<string | null>(null);
  // Saving the current board to this student's history (Stage 4).
  const [savingHistory, setSavingHistory] = useState(false);
  // ── Did the lesson actually reach the server? ──
  //
  // The autosave has run every two minutes for months and said nothing either
  // way, so a tutor whose save was failing — an expired session, a body the
  // server refused, a dropped connection — found out by opening the student's
  // history a week later and seeing nothing there. A save is not a save until
  // something says so, out loud, with the time on it.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
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
  // The last board we KNOW had content. Deliberately not derived from
  // whiteboardState, because that is overwritten by whatever the server sends —
  // including the empty room a restarted server hands back, which is precisely
  // the moment we need the old contents.
  const lastGoodBoardRef = useRef<any>(null);
  // Armed on reconnect, disarmed after one restore, so several state messages
  // arriving around one reconnect cannot stack duplicates.
  const boardReseedPendingRef = useRef(false);
  // Set below, once the socket exists. Held in a ref because the decision is
  // made inside applySessionState, which runs before that closure is built.
  const reseedBoardRef = useRef<((board: any) => void) | null>(null);
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
  // Explanations are KEPT, not thrown away on close. This is the tab strip's
  // list (names only) plus which one is on screen.
  const [explanations, setExplanations] = useState<Array<{ id: string; name: string }>>([]);
  const [activeExplanationId, setActiveExplanationId] = useState<string | null>(null);
  const tempFileInputRef = useRef<HTMLInputElement>(null);

  // Memoize blob URL to prevent iframe from reloading on every render
  const tempContentUrl = useMemo(() => {
    if (!tempContent) return null;
    // The SAME script trio the main lesson gets, and the mirror source is the
    // part that matters. Without it an explanation was never mirrored at all:
    // the teacher ran one copy, every student ran their own, and the classic
    // replay engine was the only thing holding them together. A stateful
    // explainer — a six-question ladder, a stepper, anything remembering where
    // it is — diverged the moment anyone touched it or joined late. Measured on
    // a six-question quiz opened as an explanation: teacher on Q3, one student
    // on Q1, another on Q4, all in the same class at the same moment.
    //
    // Only one lesson iframe is mounted at a time (this one replaces the
    // lesson's while it is showing), so there is exactly one source streaming
    // and no crosstalk between the two.
    // The mirror, and the step lock. That is the whole engine now.
    //
    // seededSyncScript used to be here too — the input-replay engine, which
    // re-derived the lesson's state on every screen by re-running clicks. It has
    // not driven a student since the mirror landed, but it stayed loaded in this
    // iframe and kept its reach: it journaled every click, snapshotted the whole
    // document on a timer, and cancelled input at capture phase whenever the
    // iframe was in a blocked state — which is what made a student's forwarded
    // taps vanish the moment they were given control.
    //
    // Everything it still genuinely provided — the cursor, the "look here" ping,
    // lesson-load errors, an on-demand document snapshot, follow-click — now
    // comes from the mirror source itself, where it belongs. One engine.
    const scripts = stepLockScript + mirrorScriptFor('source');
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

  // A student tapped a locked lesson and asked to be let in.
  const [interactionAsk, setInteractionAsk] = useState<{ studentName: string; at: number } | null>(null);

  // ── Class pack ──
  // Collects the lesson as it happens — board snapshots, every lesson page and
  // explainer, and a timeline — so it can be handed to a language model as one
  // file afterwards. Lives in a ref: it must survive every re-render and must
  // never itself cause one.
  const packRef = useRef<ClassPack>(new ClassPack());
  const [packCounts, setPackCounts] = useState({ snapshots: 0, artifacts: 0, moments: 0 });
  const [packBusy, setPackBusy] = useState(false);
  // Everything the JSON sidecar needs that isn't already in ClassPack.
  const packEventsRef = useRef<PackEvent[]>([]);
  const participantTzRef = useRef<Record<string, string>>({});
  // The student's record from the dashboard — their class, level, what they're
  // working towards, the book they follow. Fetched once, best effort: an
  // ad-hoc room with no student record, a signed-out tutor, an un-migrated
  // database or an offline Supabase all leave this null and the lesson runs
  // exactly as before. It only ever adds context to the class pack.
  const classRowRef = useRef<{ grade: string | null; level: string | null; goals: string[]; textbook: string | null } | null>(null);
  // Switching students and lesson days without leaving the room.
  const [myClasses, setMyClasses] = useState<ClassRow[]>([]);
  const [mySessions, setMySessions] = useState<SessionRow[]>([]);
  const [classId, setClassId] = useState<string | null>(null);
  const [classStudent, setClassStudent] = useState<string>('');
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const packSurfacesRef = useRef<PackSurface[]>([{ id: 'wb_1', type: 'whiteboard', title: null }]);
  const packOutlinesRef = useRef<PackExplainerOutline[]>([]);
  const packAttemptsRef = useRef<RecordedAttempt[]>([]);
  const packInteractivesRef = useRef<PackInteractive[]>([]);
  const seenStrokeIdsRef = useRef<Set<string>>(new Set());
  const currentSurfaceRef = useRef<string>('wb_1');
  // A student's click is REPLAYED inside this iframe, so the DOM event cannot
  // say who made it. This does: a forwarded input that just landed means the
  // next interaction belongs to the student.
  const lastForwardedInputRef = useRef(0);
  // Bumped on every iframe load so the capture listeners re-attach to the
  // document that is actually on screen.
  const [iframeDocNonce, setIframeDocNonce] = useState(0);
  const [showHomework, setShowHomework] = useState(false);
  const [homeworkItems, setHomeworkItems] = useState<HomeworkItem[]>([]);
  const homeworkInputRef = useRef<HTMLInputElement>(null);
  const homeworkKindRef = useRef<HomeworkItem['kind']>('submission');
  const [intentBefore, setIntentBefore] = useState('');
  const [noteAfter, setNoteAfter] = useState('');
  // 1.1: ask for the two things only the tutor knows, at the moment each is
  // cheapest to answer. 'before' appears once the room settles; 'after' stands
  // between the export button and the export.
  const [prompt, setPrompt] = useState<'before' | 'after' | null>(null);
  const [askedBefore, setAskedBefore] = useState(false);
  // Narration: transcribe what's said, on both sides, into the pack's timeline.
  // OFF until switched on — it is a recording of a child's voice being turned
  // into text, so it is never silent or implicit.
  const [narrationOn, setNarrationOn] = useState(false);
  const narratorRef = useRef<Narrator | null>(null);

  // ── Shared YouTube clip (floats over whatever is on screen) ──
  const [videoPromptOpen, setVideoPromptOpen] = useState(false);
  const [videoActive, setVideoActive] = useState(false);

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

  // Dual View: a real follower, built exactly as a student's is.
  //
  // It used to load the full lesson — scripts and all, plus a second mirror
  // source — and be fed the legacy engine's replays. That is the OLD engine: the
  // one that drifts. So the pane labelled "Student Mirror (live)" was showing
  // the teacher a second, independently-drifting copy and calling it what
  // students see. Its frames were correctly refused by the relay, so it never
  // harmed the class; it only ever misled the tutor.
  //
  // Now it is a script-stripped shell painted from the teacher's own stream. It
  // cannot show anything students are not seeing, because it is the same thing
  // students are — by construction, not by agreement.
  const mirrorFollowerUrl = useMemo(() => {
    if (!dualView || !previewHtml) return null;
    const content = stripLessonScripts(previewHtml).includes('<head>')
      ? stripLessonScripts(previewHtml).replace('<head>', '<head>' + mirrorScriptFor('follower'))
      : mirrorScriptFor('follower') + stripLessonScripts(previewHtml);
    return URL.createObjectURL(new Blob([content], { type: 'text/html' }));
  }, [dualView, previewHtml]);
  useEffect(() => () => { if (mirrorFollowerUrl) URL.revokeObjectURL(mirrorFollowerUrl); }, [mirrorFollowerUrl]);

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

  // Live screen share from one student. Separate from Peek and from the video
  // call — its own peer connection, so none of the three can disturb another.
  // Live member list for handlers that must not re-subscribe on every change.
  const usersRef = useRef<UserInfo[]>([]);
  // Counts only while a teacher and a student are BOTH here. Wall clock would
  // bill the setup before she arrives and the room left open after she goes.
  const teachingClockRef = useRef(new TeachingClock());
  const [screenShare, setScreenShare] = useState<{ id: string; name: string } | null>(null);
  const [screenStatus, setScreenStatus] = useState<ShareStatus>('idle');
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const screenPeerRef = useRef<ScreenPeer | null>(null);
  const screenShareRef = useRef<{ id: string; name: string } | null>(null);
  useEffect(() => { screenShareRef.current = screenShare; }, [screenShare]);

  // ── Sharing OUR screen to the class ──
  // One peer per student, not one shared connection: WebRTC is point to point,
  // and a room can hold more than one child. Kept in a ref because students
  // arrive and leave mid-share and the socket handlers must reach the live map.
  const [myScreenOn, setMyScreenOn] = useState(false);
  const myScreenStreamRef = useRef<MediaStream | null>(null);
  const myScreenPeersRef = useRef<Map<string, ScreenPeer>>(new Map());
  // The socket effect subscribes once; this is how it reaches the current
  // offer function without re-subscribing every render.
  const offerScreenToRef = useRef<((studentId: string) => void) | null>(null);
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
  // While recording, log each lesson change (HTML + seed) so the re-watch player
  // can swap to the right sim at the right moment. The recorder otherwise only
  // captures interactions/chat; this gives the replay something to render.
  useEffect(() => {
    if (isRecordingRef.current && previewHtml) {
      sessionRecorder.record('lesson', { html: previewHtml, seed: randomSeed });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewHtml, randomSeed]);

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
  // The last lesson HTML the ROOM (server) actually accepted — i.e. content
  // echoed back via a server broadcast. Used to REVERT the teacher's
  // optimistic local preview when an upload is rejected (oversized etc.), so
  // the teacher can never keep teaching on a sim only they can see.
  const lastRoomAcceptedHtmlRef = useRef<string | null>(null);
  // Catch-up replay: when the teacher switches to the whiteboard / temp content
  // and back, the lesson iframe REMOUNTS and boots a fresh sim on the home
  // screen. These flags drive a one-shot journal replay on that remount so the
  // teacher catches up to the room's real screen instead of sitting on the map.
  const prevAwayRef = useRef(false);
  const lessonCatchupRef = useRef(false);
  const pendingFullReplayRef = useRef(false);
  const fullReplayWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Self-heal: bumping this forces the lesson iframe to remount from scratch.
  // Triggered when a replayed click can't find its target (the two sides have
  // drifted to different screens) — the remount + full-journal catch-up snaps
  // the teacher back onto the student's real screen.
  const [iframeRebuildNonce, setIframeRebuildNonce] = useState(0);
  const lastResyncAtRef = useRef(0);
  // Ref mirrors so the stable self-heal callback reads live surface state.
  const whiteboardModeRef = useRef(false);
  const showTempContentRef = useRef(false);
  useEffect(() => { whiteboardModeRef.current = whiteboardMode; }, [whiteboardMode]);
  useEffect(() => { showTempContentRef.current = showTempContent; }, [showTempContent]);

  // Self-heal a drifted lesson iframe: mark a catch-up and force a fresh
  // remount (new blob URL → reload → handleIframeLoad → request_replay → full
  // journal replay). Rate-limited so a genuinely broken journal can't loop.
  const forceLessonResync = useCallback((reason: string) => {
    if (whiteboardModeRef.current || showTempContentRef.current) return; // only the live lesson iframe
    const now = Date.now();
    if (now - lastResyncAtRef.current < 4000) return; // at most once per 4s
    lastResyncAtRef.current = now;
    lessonCatchupRef.current = true;
    setIframeRebuildNonce(n => n + 1);
    console.info('[sync] self-heal resync:', reason);
  }, []);

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

  // Detect the teacher returning to the lesson FROM the whiteboard / temp
  // content. The lesson iframe remounts fresh on that transition, so flag that
  // its next onLoad must pull + replay the journal to catch up (see
  // handleIframeLoad). Only this transition trips it, so normal join / reconnect
  // / live flow is untouched.
  // The away->back journal replay is gone with the unmount that made it
  // necessary. The lesson iframe now stays mounted underneath the whiteboard and
  // the explanation, so returning to it means making it visible again -- there is
  // no fresh sim booted on the home screen, and nothing to replay forward.
  //
  // That matters beyond the lost position: replay was the drift mechanism.
  // Re-applying a journal of clicks against a rebuilt DOM is what put the
  // teacher and the class on different questions in the first place, and it
  // could only ever be as good as the journal. Not rebuilding beats replaying.
  //
  // lessonCatchupRef survives for the self-heal path (resyncLesson bumps
  // iframeRebuildNonce and forces a REAL remount); only this transition stops
  // arming it.
  useEffect(() => {
    prevAwayRef.current = whiteboardMode || showTempContent;
  }, [whiteboardMode, showTempContent]);

  const applySessionState = useCallback((state: any) => {
    // ── Server-restart detection ──
    // The room's interaction counter can only be BEHIND our applied-seq
    // filter if the room was rebuilt (redeploy / cold-start / reset). Without
    // this, two silent failures compound: the revision guard below rejects
    // the fresh hydration (small revision < our big tracker), and the seq
    // filter keeps dropping every new interaction as "stale" — sync appears
    // dead after a mid-class restart even though everyone reconnected.
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
    if (typeof state.studentInteractionAllowed === 'boolean') setStudentInteractionAllowed(state.studentInteractionAllowed);
    if (typeof state.currentStep === 'number') setCurrentStep(state.currentStep);
    if (typeof state.zoomLevel === 'number') setZoomLevel(state.zoomLevel);
    if (state.gates) setGates(state.gates);
    if (typeof state.randomSeed === 'number') setRandomSeed(state.randomSeed);
    // Held, not applied: the lesson iframe may not exist yet, and applying it to
    // the wrong instance is worse than not applying it at all. handleIframeLoad
    // hands it over once the lesson is actually running.
    if (typeof state.lessonState === 'string' && state.lessonState) {
      pendingLessonStateRef.current = state.lessonState;
    }
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
    // The kept list survives a reload — that's the whole point of keeping it.
    if (Array.isArray(state.explanations)) setExplanations(state.explanations);
    if ('activeExplanationId' in state) setActiveExplanationId(state.activeExplanationId ?? null);
    if (state.whiteboard) setWhiteboardState(state.whiteboard);
    if (boardHasContent(state.whiteboard)) lastGoodBoardRef.current = state.whiteboard;
    // The server restarted and handed us a fresh, empty room. Our own browser
    // still holds the lesson, so push it back rather than letting an hour of
    // teaching disappear off every screen at once.
    // (This page IS the teacher — the only client that holds the whole board.)
    const decision = shouldReseedBoard(state.whiteboard, lastGoodBoardRef.current, {
      wasReconnect: boardReseedPendingRef.current,
      alreadyReseeded: false,
    });
    if (decision.reseed) {
      boardReseedPendingRef.current = false;
      reseedBoardRef.current?.(lastGoodBoardRef.current);
    }
    if (Array.isArray(state.annotations)) setAnnotations(state.annotations);
    // Whiteboard mode is server-persisted; restore on reconnect so the
    // teacher lands on the same surface they were on before disconnect.
    if (typeof state.whiteboardMode === 'boolean') setWhiteboardMode(state.whiteboardMode);
    // AUTONOMOUS: Claim status — drives the "X hours left to save" banner.
    if (typeof state.claimed === 'boolean') setClaimed(state.claimed);
    if (state.claimedBy !== undefined) setClaimedBy(state.claimedBy);
    if (typeof state.expiresAt === 'number') setExpiresAt(state.expiresAt);
    // The teacher's iframe IS the lesson, so it boots from the pristine source —
    // never from a serialized DOM. A snapshot has already-rendered markup in it;
    // running the lesson's scripts over that re-initialises a quiz to question 1
    // and gives a lesson that appends its canvas on load a second canvas. The
    // snapshot remains a fine boot state for a FOLLOWER, which runs no scripts.
    const html = state.lastRunHtml || state.sourceHtml || state.effectiveHtml;
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
  // Auto-dismiss timers for the hand-raised banner and the attention-check
  // state. Kept in refs so a re-trigger clears the prior timer first (otherwise
  // an earlier timer fires and dismisses the NEWER banner early), and so they
  // can be cleared on unmount.
  const handRaiseTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const attentionTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
    // The passcode rides on the handshake — the server refuses the connection
    // without it, so this is the only place it needs to be presented.
    const newSocket = io({ auth: socketAuth() });
    newSocket.on('connect_error', (err) => {
      // A refused handshake means the stored code is wrong or stale. Tell the
      // gate so it can ask again, rather than leaving a room that silently
      // never connects.
      if (isPasscodeError(err)) refusePasscode();
    });
    setSocket(newSocket);

    newSocket.on("connect", () => {
      const wasReconnect = hasEverConnectedRef.current;
      hasEverConnectedRef.current = true;
      // Arm board recovery for the state message that follows this reconnect.
      boardReseedPendingRef.current = wasReconnect;
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
      newSocket.emit("join_room", { roomId, userName: teacherName, role: 'teacher', tz: localTimezone(), clientId: clientId() });

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

    newSocket.on("user_list", (list: UserInfo[]) => {
      setUsers(list);
      const before = usersRef.current;
      usersRef.current = list;
      // Driven from membership rather than a timer, so it is exact at both
      // edges. setPresence is idempotent — this fires constantly.
      teachingClockRef.current.setPresence(isTeaching(list), Date.now());
      // A student who arrives mid-share gets their own connection, or they sit
      // looking at a lesson the tutor has already stopped teaching from.
      if (myScreenStreamRef.current) {
        for (const u of list) {
          if (u.role !== 'student') continue;
          if (before.some(b => b.id === u.id)) continue;
          offerScreenToRef.current?.(u.id);
        }
      }
      // Remember each person's zone by name rather than reading the live list
      // at export time: a student who drops before the pack is built has left
      // the list, but their times are still all over the session.
      for (const u of list) if (u.tz) participantTzRef.current[u.name] = u.tz;
    });
    newSocket.on("user_left", (data: { userId: string; userName: string }) => {
      // If they were sharing their screen, the connection is now dead but the
      // last frame would sit there looking live. Say what happened instead.
      if (screenShareRef.current?.id === data.userId) {
        screenPeerRef.current?.close();
        screenPeerRef.current = null;
        setScreenStream(null);
        setScreenStatus('ended');
      }
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
      // SPLIT-BRAIN FIX: every upload path applies the content to the teacher's
      // preview optimistically, BEFORE the server validates it. If the room
      // rejected it (too large, invalid), the teacher would otherwise keep
      // teaching on a sim only they can see — the "3D sim works for me but
      // never loads for the student" bug. Revert to the last content the room
      // actually accepted so both sides look at the same thing again.
      const revertTo = lastRoomAcceptedHtmlRef.current;
      if (revertTo) {
        setHtmlCode(revertTo);
        setSimPreviewHtml(revertTo);
        showNotif(`⚠️ Upload rejected: ${message} — reverted to the last synced lesson (the class never received it)`);
      } else {
        setPreviewHtml("");
        setHtmlCode("");
        showNotif(`⚠️ Upload rejected: ${message} — the class never received it`);
      }
    });
    // A student's lesson failed to load/run on THEIR machine (blocked CDN
    // script, WebGL unavailable, JS crash). Without this the teacher has no
    // signal at all — the student just silently "isn't following".
    newSocket.on("sim_error", ({ studentName, message }: { studentName: string; message: string }) => {
      showNotif(`⚠️ ${studentName}'s lesson hit an error: ${message}`);
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
      // Any run_preview FROM the server means the room accepted this content —
      // remember it as the revert anchor for rejected uploads.
      if (typeof html === 'string' && html.length > 0) lastRoomAcceptedHtmlRef.current = html;
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
      // Reset the dismiss timer so a second raise within 8s isn't cleared early
      // by the first raise's timer.
      if (handRaiseTimerRef.current) clearTimeout(handRaiseTimerRef.current);
      handRaiseTimerRef.current = setTimeout(() => setHandRaised(null), 8000);
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
    newSocket.on("temp_content", ({ html, name, id }: { html: string; name: string; id?: string }) => {
      setTempContent({ html, name });
      setActiveExplanationId(id ?? null);
      setShowTempContent(true);
      showNotif(`📚 Showing explanation: ${name}`);
    });
    newSocket.on("clear_temp_content", () => {
      setShowTempContent(false);
      setActiveExplanationId(null);
      showNotif('↩️ Back to main content');
    });
    // The kept list behind the tab strip (names only — bodies stay server-side
    // until one is actually shown).
    // Lines the student's own device transcribed from their microphone.
    newSocket.on("narration_line", ({ speaker, text, t }: { speaker: string; text: string; t: number }) => {
      packRef.current.addNarration(speaker, text, t);
      setPackCounts(packRef.current.counts);
    });
    // A view-only student tapped the lesson and asked to be let in.
    newSocket.on("interaction_requested", ({ studentName, at }: { studentName: string; at: number }) => {
      setInteractionAsk({ studentName: studentName || 'A student', at: at || Date.now() });
      sounds.raiseHand();   // it IS a hand going up, just about the controls
    });
    newSocket.on("explanations_state", ({ list, activeId }: { list: Array<{ id: string; name: string }>; activeId: string | null }) => {
      setExplanations(Array.isArray(list) ? list : []);
      setActiveExplanationId(activeId ?? null);
    });

    newSocket.on("interaction", (event: any) => {
      // While a full catch-up replay is in flight (the teacher just returned to
      // the lesson from the whiteboard / temp content and asked for the whole
      // journal), don't apply live events into the fresh iframe: the replay is
      // authoritative and, because Socket.IO preserves server→client order,
      // either delivers this event before the replay (so the replay includes
      // it) or after (so this handler applies it once the flag has cleared).
      // Applying here would double-apply against the replay and over-advance a
      // quiz. Cursor is exempt — it's ephemeral and never replayed. A 3s
      // watchdog in handleIframeLoad guarantees the flag can never wedge.
      if (pendingFullReplayRef.current && event.type !== 'SYNC_CURSOR') return;
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
        // Dual View is no longer fed replays — it is a follower, painted by the
        // mirror stream like any student. Replaying into it was what made it a
        // second drifting copy rather than a view of the class's screen.
        postToIframe({ ...event, type: event.type.replace("SYNC_", "REMOTE_") });
      } else {
        postToIframe({ ...event, type: event.type.replace("SYNC_", "REMOTE_") });
      }
      // Same stale-closure reasoning: read through the ref so flipping Record
      // on after mount actually starts recording from that moment forward.
      if (isRecordingRef.current) sessionRecorder.record('interaction', event);
    });

    // ── Student absolute-state snapshot ──
    // INTENTIONALLY NOT applied to the teacher's iframe anymore.
    //
    // (Removed: the "student_state" listener. It was an explicit no-op —
    //  swapping a student's DOM back onto the teacher dropped every
    //  listener the lesson had wired up, which was the "buttons stop
    //  working" bug. Under the mirror the teacher already sees the
    //  student's exact state, so nothing sends it any more either.)


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
      // Server-restart detection — same rule as applySessionState.
      if (typeof state.interactionSeq === 'number' && state.interactionSeq < lastInboundSeqRef.current) {
        lastInboundSeqRef.current = state.interactionSeq;
        lastRevisionRef.current = 0;
      }
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
      // A catch-up replay (teacher just returned to the lesson from the
      // whiteboard / temp content) targets a FRESH sim that has applied
      // nothing, so re-live the WHOLE journal, not just the unseen tail.
      if (pendingFullReplayRef.current) {
        lastInboundSeqRef.current = 0;
        pendingFullReplayRef.current = false;
        if (fullReplayWatchdogRef.current) { clearTimeout(fullReplayWatchdogRef.current); fullReplayWatchdogRef.current = null; }
      }
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

    // ── LIVE MIRROR: a driving student's input, applied on the real lesson ──
    // A student who may drive (interactive / holds control) forwarded an input.
    // Apply it on THIS authoritative iframe; the resulting DOM streams back to
    // everyone. The server already gated this to eligible students.
    newSocket.on("mirror_input", ({ input }: { input: any }) => {
      lastForwardedInputRef.current = Date.now();
      if (!input || typeof input !== 'object') return;
      postToIframe({ type: 'MIRROR_INPUT', ...input });
    });
    // A (re)joining student asked for a fresh full snapshot.
    newSocket.on("mirror_request", () => {
      postToIframe({ type: 'MIRROR_REQUEST' });
    });

    // ── Control handoff ──
    newSocket.on("mirror_status", ({ studentId, ok, at }: { studentId: string; studentName: string; ok: boolean; at: number }) => {
      setSyncStatus(prev => ({ ...prev, [studentId]: { ok, at: at || Date.now() } }));
    });

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

    // ── Screen share: the student's answer, and their video ──
    newSocket.on("screen_signal", ({ signal, from }: { signal: any; from: string }) => {
      // TWO conversations share this channel and both can be live at once:
      // a student's screen we asked to watch, and our own screen we are
      // pushing to them. Routing everything to the watch peer meant the
      // student's ANSWER to our share was silently dropped, so the handshake
      // never completed and the tutor's screen never arrived.
      const sharingPeer = myScreenPeersRef.current.get(from);
      if (sharingPeer) void sharingPeer.accept(signal);
      const watching = screenShareRef.current;
      if (watching && watching.id === from) void screenPeerRef.current?.accept(signal);
    });
    newSocket.on("screen_state", ({ state, from, name }: { state: string; from: string; name?: string }) => {
      const watching = screenShareRef.current;
      if (!watching || watching.id !== from) return;
      const who = name || watching.name;
      if (state === 'sharing') { setScreenStatus('connecting'); setScreenError(null); }
      if (state === 'declined') { setScreenStatus('declined'); setScreenError(null); }
      if (state === 'unsupported') { setScreenStatus('unsupported'); setScreenError(null); }
      if (state === 'failed') { setScreenStatus('failed'); setScreenError(shareFailureMessage({ name: 'NotReadableError' }, who)); }
      if (state === 'stopped') {
        // They pressed Stop, or closed the tab. Drop the connection rather than
        // leaving their last frame on screen looking live.
        screenPeerRef.current?.close();
        screenPeerRef.current = null;
        setScreenStream(null);
        setScreenStatus('ended');
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
        if (s.html_used && s.html_used.length <= 2 * 1024 * 1024) {
          const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          socket.emit('upload_file', { roomId, file: { id: fileId, name: s.topic || 'Reopened session', html: s.html_used, uploadedAt: Date.now() } });
          setSimPreviewHtml(s.html_used);
        } else if (s.html_used) {
          showNotif('⚠️ Saved lesson exceeds the 2MB sync limit — not restored to the class');
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
    const win = iframeRef.current?.contentWindow;
    // See the student-side twin of this: a load event we never saw must not mute
    // the iframe permanently. Ask the document whether it is loaded rather than
    // trusting a flag that nothing is coming to re-set.
    let ready = iframeReadyRef.current;
    if (!ready && win) {
      try { ready = iframeRef.current?.contentDocument?.readyState === 'complete'; } catch { ready = false; }
      if (ready) {
        iframeReadyRef.current = true;
        const stalled = pendingMessagesRef.current;
        pendingMessagesRef.current = [];
        for (const m of stalled) win.postMessage(m, '*');
      }
    }
    if (ready && win) {
      win.postMessage(msg, '*');
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
    // GONE: the 2.5-second full-document snapshot.
    //
    // It existed so a late joiner had something recent to boot from. The mirror
    // frame is that now — cached on the room and served the instant a student
    // asks — and it is the body only, deduplicated, already being sent. The
    // snapshot was the whole document, on a timer, forever: on a 349kB lesson,
    // 760kB of dom_snapshot plus 760kB of sync_html_update across a handful of
    // clicks, none of which any student ever read.
    //
    // REQUEST_HTML still exists for the things that genuinely need a document —
    // Force Sync's re-baseline and the class pack — but on demand, not on a
    // clock.
    return;
  }, [whiteboardMode, showTempContent]);

  // ── Iframe onLoad: flush pending messages ──
  const handleIframeLoad = useCallback(() => {
    iframeReadyRef.current = true;
    // A fresh document needs its own instrumentation — see the effects keyed
    // on iframeDocNonce below.
    setIframeDocNonce(n => n + 1);
    // Are we about to do a full catch-up replay (teacher returned to the lesson
    // from the whiteboard / temp content)? If so the queued events are STALE —
    // they were captured while the iframe was unmounted, they target a screen
    // this fresh iframe isn't on, and (because REMOTE_CLICK now retries for a
    // target that appears late) they would DOUBLE-APPLY against the
    // authoritative replay below and over-advance the quiz. The replay already
    // contains them in order, so drop the queue instead of flushing it.
    const doingCatchup = lessonCatchupRef.current && !whiteboardMode && !showTempContent && !!socket;
    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    if (!doingCatchup) {
      for (const msg of pending) {
        iframeRef.current?.contentWindow?.postMessage(msg, '*');
      }
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
      iframeRef.current?.contentWindow?.postMessage({ type: 'MIRROR_ZOOM', zoom: zoomLevel }, '*');
    }
    // Put the lesson back where the class was.
    //
    // A reload is a new lesson: the old one died with the tab. The mirror can
    // keep everyone on the teacher's screen but cannot keep that screen alive,
    // and rebuilding from a DOM snapshot re-runs the lesson's scripts over
    // already-rendered markup — a quiz back at question 1, with two canvases.
    //
    // So the lesson says where it is (window.mathslive.getState) and gets handed
    // it back here, once, after it has had a moment to define the hook. Applied
    // to the running instance, not to markup, so there is nothing to re-run.
    const resume = pendingLessonStateRef.current;
    if (resume) {
      pendingLessonStateRef.current = null;
      setTimeout(() => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'MIRROR_RESTORE_STATE', state: resume }, '*');
      }, 900);
    }
    // CATCH-UP: if the lesson iframe just remounted after the teacher was on the
    // whiteboard / temp content, it booted fresh on the home screen. Pull the
    // current journal and replay it forward so the teacher returns to the room's
    // REAL screen (e.g. the quiz question the student is on) instead of being
    // stranded on the map. Only the away→back transition trips lessonCatchupRef,
    // so this never fires during normal join / reconnect / live operation.
    if (doingCatchup) {
      lessonCatchupRef.current = false;
      pendingFullReplayRef.current = true;
      lastInboundSeqRef.current = 0;
      socket!.emit('request_replay', { roomId });
      // Watchdog: if the replay never arrives (server hiccup), release the
      // live-event hold so sync resumes rather than staying frozen.
      if (fullReplayWatchdogRef.current) clearTimeout(fullReplayWatchdogRef.current);
      fullReplayWatchdogRef.current = setTimeout(() => { pendingFullReplayRef.current = false; }, 3000);
    }
  }, [scrollSyncEnabled, stepLockEnabled, currentStep, zoomLevel, controlHolderName, socket, whiteboardMode, showTempContent, roomId]);

  // ── Which surface is on screen ──
  //
  // The lesson iframe is mounted for the whole session now, so "hidden" means
  // visually hidden, not unmounted. Two lesson documents can therefore be alive
  // at once (the lesson, still running, underneath an explanation) and exactly
  // one of them is the class's authoritative view.
  //
  // iframeRef keeps the meaning it has everywhere else in this file -- "the
  // surface the lesson plumbing talks to" -- and is pointed at the active one
  // rather than being handed to whichever happened to be the only one mounted.
  // The relay handler already drops anything whose e.source is not
  // iframeRef.current.contentWindow, so the hidden lesson cannot leak a single
  // frame to students just by continuing to run.
  // A tab that has lost the teacher's seat must stop streaming. The server now
  // refuses its frames anyway, but leaving the lesson mounted keeps a second
  // simulation running, burning CPU and firing timers, for a tab whose only
  // remaining job is to say it was replaced.
  const lessonHidden = whiteboardMode || showTempContent || teacherReplaced;
  const lessonFrameRef = useRef<HTMLIFrameElement | null>(null);
  const tempFrameRef = useRef<HTMLIFrameElement | null>(null);

  const handleSurfaceLoad = useCallback((el: HTMLIFrameElement | null, isActive: boolean) => {
    // A hidden surface finishing a load is not our channel. Without this, a
    // lesson reload behind an open explanation would flush the queue into the
    // wrong document and re-point every subsequent message at it.
    if (!isActive) return;
    iframeRef.current = el;
    handleIframeLoad();
  }, [handleIframeLoad]);

  // Switching surfaces does not necessarily reload anything -- coming back to a
  // lesson that never went away fires no load event at all -- so the pointer is
  // also set here, on the switch itself.
  useEffect(() => {
    iframeRef.current = showTempContent ? tempFrameRef.current : lessonFrameRef.current;
  }, [showTempContent, whiteboardMode, tempContentUrl, iframeUrl]);

  // ── Mirror iframe onLoad: behave like a passive student view ──
  const handleMirrorLoad = useCallback(() => {
    mirrorReadyRef.current = true;
    const pending = pendingMirrorMessagesRef.current;
    pendingMirrorMessagesRef.current = [];
    for (const msg of pending) {
      mirrorIframeRef.current?.contentWindow?.postMessage(msg, '*');
    }
    // A follower shell, watching only: it must never forward input, and it must
    // not scroll itself away from what the class is being shown.
    mirrorIframeRef.current?.contentWindow?.postMessage({ type: 'SET_MIRROR_INTERACT', allowed: false }, '*');
    mirrorIframeRef.current?.contentWindow?.postMessage({ type: 'SET_MIRROR_SCROLLLOCK', locked: true }, '*');
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
    const handler = (e: MessageEvent) => {
      if (!socket) return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const type = e.data?.type;
      if (!type) return;

      // ── LIVE MIRROR (source → students) ──
      // The authoritative iframe streams its real DOM/canvas. Relay to the
      // server (which fans out to every follower). MUST be handled and returned
      // BEFORE the SYNC_ interaction relay below — 'SYNC_MIRROR' starts with
      // 'SYNC_' but is a snapshot, not a replayable interaction.
      // Dual View is a follower now, so it is painted by the same frames the
      // class gets — from this iframe, before they even leave the machine.
      if (dualViewRef.current && type.indexOf('SYNC_MIRROR') === 0) {
        if (type === 'SYNC_MIRROR') postToMirror({ type: 'MIRROR_APPLY', body: e.data.body, attrs: e.data.attrs, head: e.data.head, h: e.data.h, scrollX: e.data.scrollX, scrollY: e.data.scrollY });
        else if (type === 'SYNC_MIRROR_CANVAS') postToMirror({ type: 'MIRROR_CANVAS', canvases: e.data.canvases });
        else if (type === 'SYNC_MIRROR_SCROLL') postToMirror({ type: 'MIRROR_SCROLL', scrollX: e.data.scrollX, scrollY: e.data.scrollY });
      }
      if (type === 'SYNC_MIRROR') {
        socket.emit('mirror_dom', {
          roomId, body: e.data.body, scrollX: e.data.scrollX, scrollY: e.data.scrollY,
          // Body attributes + runtime-injected head CSS + the content fingerprint
          // students use to detect a dropped snapshot.
          attrs: e.data.attrs, head: e.data.head, h: e.data.h,
        });
        return;
      }
      if (type === 'SYNC_MIRROR_CANVAS') { socket.emit('mirror_canvas', { roomId, canvases: e.data.canvases }); return; }
      if (type === 'SYNC_MIRROR_SCROLL') { socket.emit('mirror_scroll', { roomId, scrollX: e.data.scrollX, scrollY: e.data.scrollY }); return; }
      // Tiny fingerprint heartbeat — lets a student whose snapshot was lost in
      // transit notice and ask for a resync (the last structural desync hole).
      if (type === 'SYNC_MIRROR_PING') { socket.emit('mirror_ping', { roomId, h: e.data.h }); return; }
      // Teacher-only diagnostics: the mirror physically cannot ship this lesson.
      if (type === 'SYNC_MIRROR_OVERSIZE') {
        showNotif(`⚠️ This lesson's page is very large (${Math.round((e.data.bytes || 0) / 1024 / 1024)}MB) — students may not update. Try trimming it or splitting it up.`);
        return;
      }
      if (type === 'SYNC_MIRROR_TAINTED') {
        showNotif('⚠️ A drawing area uses an image from another site, so it can\'t be shared to students. Host the image with CORS enabled.');
        return;
      }
      if (type === 'MIRROR_SOURCE_READY') { return; }
      // The lesson saying where it has got to. Small, deduplicated by the
      // source, and the only thing that can put it back after a reload.
      if (type === 'SYNC_MIRROR_STATE') { socket.emit('mirror_state', { roomId, state: e.data.state }); return; }
      if (type === 'SYNC_MIRROR_STATEFUL') { setLessonResumable(!!e.data.supported); return; }
      if (type === 'SYNC_MIRROR_RESTORED') {
        if (e.data.ok) showNotif('⏱️ Picked the lesson back up where the class was');
        return;
      }

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

      // The teacher's OWN sim reported a load/runtime failure (CDN script
      // blocked, WebGL unavailable, JS crash). Surface it locally — and never
      // let it fall through to the interaction relay below (it must not be
      // replayed into student iframes as a REMOTE_* event).
      if (type === 'SYNC_SIM_ERROR') {
        showNotif(`⚠️ Lesson error on your screen: ${e.data.message || 'unknown'}`);
        return;
      }

      // SELF-HEAL: a replayed click couldn't find its target after retries —
      // this iframe has drifted onto a different screen than the driver
      // (a stateful quiz where a nav/answer replay was missed). Force a fresh
      // remount + full-journal catch-up so the teacher snaps back onto the
      // student's real screen. Rate-limited inside forceLessonResync. Must NOT
      // fall through to the interaction relay (it's not a real interaction).
      // A replayed click that could not find its target used to remount this
      // iframe and replay the whole journal again — rate-limited to once per 4s
      // but with no ceiling, so a lesson the journal could never reproduce
      // rebuilt itself every four seconds, pushing a different screen to the
      // class each time. That is the best candidate for the "sometimes weird
      // things happen" nobody could reproduce.
      //
      // In the mirror model there is nothing to repair here: this iframe IS the
      // lesson, and it cannot be out of step with itself. Drop the signal.
      if (type === 'SYNC_REPLAY_MISS') return;

      // Only the two events the mirror does NOT carry.
      //
      // Everything else here was replay fodder: clicks, keys, drags, scroll —
      // all re-derived on each student's own copy of the lesson. Students do not
      // run the lesson any more, so those events arrive as no-ops, are journaled
      // for a replay nothing performs, and each one dragged a full-document
      // snapshot along behind it.
      //
      // A cursor is not state, and a "look here" ping is not state; neither can
      // be recovered from a DOM frame, so both keep their channel.
      if (type === 'SYNC_CURSOR' || type === 'SYNC_PING') {
        if (!e.data.mirrorOnly) {
          socket.emit("interaction", {
            roomId,
            event: { ...e.data, syncEpoch: syncEpochRef.current, clientTs: Date.now() },
          });
        }
        return;
      }
      if (type.startsWith('SYNC_')) {
        if (type === 'SYNC_SCROLL' && !scrollSyncEnabled) return;
        // Dual View is painted by the mirror stream now (see the SYNC_MIRROR
        // branch above), so it needs nothing here either.
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    };
  }, [socket, roomId, scrollSyncEnabled, dualView, postToMirror, forceLessonResync]);

  // SINGLE-WRITER: the teacher drives the sim by default, but when the teacher
  // hands the chalk to a student, the teacher becomes a MIRROR - its sim is
  // driven by the student's replayed events, so the teacher's local clicks
  // must be locked out (otherwise two drivers diverge). presenterMode +
  // interaction-allowed both follow "am I the sole writer right now" = no
  // student holds control.
  useEffect(() => {
    // The source iframe is ALWAYS the presenter, whoever is driving.
    //
    // These used to follow "is the teacher the sole writer", so handing a
    // student control put this iframe into the legacy engine's blocked state —
    // where it cancels every click, input and pointer event at capture phase.
    // The student's forwarded taps are dispatched into this same document, so
    // they were cancelled too, and "you have control" meant nothing worked.
    //
    // Blocking the wrong thing, at the wrong level: this is the one running copy
    // of the lesson, and control decides who may FORWARD input to it — which the
    // server already enforces — not whether the lesson may receive any.
    postToIframe({ type: 'SET_INTERACTION_MODE', allowed: true });
    postToIframe({ type: 'SET_PRESENTER_MODE', enabled: true });
  }, [iframeUrl, postToIframe]);

  useEffect(() => {
    // syncEpoch must mirror the student-side dependency set so the two counters
    // stay in lock-step. Including teacher-only UI flags like dualView here used
    // to drift the teacher's epoch ahead of the student's, after which all
    // student interaction events were silently dropped.
    syncEpochRef.current += 1;
  }, [iframeUrl, showTempContent, whiteboardMode]);

  // Readiness tracks the MOUNTED iframe, not the dependency set the epoch needs.
  // An iframeUrl change while an explanation is showing was clearing the flag for
  // an iframe that is not on screen and will not load again -- after which every
  // REQUEST_HTML and interaction-mode push queued instead of being delivered.
  const mountedSurface = whiteboardMode ? null : showTempContent ? tempContentUrl : iframeUrl;
  useEffect(() => {
    iframeReadyRef.current = false;
  }, [mountedSurface]);


  // Mirror iframe readiness must reset when the mirror is created/destroyed
  // (dualView toggle) or when its content URL changes — but this is a local
  // ready-tracking concern, not a content-version reset.
  useEffect(() => {
    mirrorReadyRef.current = false;
    pendingMirrorMessagesRef.current = [];
  }, [mirrorFollowerUrl, showTempContent, whiteboardMode, dualView]);

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
    // LIVE MIRROR: the teacher's lesson iframe is the single authoritative
    // instance. The 'source' agent streams its real DOM (+ canvas) to students,
    // who render a read-only mirror and can never be on a different screen. It
    // rides alongside the classic sync scripts (different message namespace).
    // The mirror, and the step lock. That is the whole engine now.
    //
    // seededSyncScript used to be here too — the input-replay engine, which
    // re-derived the lesson's state on every screen by re-running clicks. It has
    // not driven a student since the mirror landed, but it stayed loaded in this
    // iframe and kept its reach: it journaled every click, snapshotted the whole
    // document on a timer, and cancelled input at capture phase whenever the
    // iframe was in a blocked state — which is what made a student's forwarded
    // taps vanish the moment they were given control.
    //
    // Everything it still genuinely provided — the cursor, the "look here" ping,
    // lesson-load errors, an on-demand document snapshot, follow-click — now
    // comes from the mirror source itself, where it belongs. One engine.
    const scripts = stepLockScript + mirrorScriptFor('source');
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
  }, [previewHtml, randomSeed, iframeRebuildNonce]);

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
    // Scroll sync only. Presenter mode is set once, above, and stays true — a
    // duplicated rule is how the original block survived: this effect re-asserted
    // the old answer on every scroll-sync change and quietly undid the fix.
    postToIframe({ type: 'SET_SCROLL_SYNC', enabled: scrollSyncEnabled });
  }, [scrollSyncEnabled, iframeUrl, postToIframe]);

  // ── Zoom: push to iframe when level changes ──
  useEffect(() => {
    // Both: SET_ZOOM is the legacy engine's (documentElement, teacher-only),
    // MIRROR_ZOOM is the mirror's (body, and therefore actually reaches the
    // class). Sending both keeps the teacher's own view identical either way.
    postToIframe({ type: 'SET_ZOOM', zoom: zoomLevel });
    postToIframe({ type: 'MIRROR_ZOOM', zoom: zoomLevel });
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
  // Clear any pending auto-dismiss / generation timers on unmount so they don't
  // fire on a torn-down component (all are also cleared/reset at their sources).
  useEffect(() => () => {
    if (handRaiseTimerRef.current) clearTimeout(handRaiseTimerRef.current);
    if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current);
    if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
  }, []);
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
        reviewLesson(entry.html);
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

  // ── Ways out of the drop overlay ──
  // A drag can end without the page ever hearing about it: dragging back out of
  // the window, dropping on browser chrome, pressing Escape mid-drag, or the OS
  // cancelling it. Any of those used to leave the overlay stuck over the whole
  // app. These are the escapes — plus a stalled-drag timeout as the backstop.
  useEffect(() => {
    if (!isDragging) return;
    const clear = () => setIsDragging(false);
    // relatedTarget === null means the pointer left the window entirely.
    const onWindowDragLeave = (e: DragEvent) => { if (!e.relatedTarget) clear(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clear(); };
    // If no drag event arrives for a moment, the drag is over — the browser
    // just never told us. Refreshed by dragover while a drag is genuinely live.
    let stall = window.setTimeout(clear, 1500);
    const onDragOver = () => { window.clearTimeout(stall); stall = window.setTimeout(clear, 1500); };

    window.addEventListener('dragleave', onWindowDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', clear);
    window.addEventListener('blur', clear);
    return () => {
      window.clearTimeout(stall);
      window.removeEventListener('dragleave', onWindowDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', clear);
      window.removeEventListener('blur', clear);
    };
  }, [isDragging]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!socket) return;
    const droppedFiles = (Array.from(e.dataTransfer.files) as File[]).filter(f => /\.html?$/i.test(f.name));
    if (droppedFiles.length === 0) { showNotif("⚠️ That is not an HTML file. Images and PDFs go on the whiteboard — open it and drop them there."); return; }
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
        reviewLesson(entry.html);
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
    // PRE-FLIGHT (split-brain fix): this path had NO size check — a pasted 3D
    // sim with embedded assets (>2MB) was rejected server-side AFTER the
    // teacher's preview already showed it (and >5MB never even reached the
    // server: Socket.IO kills the connection silently). Validate BEFORE
    // emitting or touching the local preview.
    if (lessonTooLarge(pasteCode)) return;
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
      setLastSavedAt(Date.now());
      setSaveState('saved');
      showNotif("💾 Saved to this student's history");
    } catch {
      setSaveState('failed');
      showNotif('⚠️ Could not save to history');
    } finally {
      setSavingHistory(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.enabled, auth.user, roomId, savingHistory, files, activeFileId, whiteboardMode, whiteboardState]);

  // PRE-FLIGHT size guard, mirroring the server's MAX_FILE_SIZE (2MB on
  // html.length). Every send path must call this BEFORE emitting AND before
  // optimistically applying content locally. Without it, oversized lessons
  // (3D sims with embedded models/textures are the classic case) were shown
  // on the teacher's screen while the server rejected them — or, above the
  // socket's 5MB buffer, silently killed the connection with no error at all.
  const lessonTooLarge = (html: string): boolean => {
    const MAX = 2 * 1024 * 1024;
    if (html.length <= MAX) return false;
    showNotif(`⚠️ Lesson too large (${(html.length / 1024 / 1024).toFixed(1)}MB, max 2MB) — NOT sent to the class. Tip: load 3D models/textures from a CDN URL instead of embedding them.`);
    return true;
  };

  // What this lesson will and will not do once mirrored.
  //
  // Each of these used to fail silently in front of a class — an embedded page
  // running separately on every device, a fifth canvas never sent, sound only
  // the tutor can hear. Upload time is the last moment any of it can be acted
  // on, so it is said here rather than discovered by a child.
  const [lessonIssues, setLessonIssues] = useState<LessonIssue[]>([]);
  const reviewLesson = useCallback((html: string) => {
    try { setLessonIssues(checkLesson(html, { maxBytes: 2 * 1024 * 1024 })); }
    catch { setLessonIssues([]); }
  }, []);

  const runPreview = () => {
    if (!socket || !activeFileId) return;
    if (lessonTooLarge(htmlCode)) return;
    reviewLesson(htmlCode);
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
      text = `Join my ${PRODUCT.name} session:\n${url}\nPasscode: ${roomPassword}`;
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
  // Push this student a fresh frame. In the mirror model that is all "resync"
  // can mean — the server serves the cached frame and asks the source for a new
  // one; nothing is rebuilt on either side.
  const resyncStudent = useCallback((studentId: string, studentName: string) => {
    if (!socket) return;
    socket.emit('resync_student', { roomId, studentId });
    showNotif(`⟳ Sent ${studentName} a fresh frame`);
  }, [socket, roomId]);

  const resyncPeekStudent = () => {
    if (!socket || !peekStudentRef.current) return;
    socket.emit("resync_student", { roomId, studentId: peekStudentRef.current.id });
    showNotif(`⟳ Resyncing ${peekStudentRef.current.name}…`);
  };

  // ── Switching students and lesson days ──
  //
  // Both replace what is on the board, so both save first. Losing a lesson's
  // work to a menu click is the one unrecoverable thing this feature could do.
  const saveCurrentLesson = useCallback(async (): Promise<void> => {
    if (!classId || !boardHasContent(whiteboardState)) return;
    setSaveState('saving');
    try {
      const { saveLessonForDay, listSessions } = await import('../lib/sessions');
      const topic = files.find(f => f.id === activeFileId)?.name
        || (whiteboardMode ? 'Whiteboard session' : 'Session');
      const id = await saveLessonForDay({
        classId, topic, html: previewHtmlRef.current || null,
        whiteboard: whiteboardState, sessionId: currentSessionId,
        taughtSeconds: teachingClockRef.current.total(Date.now()),
      });
      if (id) setCurrentSessionId(id);
      // The lesson is on the server by here. Refreshing the picker is a
      // convenience, so its failure must not report the save as failed.
      setLastSavedAt(Date.now());
      setSaveState('saved');
      try { setMySessions(await listSessions(classId)); } catch { /* keep the stale list */ }
    } catch (err) {
      setSaveState('failed');
      throw err;   // the caller decides whether to retry
    }
  }, [classId, whiteboardState, files, activeFileId, whiteboardMode, currentSessionId]);

  // Save the lesson on a slow tick while teaching, and when the page is hidden.
  //
  // Until now a lesson only reached the student's history on an explicit click
  // or a lesson switch, so a tutor who taught for an hour and closed the tab
  // saved nothing — and the length of the lesson was never recorded at all.
  // Two minutes is slow enough to be invisible to the database and frequent
  // enough that a crash costs almost nothing.
  const saveLessonRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => { saveLessonRef.current = saveCurrentLesson; }, [saveCurrentLesson]);
  useEffect(() => {
    if (!classId) return;
    // A failed save used to wait two whole minutes for the next tick, and a
    // tutor who closed the tab in between lost the lesson. The usual causes —
    // a dropped wifi, a redeploy restarting the server underneath a class —
    // clear in seconds, so retry on a widening gap and let the ordinary tick
    // take over after that.
    let retry: ReturnType<typeof setTimeout> | null = null;
    const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
    const attempt = (n: number) => {
      void saveLessonRef.current?.().catch(() => {
        if (n >= RETRY_DELAYS_MS.length) return;
        retry = setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n]);
      });
    };
    const tick = () => {
      // Only while someone is actually being taught: an idle room re-writing
      // the same row every two minutes is pure noise.
      if (!isTeaching(usersRef.current)) return;
      if (retry) { clearTimeout(retry); retry = null; }
      attempt(0);
    };
    const id = setInterval(tick, 120_000);
    // pagehide is what actually fires on a closing tab; unload gives no time
    // for an async write and beforeunload is unreliable on mobile.
    const onHide = () => { void saveLessonRef.current?.().catch(() => {}); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', () => { if (document.hidden) onHide(); });
    return () => {
      clearInterval(id);
      if (retry) clearTimeout(retry);
      window.removeEventListener('pagehide', onHide);
    };
  }, [classId]);

  /** Wipe the live board for everyone, then replay a saved one onto it. */
  const loadLessonOntoBoard = useCallback((snap: any, html: string | null) => {
    if (!socket) return;
    socket.emit('whiteboard_clear', { roomId });
    if (snap?.gridMode) socket.emit('whiteboard_set_grid_mode', { roomId, gridMode: snap.gridMode });
    for (const shape of (snap?.shapes || [])) socket.emit('whiteboard_add_shape', { roomId, shape });
    for (const text of (snap?.texts || [])) socket.emit('whiteboard_add_text', { roomId, text });
    for (const inst of (snap?.instruments || [])) socket.emit('whiteboard_add_instrument', { roomId, instrument: inst });
    for (const obj of (snap?.objects || [])) socket.emit('whiteboard_add_image', { roomId, object: obj });
    for (const stroke of (snap?.strokes || [])) socket.emit('whiteboard_draw', { roomId, stroke });
    if (html && html.length <= 2 * 1024 * 1024) {
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      socket.emit('upload_file', { roomId, file: { id: fileId, name: 'Lesson', html, uploadedAt: Date.now() } });
      setSimPreviewHtml(html);
    } else if (html) {
      showNotif('⚠️ That lesson’s HTML is over the 2MB sync limit — the board loaded, the page did not');
    }
  }, [socket, roomId]);

  // Push our copy of the board back to a server that lost it. Same replay the
  // lesson switcher and the template hydrator use — one way to put a board on
  // the wire, so a bug in it shows up everywhere rather than only here.
  const reseedBoard = useCallback((board: any) => {
    if (!socket || !board) return;
    const pieces = boardPieceCount(board);
    if (board.gridMode) socket.emit('whiteboard_set_grid_mode', { roomId, gridMode: board.gridMode });
    for (const shape of (board.shapes || [])) socket.emit('whiteboard_add_shape', { roomId, shape });
    for (const text of (board.texts || [])) socket.emit('whiteboard_add_text', { roomId, text });
    for (const inst of (board.instruments || [])) socket.emit('whiteboard_add_instrument', { roomId, instrument: inst });
    for (const obj of (board.objects || [])) socket.emit('whiteboard_add_image', { roomId, object: obj });
    for (const stroke of (board.strokes || [])) socket.emit('whiteboard_draw', { roomId, stroke });
    // Say so. A board that blanks and silently refills looks like a glitch;
    // named, it is the app visibly catching the lesson.
    showNotif(`↻ The server restarted — put your board back (${pieces} ${pieces === 1 ? 'item' : 'items'})`);
    console.info('[recovery] re-seeded the whiteboard after a server restart', pieces);
  }, [socket, roomId]);
  useEffect(() => { reseedBoardRef.current = reseedBoard; }, [reseedBoard]);

  const switchToLesson = useCallback(async (row: SessionRow) => {
    if (switchBusy) return;
    setSwitchBusy(true);
    try {
      await saveCurrentLesson();
      const { getSession } = await import('../lib/sessions');
      const full = await getSession(row.id);
      if (!full) { showNotif('⚠️ That lesson could not be opened'); return; }
      loadLessonOntoBoard(full.whiteboard_snapshot, full.html_used);
      setCurrentSessionId(full.id);
      showNotif(`📂 Opened ${new Date(full.started_at).toLocaleDateString()}${full.topic ? ' — ' + full.topic : ''}`);
    } catch {
      showNotif('⚠️ Could not switch lesson');
    } finally {
      setSwitchBusy(false);
    }
  }, [switchBusy, saveCurrentLesson, loadLessonOntoBoard]);

  const startNewLesson = useCallback(async () => {
    if (switchBusy) return;
    setSwitchBusy(true);
    try {
      await saveCurrentLesson();
      if (socket) socket.emit('whiteboard_clear', { roomId });
      // A new lesson is not yet a row. It becomes one on the first save, and
      // pointing at nothing is what makes that a NEW row rather than an
      // overwrite of whatever was last open.
      setCurrentSessionId(null);
      showNotif('✦ Fresh board — the previous lesson is saved in this student’s history');
    } catch {
      showNotif('⚠️ Could not start a new lesson');
    } finally {
      setSwitchBusy(false);
    }
  }, [switchBusy, saveCurrentLesson, socket, roomId]);

  const switchToStudent = useCallback(async (row: ClassRow) => {
    if (switchBusy) return;
    setSwitchBusy(true);
    try {
      await saveCurrentLesson();
      // Their room is a different room entirely, so this is a navigation. A
      // full load is also the simplest way to be certain no state from the
      // previous student survives into the next one's lesson.
      window.location.href = `/room/${row.room_code}`;
    } catch {
      showNotif('⚠️ Could not switch student');
      setSwitchBusy(false);
    }
  }, [switchBusy, saveCurrentLesson]);

  // ── Screen share (watch the student's ACTUAL screen) ──
  // Peek, above, shows the lesson iframe's DOM. This is the student's whole
  // screen as live video — the thing that answers "why does yours look
  // different from mine", because it shows everything, including what is
  // covering the lesson.
  const askForScreen = (studentId: string, studentName: string) => {
    if (!socket) return;
    screenPeerRef.current?.close();
    setScreenStream(null);
    setScreenError(null);
    setScreenShare({ id: studentId, name: studentName });
    setScreenStatus('asking');
    // Ready to receive BEFORE asking: the offer can arrive the instant they
    // accept, and a peer built only on arrival would miss the ICE candidates
    // that come in right behind it.
    const peer = new ScreenPeer({
      send: (signal) => socket.emit('screen_signal', { roomId, to: studentId, signal }),
      onStream: (stream) => { setScreenStream(stream); setScreenStatus('live'); },
      onState: (s) => {
        if (s === 'failed') { setScreenStatus('failed'); }
        if (s === 'disconnected' || s === 'closed') setScreenStatus(prev => (prev === 'live' ? 'ended' : prev));
      },
    });
    peer.prepare();
    screenPeerRef.current = peer;
    socket.emit('screen_request', { roomId, studentId });
  };

  // Open a one-way video connection to one student and start pushing.
  const offerScreenTo = useCallback((studentId: string) => {
    const stream = myScreenStreamRef.current;
    if (!socket || !stream) return;
    // Never two connections to one student — a late user_list can name someone
    // we are already sending to.
    myScreenPeersRef.current.get(studentId)?.close();
    const peer = new ScreenPeer({
      send: (signal) => socket.emit('screen_signal', { roomId, to: studentId, signal }),
      onState: (st) => {
        if (st === 'failed' || st === 'closed') {
          myScreenPeersRef.current.get(studentId)?.close();
          myScreenPeersRef.current.delete(studentId);
        }
      },
    });
    myScreenPeersRef.current.set(studentId, peer);
    void peer.share(stream);
  }, [socket, roomId]);

  useEffect(() => { offerScreenToRef.current = offerScreenTo; }, [offerScreenTo]);

  const stopMyScreen = useCallback((tell = true) => {
    myScreenPeersRef.current.forEach(p => p.close());
    myScreenPeersRef.current.clear();
    // close() on each peer stops the tracks it holds; the stream itself is
    // shared between them, so stop it once here too or the browser keeps the
    // capture indicator up with nobody receiving.
    myScreenStreamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch { /* noop */ } });
    myScreenStreamRef.current = null;
    setMyScreenOn(false);
    if (tell && socket) socket.emit('teacher_screen', { roomId, on: false });
  }, [socket, roomId]);

  const startMyScreen = useCallback(async () => {
    if (!socket) return;
    if (!screenShareSupported()) {
      showNotif('This browser cannot share a screen. Chrome, Edge, Firefox or Safari on a computer can.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(displayCaptureOptions());
      myScreenStreamRef.current = stream;
      setMyScreenOn(true);
      // The browser's own "Stop sharing" bar is what most people reach for.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopMyScreen(true));
      socket.emit('teacher_screen', { roomId, on: true });
      usersRef.current.filter(u => u.role === 'student').forEach(u => offerScreenTo(u.id));
      showNotif('🖥️ Sharing your screen with the class');
    } catch (e) {
      myScreenStreamRef.current = null;
      setMyScreenOn(false);
      if ((e as { name?: string })?.name !== 'NotAllowedError') showNotif('Could not start screen sharing.');
    }
  }, [socket, roomId, offerScreenTo, stopMyScreen]);

  // Leaving the page must release the capture.
  useEffect(() => () => {
    myScreenPeersRef.current.forEach(p => p.close());
    myScreenStreamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch { /* noop */ } });
  }, []);

  const stopWatchingScreen = () => {
    const watching = screenShareRef.current;
    screenPeerRef.current?.close();
    screenPeerRef.current = null;
    setScreenStream(null);
    setScreenShare(null);
    setScreenStatus('idle');
    setScreenError(null);
    // Tell them to stop capturing. Closing our window while their screen is
    // still being captured is the worst of both: they see the recording
    // indicator, we see nothing.
    if (watching && socket) socket.emit('screen_state', { roomId, state: 'stopped', to: watching.id });
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
    // Leaving the board? Keep what was on it before it goes off screen.
    if (!newMode) captureBoardNow('Whiteboard');
    packRef.current.note(newMode ? 'Switched to the whiteboard' : 'Switched back to the lesson');
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
    packRef.current.note(newAllowed ? 'Handed the controls to the student' : 'Took the controls back');
    showNotif(newAllowed ? '🖐️ Students can now interact with the simulation' : '👁️ Students are now view-only');
  };

  // Grant it outright, from the "X is asking" prompt. Separate from the toggle
  // so answering the ask can never accidentally LOCK a room that's already open.
  const allowStudentInteraction = () => {
    if (!socket) return;
    setStudentInteractionAllowed(true);
    socket.emit("toggle_student_interaction", { roomId, allowed: true });
    setInteractionAsk(null);
    showNotif('🖐️ Students can now interact with the simulation');
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
    // Auto-dismiss after 30s. Reset any prior timer so a re-sent check gets a
    // fresh 30s window instead of being dismissed early by the previous one.
    if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current);
    attentionTimerRef.current = setTimeout(() => setAttentionCheckActive(false), 30000);
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
    packRef.current.addArtifact('explanation', safeName, trimmed);
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

  // Close ≠ discard. The explanation stays in the strip so it can be reopened
  // without hunting for the file again — the thing that used to force a
  // re-upload every single time.
  const clearTempContent = () => {
    if (!socket) return;
    socket.emit('clear_temp_content', { roomId });
    packRef.current.note('Closed the explainer, back to the lesson');
    setShowTempContent(false);
    setActiveExplanationId(null);
    showNotif('↩️ Back to main content');
  };

  // ── Class pack: collect the lesson while it happens ──
  // Keep the pack's header current, so a download names the right people even
  // if the teacher never opens anything else.
  useEffect(() => {
    packRef.current.meta = { room: roomId || '', teacher: teacherName, student: users.find(u => u.role === 'student')?.name };
  }, [roomId, teacherName, users]);

  // Whatever lesson is actually ON SCREEN goes into the pack. Hooked here
  // rather than at the four separate upload/paste/library/reopen call sites,
  // because they all funnel through this state and a fifth path added later
  // would otherwise be silently missed. ClassPack de-duplicates, so a
  // re-render reporting the same lesson costs nothing.
  useEffect(() => {
    if (!previewHtml) return;
    const name = files.find(f => f.id === activeFileId)?.name || 'Lesson';
    packRef.current.addArtifact('lesson', name, previewHtml);
    setPackCounts(packRef.current.counts);
  }, [previewHtml, activeFileId, files]);

  // Snapshot whichever surface is in front, on a slow tick. ClassPack drops
  // anything taken too soon or identical to the last one, so this can be dumb
  // and regular. Two surfaces matter: the board, and the HTML lesson WITH the
  // ink drawn over it — explaining over an HTML page is half of a lesson, and
  // the pack had no picture of it at all.
  const shootingRef = useRef(false);
  // The ink canvas that sits over the lesson iframe, handed out by
  // AnnotationLayer so a screenshot can include what was drawn on the page.
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const holdAnnotationCanvas = useCallback((c: HTMLCanvasElement | null) => { annotationCanvasRef.current = c; }, []);
  useEffect(() => {
    const tick = async () => {
      if (whiteboardMode) {
        const canvas = whiteboardRef.current?.getCanvas();
        if (canvas && packRef.current.offerSnapshot(canvas, 'Whiteboard')) {
          setPackCounts(packRef.current.counts);
        }
        return;
      }
      // Rasterising a page takes real time; never let two overlap.
      if (shootingRef.current) return;
      shootingRef.current = true;
      try {
        const shot = await captureLesson(iframeRef.current, annotationCanvasRef.current);
        const label = showTempContent ? (tempContent?.name ? `Explainer — ${tempContent.name}` : 'Explainer') : 'Lesson';
        if (shot && packRef.current.offerImage(shot.dataUrl, shot.width, shot.height, label)) {
          setPackCounts(packRef.current.counts);
        }
      } finally {
        shootingRef.current = false;
      }
    };
    const id = setInterval(() => { void tick(); }, 10_000);
    return () => clearInterval(id);
  }, [whiteboardMode, showTempContent, tempContent]);

  // Leaving the board is the moment its contents matter most — grab it before
  // the teacher switches away, whatever the tick schedule says.
  const captureBoardNow = useCallback((label: string) => {
    const canvas = whiteboardRef.current?.getCanvas();
    if (!canvas) return;
    if (packRef.current.offerSnapshot(canvas, label, { force: true })) {
      setPackCounts(packRef.current.counts);
    }
  }, []);

  /** Force a picture of whatever surface is in front, right now. */
  const captureSurfaceNow = useCallback(async (reason: 'session_end' | 'interactive_answered' | 'surface_changed' | 'session_start' = 'session_end') => {
    if (whiteboardMode) { captureBoardNow('Whiteboard (final)'); return; }
    const shot = await captureLesson(iframeRef.current, annotationCanvasRef.current);
    const label = showTempContent ? (tempContent?.name ? `Explainer — ${tempContent.name}` : 'Explainer') : 'Lesson';
    if (shot && packRef.current.offerImage(shot.dataUrl, shot.width, shot.height, label, { force: true, surfaceId: currentSurfaceRef.current, reason })) {
      setPackCounts(packRef.current.counts);
    }
  }, [whiteboardMode, showTempContent, tempContent, captureBoardNow]);

  // 1.2: arm capture at t=0.
  //
  // The board was only ever photographed once someone wrote on it, so a lesson
  // that opened on a pasted exercise and worked through it for fourteen minutes
  // produced its first frame at t=842s — an entire exercise with no visual
  // record at all, and no way for a reader to know it had been missed.
  //
  // Retried a few times because at mount the surface is often not painted yet;
  // a baseline frame of a blank canvas would be worse than none, since it looks
  // like evidence that the board was empty.
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const attempt = async () => {
      if (cancelled || tries >= 6) return;
      tries++;
      const before = packRef.current.counts.snapshots;
      await captureSurfaceNow('session_start');
      if (cancelled) return;
      if (packRef.current.counts.snapshots === before) setTimeout(attempt, 1500);
    };
    const first = setTimeout(attempt, 1200);
    return () => { cancelled = true; clearTimeout(first); };
  }, [captureSurfaceNow]);

  const startNarration = useCallback((announce: boolean) => {
    if (!narrationSupported() || narratorRef.current) return false;
    const n = new Narrator((text) => {
      packRef.current.addNarration(teacherName, text);
      setPackCounts(packRef.current.counts);
    });
    if (!n.start()) return false;
    narratorRef.current = n;
    setNarrationOn(true);
    packRef.current.note('Started capturing what was said');
    socket?.emit('narration_request', { roomId, on: true, elapsed: Date.now() - packRef.current.startedAt });
    if (announce) showNotif('🎙️ Capturing speech as text — your student is being asked too');
    return true;
  }, [socket, roomId, teacherName]);

  const stopNarration = useCallback((announce: boolean) => {
    narratorRef.current?.stop();
    narratorRef.current = null;
    setNarrationOn(false);
    packRef.current.note('Stopped capturing speech');
    socket?.emit('narration_request', { roomId, on: false, elapsed: Date.now() - packRef.current.startedAt });
    if (announce) showNotif('🎙️ Stopped capturing speech');
  }, [socket, roomId]);

  const toggleNarration = () => {
    if (!narrationOn && !narrationSupported()) {
      showNotif('🎙️ This browser cannot turn speech into text — try Chrome or Edge.');
      return;
    }
    // An explicit press is a decision worth remembering, in both directions.
    setNarrationChoice(roomId || '', narrationOn ? 'no' : 'yes');
    if (narrationOn) stopNarration(true);
    else if (!startNarration(true)) showNotif('🎙️ Could not start — check microphone permission.');
  };

  // ── Start it on its own ──
  // Reaching for a button mid-explanation is exactly when it gets forgotten,
  // and a forgotten switch means the lesson's context is simply gone. So the
  // moment a class is genuinely under way — a student is in the room — this
  // starts itself, unless the teacher has previously said no for this room.
  const autoNarrateTriedRef = useRef(false);
  useEffect(() => {
    if (autoNarrateTriedRef.current || narrationOn) return;
    if (!users.some(u => u.role === 'student')) return;      // no class yet
    if (getNarrationChoice(roomId || '') === 'no') return;   // they turned it off before
    if (!narrationSupported()) return;
    autoNarrateTriedRef.current = true;
    if (startNarration(false)) showNotif('🎙️ Writing down the lesson — press Listening to stop');
  }, [users, narrationOn, roomId, startNarration]);

  // The microphone must not keep listening after this page goes away.
  useEffect(() => () => { narratorRef.current?.stop(); narratorRef.current = null; }, []);

  // What the lesson page is SHOWING, sampled while it's the active surface.
  // Recorded only when the text changes, so a quiz advancing is captured and a
  // page sitting still costs nothing.
  useEffect(() => {
    if (whiteboardMode || showTempContent) return;
    const id = setInterval(() => {
      try {
        const doc = iframeRef.current?.contentDocument;
        const text = doc?.body?.innerText || '';
        if (text && packRef.current.offerLessonState(text, 'Lesson')) setPackCounts(packRef.current.counts);
      } catch { /* cross-origin or not loaded yet */ }
    }, 5_000);
    return () => clearInterval(id);
  }, [whiteboardMode, showTempContent]);

  // Keep the surface registry and the change events that let the JSON say what
  // was on screen when each line was spoken.
  useEffect(() => {
    const t = (Date.now() - packRef.current.startedAt) / 1000;
    let id: string;
    if (whiteboardMode) id = 'wb_1';
    else if (showTempContent && activeExplanationId) id = `exp_${activeExplanationId}`;
    else id = 'lesson_1';
    if (currentSurfaceRef.current === id) return;
    currentSurfaceRef.current = id;
    if (!packSurfacesRef.current.some(sf => sf.id === id)) {
      packSurfacesRef.current.push({
        id,
        type: whiteboardMode ? 'whiteboard' : (showTempContent ? 'explainer' : 'lesson'),
        title: showTempContent ? (tempContent?.name ?? null) : null,
      });
    }
    packEventsRef.current.push({ t, type: 'surface_changed', surface_id: id });
    // 1.2: a baseline frame of the surface we just moved to. Without this the
    // first record of a surface is whenever someone happened to write on it —
    // which is how a fixture ended up with fourteen minutes of board work and
    // no picture of any of it.
    void captureSurfaceNow('surface_changed');
  }, [whiteboardMode, showTempContent, activeExplanationId, tempContent, captureSurfaceNow]);

  // ── P0-2: read the explainer for what it teaches ──
  // Done while the page is on screen, because the DOM is the only place the
  // rendered content exists; the raw document is stylesheet and script.
  useEffect(() => {
    if (whiteboardMode) return;
    const timer = setTimeout(() => {
      try {
        const doc = iframeRef.current?.contentDocument;
        if (!doc || !doc.body) return;
        const surfaceId = currentSurfaceRef.current;
        const title = explainerTitle(doc as any, tempContent?.name ?? null);
        const sections = outlineExplainer(doc as any);
        if (sections.length === 0) return;
        const existing = packOutlinesRef.current.findIndex(o => o.surface_id === surfaceId);
        const outline = { surface_id: surfaceId, title, sections, source_ref: null };
        if (existing >= 0) packOutlinesRef.current[existing] = outline;
        else packOutlinesRef.current.push(outline);
        // Questions she never touched still belong in the record.
        packInteractivesRef.current = withUnattempted(doc as any, surfaceId, packInteractivesRef.current);
      } catch { /* cross-origin or not loaded */ }
    }, 1200);
    return () => clearTimeout(timer);
  }, [whiteboardMode, showTempContent, tempContent, previewHtml, iframeDocNonce]);

  // ── Surviving a reload ──
  // Pull the student's record once, so the pack can say who this hour was for.
  // Deliberately silent on failure — an ad-hoc room has no record, and a lesson
  // must never wait on, or be broken by, a profile lookup.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    (async () => {
      // The student list comes FIRST and does not depend on this room being a
      // registered class. It used to: an ad-hoc room returned early here, so a
      // signed-in tutor sitting in one saw no switcher at all and had no way to
      // reach the students they do have.
      try {
        const { listClasses } = await import('../lib/classes');
        const rows = await listClasses();
        if (!cancelled) setMyClasses(rows.filter(r => r.room_code !== roomId));
      } catch { /* not signed in, or no classes yet */ }

      try {
        const found = await getClassByRoomCode(roomId);
        if (cancelled || !found) return;
        classRowRef.current = {
          grade: found.grade ?? null,
          level: found.level ?? null,
          goals: parseGoals(found.goals ?? ''),
          textbook: found.textbook ?? null,
        };
        setClassId(found.id);
        setClassStudent(found.student_name);
        try {
          const { listSessions, findSessionForDay, lessonDay } = await import('../lib/sessions');
          const rows = await listSessions(found.id);
          if (cancelled) return;
          setMySessions(rows);
          // If today already has a saved lesson, this room is continuing it —
          // so saving writes back to that row instead of starting a second one.
          const today = findSessionForDay(rows, lessonDay(new Date().toISOString()));
          if (today) {
            setCurrentSessionId(today.id);
            // A reload mid-lesson must not restart the clock at zero, or a
            // tutor who refreshes loses the hour they just taught.
            teachingClockRef.current.resume(today.taught_seconds ?? 0);
          }
        } catch { /* no history yet */ }
      } catch { /* not a registered class, or the columns aren't there yet */ }
    })();
    return () => { cancelled = true; };
  }, [roomId]);

  // The pack is the lesson's only record while the lesson runs. Losing it to a
  // refresh at minute 40 is unrecoverable, because the lesson is over. Restore
  // anything already captured for this room today, then keep saving.
  const [packRestored, setPackRestored] = useState(false);

  useEffect(() => {
    if (askedBefore || !packRestored) return;
    const t = setTimeout(() => {
      // Only if it is still unanswered — a restored pack already has it.
      setPrompt(cur => (cur === null && !intentBefore.trim() ? 'before' : cur));
      setAskedBefore(true);
    }, 4000);
    return () => clearTimeout(t);
  }, [askedBefore, packRestored, intentBefore]);

  useEffect(() => {
    if (!roomId || packRestored) return;
    let cancelled = false;
    (async () => {
      const stored = await loadPack(packKey(roomId, Date.now()));
      if (cancelled || !stored) { setPackRestored(true); return; }
      const revived = ClassPack.fromState(stored.state);
      if (revived) {
        packRef.current = revived;
        setPackCounts(revived.counts);
        setHomeworkItems([...revived.allHomework]);
        const side = stored.side;
        if (side) {
          packEventsRef.current = (side.events as typeof packEventsRef.current) || [];
          if (Array.isArray(side.surfaces) && side.surfaces.length) packSurfacesRef.current = side.surfaces as typeof packSurfacesRef.current;
          packOutlinesRef.current = (side.outlines as typeof packOutlinesRef.current) || [];
          packInteractivesRef.current = (side.interactives as typeof packInteractivesRef.current) || [];
          packAttemptsRef.current = (side.attempts as typeof packAttemptsRef.current) || [];
          if (side.intentBefore) setIntentBefore(side.intentBefore);
          if (side.noteAfter) setNoteAfter(side.noteAfter);
        }
        showNotif(`📦 Picked up this lesson's record again — ${revived.counts.snapshots} snapshots, ${revived.counts.narration} spoken lines`);
      }
      setPackRestored(true);
      // These hold a student's work; don't let them pile up on a shared machine.
      void prunePacks();
    })();
    return () => { cancelled = true; };
  }, [roomId, packRestored]);

  // Save on a slow tick and whenever the page is being hidden — the latter is
  // what actually catches a closing tab, since unload gives no time for async.
  useEffect(() => {
    if (!roomId || !packRestored) return;
    const write = () => {
      const pack = packRef.current;
      if (pack.isEmpty) return;
      void savePack({
        key: packKey(roomId, pack.startedAt),
        room: roomId,
        startedAt: pack.startedAt,
        savedAt: Date.now(),
        state: pack.toState(),
        // The side tables too: without them a reload kept the board and the
        // transcript but lost every answered question.
        side: {
          events: packEventsRef.current,
          surfaces: packSurfacesRef.current,
          outlines: packOutlinesRef.current,
          interactives: packInteractivesRef.current,
          attempts: packAttemptsRef.current,
          intentBefore, noteAfter,
          teacher: teacherName,
          student: users.find(u => u.role === 'student')?.name ?? null,
          timezones: { ...participantTzRef.current, ...(localTimezone() ? { [teacherName]: localTimezone()! } : {}) },
          textbook: classRowRef.current?.textbook ?? null,
          subject: myClasses.find(c => c.room_code === roomId)?.label ?? null,
          studentProfile: classRowRef.current
            ? { grade: classRowRef.current.grade, level: classRowRef.current.level, goals: classRowRef.current.goals }
            : null,
        },
      });
    };
    const id = setInterval(write, 20_000);
    document.addEventListener('visibilitychange', write);
    window.addEventListener('pagehide', write);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', write);
      window.removeEventListener('pagehide', write);
      write();
    };
  }, [roomId, packRestored, intentBefore, noteAfter, teacherName, users]);

  // ── P0-3: snapshot when the board actually CHANGES ──
  // A timer produced runs of near-identical frames and missed the moments that
  // mattered. Ink is stored as vectors, so "a stroke was committed" is a real
  // signal, and the same vectors give the box around what is new.
  const captureBoardIfInkChanged = useCallback((reason: 'ink_committed' | 'surface_changed' | 'session_end') => {
    const wb = whiteboardRef.current;
    const canvas = wb?.getCanvas();
    if (!wb || !canvas) return false;
    const strokes = wb.getStrokes() || [];
    const fresh = newStrokesSince(seenStrokeIdsRef.current, strokes);
    if (fresh.length === 0 && reason === 'ink_committed') return false;

    let bbox: [number, number, number, number] | null = null;
    let delta: string | null = null;
    const board = strokeBounds(fresh);
    if (board) {
      const screen = boardRectToScreen(board, wb.getView());
      bbox = padRect(screen, 24, canvas.width, canvas.height);
      delta = cropCanvas(canvas, bbox);
    }
    const took = packRef.current.offerSnapshot(canvas, 'Whiteboard', {
      force: reason !== 'ink_committed',
      surfaceId: currentSurfaceRef.current.startsWith('wb') ? currentSurfaceRef.current : 'wb_1',
      reason,
      inkBbox: bbox,
      inkDeltaDataUrl: delta,
    });
    if (took) {
      for (const st of strokes) if (st.id) seenStrokeIdsRef.current.add(st.id);
      setPackCounts(packRef.current.counts);
    }
    return took;
  }, []);

  // Poll for committed strokes. The whiteboard has no "stroke committed" event
  // to subscribe to, and adding one would mean threading a callback through a
  // 4700-line component; comparing the stroke LIST is equivalent and cheaper to
  // reason about. Frequent and cheap — it only reads an array length.
  useEffect(() => {
    if (!whiteboardMode) return;
    let last = -1;
    const id = setInterval(() => {
      const n = whiteboardRef.current?.getStrokes()?.length ?? 0;
      if (n !== last) {
        last = n;
        // Let the stroke settle before grabbing the frame.
        setTimeout(() => { captureBoardIfInkChanged('ink_committed'); }, 400);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [whiteboardMode, captureBoardIfInkChanged]);

  // ── P0-1: which option did she actually click? ──
  // One delegated listener on the same-origin explainer sees both people's
  // answers, because a student's click is replayed inside this very iframe.
  useEffect(() => {
    if (whiteboardMode) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const onClick = (e: Event) => {
      try {
        const target = e.target as unknown as import('../lib/explainerOutline').ElLike;
        const block = closestQuestionBlock(target);
        if (!block) return;
        const qid = block.getAttribute('data-question-id') || block.getAttribute('data-question');
        const promptEl = block.querySelector('[data-prompt],.prompt,.question-text,h3,h4,p');
        const { index, options } = optionIndexOf(block, target);
        if (index === null) return;                       // not an option, just a click inside
        const declared = block.getAttribute('data-correct');
        const correctIndex = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
        // Read the verdict AFTER the page's own handler has run.
        setTimeout(() => {
          const correct = readCorrectness(target, block);
          const by: 'tutor' | 'student' = (Date.now() - lastForwardedInputRef.current) < 1500 ? 'student' : 'tutor';
          packAttemptsRef.current.push({
            questionId: qid || `q_${(promptEl?.textContent || '').slice(0, 24).replace(/\W+/g, '_') || index}`,
            prompt: (promptEl?.textContent || '').replace(/\s+/g, ' ').trim(),
            options, correctIndex, optionIndex: index, correct,
            widget: block.getAttribute('data-widget') || 'multiple_choice',
            by, t: (Date.now() - packRef.current.startedAt) / 1000,
          });
          packRef.current.note(`${by === 'student' ? 'Student' : 'Tutor'} answered ${qid || 'a question'}`);
          // An answer is a moment worth a picture.
          void captureSurfaceNow('interactive_answered');
          setPackCounts(packRef.current.counts);
        }, 120);
      } catch { /* never let instrumentation break a lesson */ }
    };
    doc.addEventListener('click', onClick, true);
    return () => { try { doc.removeEventListener('click', onClick, true); } catch { /* gone */ } };
  }, [whiteboardMode, showTempContent, tempContent, previewHtml, iframeDocNonce]);

  /**
   * Attach last lesson's worksheet, or the student's attempt at it.
   *
   * Photos are downscaled before they go anywhere near the pack: a phone
   * snapshot of a worksheet is several megabytes, and a dozen of those would
   * make the archive unusable while adding nothing a reader can see.
   */
  const attachHomework = async (file: File, kind: HomeworkItem['kind']) => {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { showNotif('⚠️ That file is very large (max 25MB)'); return; }
    try {
      const isImage = /^image\//.test(file.type);
      let item: HomeworkItem;
      if (isImage) {
        const shrunk = await shrinkImage(file, 1600);
        item = { kind, name: file.name, mime: 'image/jpeg', dataUrl: shrunk.dataUrl, width: shrunk.width, height: shrunk.height, addedAt: Date.now() };
      } else {
        const b64 = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result || ''));
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        item = { kind, name: file.name, mime: file.type || 'application/octet-stream', bytesBase64: b64, addedAt: Date.now() };
      }
      packRef.current.addHomework(item);
      setHomeworkItems([...packRef.current.allHomework]);
      showNotif(kind === 'submission' ? `📎 Attached her attempt: ${file.name}` : `📎 Attached last worksheet: ${file.name}`);
    } catch (e) {
      showNotif(`⚠️ Could not attach that file (${e instanceof Error ? e.message : 'unknown'})`);
    }
  };

  /**
   * 1.1: ask for the closing note before exporting, once.
   *
   * The note is worth most in the ten seconds after a lesson ends and nothing
   * afterwards, so the export button is the only place it will ever reliably
   * be asked for. Skipping is one click and the export proceeds regardless —
   * a prompt that can block a tutor from getting their file would be traded
   * for the tutor never pressing the button again.
   */
  const [noteAsked, setNoteAsked] = useState(false);
  const requestClassPack = () => {
    if (packBusy) return;
    if (!noteAsked && !noteAfter.trim()) { setNoteAsked(true); setPrompt('after'); return; }
    void downloadClassPack();
  };

  const downloadClassPack = async () => {
    if (packBusy) return;
    setPackBusy(true);
    try {
      await captureSurfaceNow('session_end');
      captureBoardIfInkChanged('session_end');
      const pack = packRef.current;
      const studentName = users.find(u => u.role === 'student')?.name;
      pack.meta = {
        room: roomId || '', teacher: teacherName, student: studentName,
        intentBefore: intentBefore.trim() || undefined,
        noteAfter: noteAfter.trim() || undefined,
      };
      // The PDF prints the explainer's teaching content, not its source.
      pack.outlines = new Map(
        packOutlinesRef.current.map(o => [
          o.title || '',
          o.sections.map(sec => [sec.heading, ...sec.text,
            ...sec.worked_examples.flatMap(w => [w.title || 'Worked example', ...w.steps.map(st => '  - ' + st)]),
            ...sec.questions.flatMap(q => [q.prompt, ...q.options.map((o2, i) => `  ${i === q.correct_option_index ? '*' : '-'} ${o2}`)]),
          ].join('\n')).join('\n\n'),
        ]),
      );

      const pdfBlob = pack.buildPdf();
      const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
      const baseName = pack.suggestedFilename().replace(/\.pdf$/, '');

      // P0-1: fold the recorded clicks into one record per question.
      const interactives = summariseInteractives(
        packAttemptsRef.current, currentSurfaceRef.current, packInteractivesRef.current,
      );

      const raw = pack.allSnapshots.map((sn): RawSnapshot => ({
        t: sn.t, dataUrl: sn.dataUrl, width: sn.width, height: sn.height, label: sn.label,
        surfaceId: sn.surfaceId, reason: sn.reason, hasNewInk: sn.hasNewInk,
        inkBbox: sn.inkBbox, inkDeltaDataUrl: sn.inkDeltaDataUrl, scrollY: sn.scrollY,
      }));

      const inputs = {
        sessionId: `sess_${roomId}_${new Date(pack.startedAt).toISOString().slice(0, 10)}`,
        startedAt: pack.startedAt,
        endedAt: Date.now(),
        room: roomId || '',
        subject: subjectFor(myClasses.find(c => c.room_code === roomId)?.label),
        lessonNumber: null,
        participants: [
          // Our own zone we know first-hand; the student's arrived with their
          // join. Either may be absent, and null is the honest answer for a
          // browser that wouldn't say.
          { role: 'tutor' as const, id: `u_${slugId(teacherName)}`, display_name: teacherName, timezone: localTimezone() || null },
          ...(studentName ? [{ role: 'student' as const, id: `s_${slugId(studentName)}`, display_name: studentName, timezone: participantTzRef.current[studentName] || null }] : []),
        ],
        textbook: classRowRef.current?.textbook ?? null,
        studentProfile: classRowRef.current
          ? { grade: classRowRef.current.grade, level: classRowRef.current.level, goals: classRowRef.current.goals }
          : null,
        intentBefore: intentBefore.trim() || null,
        noteAfter: noteAfter.trim() || null,
        narration: pack.allNarration,
        events: [
          ...packEventsRef.current,
          ...pack.allMoments.map(m => ({ t: m.t / 1000, type: 'note' as const, text: m.text })),
        ],
        surfaces: packSurfacesRef.current,
        snapshots: raw,
        materials: pack.allArtifacts
          .filter(a => a.kind === 'lesson' || a.kind === 'explanation')
          .map((a, i) => ({
            id: `mat_${i + 1}`, type: (a.kind === 'lesson' ? 'lesson_page' : 'explainer') as 'lesson_page' | 'explainer',
            name: a.name, shownFrom: a.t / 1000, shownTo: null, source: 'in_lesson',
            sourceHtml: a.body ?? null, dataUrl: null,
          })),
        outlines: packOutlinesRef.current,
        interactives,
        homework: pack.allHomework.map(h => ({ kind: h.kind, name: h.name, mime: h.mime, dataUrl: h.dataUrl, bytesBase64: h.bytesBase64 })),
        duplicatesSuppressed: pack.suppressedCount,
        failures: [] as Array<{ what: string; why: string }>,
      };
      const json = buildPackJson(inputs);
      const zip = buildPackArchive(pdfBytes, json, inputs, baseName);

      const url = URL.createObjectURL(zip);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke late: Safari can still be reading the blob when the click returns.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      showNotif(`📦 Class pack saved — ${json.snapshots.length} snapshots, ${json.interactives.length} questions, ${json.transcript.length} spoken lines`);
    } catch (e) {
      showNotif(`⚠️ Could not build the class pack (${e instanceof Error ? e.message : 'unknown'})`);
    } finally {
      setPackBusy(false);
    }
  };

  const openExplanation = (id: string) => socket?.emit('explanation_show', { roomId, id });

  const deleteExplanation = (id: string) => {
    if (!socket) return;
    socket.emit('explanation_delete', { roomId, id });
    showNotif('🗑️ Explanation removed');
  };

  const clearExplanations = () => {
    if (!socket || explanations.length === 0) return;
    if (!window.confirm(`Remove all ${explanations.length} explanations? This can't be undone.`)) return;
    socket.emit('explanation_clear', { roomId });
    showNotif('🗑️ All explanations removed');
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
      // Capture the lesson currently on screen so the re-watch player can render
      // the right sim from t=0 (the recorder otherwise only logs interactions).
      if (previewHtmlRef.current) {
        sessionRecorder.record('lesson', { html: previewHtmlRef.current, seed: randomSeed, fileId: activeFileIdRef.current });
      }
      setIsRecording(true);
      showNotif("🔴 Recording started");
    }
  };

  const studentCount = users.filter(u => u.role === 'student').length;

  // Closing or reloading this tab ends the only running copy of the lesson.
  //
  // For a lesson that implements the state contract that is survivable — it is
  // put straight back. For one that does not, the class genuinely restarts from
  // the top, and the tutor deserves to be asked rather than to find out. The
  // browser shows its own wording here; all we control is whether it asks.
  useEffect(() => {
    if (studentCount === 0 || lessonResumable !== false) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [studentCount, lessonResumable]);

  // A different lesson answers for itself.
  useEffect(() => { setLessonResumable(null); }, [iframeUrl]);

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
    <div className={`h-screen flex flex-col overflow-hidden${whiteboardMode ? ' ml-board-open' : ''}`}
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDragging(false); }}
      onDrop={handleDrop}>
      {prompt && (
        <SessionPrompt
          kind={prompt}
          value={prompt === 'before' ? intentBefore : noteAfter}
          onChange={prompt === 'before' ? setIntentBefore : setNoteAfter}
          autoSkipS={prompt === 'before' ? 20 : 0}
          onDone={() => {
            const wasAfter = prompt === 'after';
            setPrompt(null);
            // Skipping the closing note must still export. The file is the
            // point; the note is a bonus we asked for once.
            if (wasAfter) void downloadClassPack();
          }}
        />
      )}

      {/* ═══ DROP OVERLAY ═══
          pointerEvents:'none' is load-bearing, not cosmetic. Being fixed+inset-0
          the overlay sits above everything, so with pointer events ON it became
          the drag target the moment it appeared: the page's dragleave never
          fired, and the DROP landed on the overlay instead of handleDrop. The
          overlay could then never dismiss itself — dropping a file (an image,
          say) left the whole app covered with no way out. Ignoring pointer
          events makes it purely visual; every drag event passes through to the
          handlers on the container that know how to clear it. Escape, a click,
          leaving the window, or a stalled drag also dismiss it (see effect). */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(249,250,251,0.95)', backdropFilter: 'blur(8px)', pointerEvents: 'none' }}>
          <div className="text-center animate-bounce-in">
            <div className="text-7xl mb-4">📂</div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent-indigo)' }}>Drop HTML files here</div>
            <div className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>They'll be added to your file library</div>
            <div className="text-xs mt-3" style={{ color: 'var(--text-muted)', opacity: 0.85 }}>
              Images go on the whiteboard — press <strong>Esc</strong> or click to cancel
            </div>
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

          {/* Who, and which lesson. Only for a signed-in tutor with a student
              record — an ad-hoc room has neither to switch between. */}
          {(classId || myClasses.length > 0) && (
            <>
              <div className="header-divider hidden sm:block" />
              <LessonSwitcher
                student={classStudent || 'Pick a student'}
                isClassRoom={!!classId}
                classes={myClasses}
                sessions={mySessions}
                currentSessionId={currentSessionId}
                busy={switchBusy}
                onPickStudent={switchToStudent}
                onPickLesson={switchToLesson}
                onNewLesson={startNewLesson}
              />
            </>
          )}

          <div className="header-divider hidden sm:block ml-viewmode-switch" />

          {/* View Mode Toggles */}
          <div className="ml-viewmode-switch" style={{ display: 'flex', gap: '2px' }}>
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
                      syncStatus={syncStatus}
                      onResync={resyncStudent}
                      onGrantControl={grantControl}
                      onPeek={peekAtStudent}
                      onScreenShare={askForScreen} />
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
      {/* What this lesson will and will not do, said before it is taught. */}
      {/* Can this lesson survive a reload? Only worth saying once a class is
          watching, and only when the answer is no. */}
      {lessonResumable === false && studentCount > 0 && (
        <div className="px-4 py-2 flex items-center justify-center gap-2 text-xs"
          style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>ℹ️ If you reload this tab, this lesson restarts from the beginning for everyone. It doesn't tell MathsLive where it has got to.</span>
        </div>
      )}
      {lessonIssues.length > 0 && (
        <div className="px-4 py-2.5" style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, maxWidth: 1100, margin: '0 auto' }}>
            <div style={{ flex: 1, display: 'grid', gap: 6 }}>
              {lessonIssues.map((iss, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45 }}>
                  <span style={{ flexShrink: 0, fontSize: 12 }}>
                    {iss.level === 'blocked' ? '⛔' : iss.level === 'warn' ? '⚠️' : 'ℹ️'}
                  </span>
                  <span>
                    <b style={{ color: 'var(--text-primary)' }}>{iss.title}</b>{' '}
                    <span style={{ color: 'var(--text-muted)' }}>{iss.detail}</span>
                  </span>
                </div>
              ))}
            </div>
            <button onClick={() => setLessonIssues([])}
              title="Dismiss"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: 2 }}>✕</button>
          </div>
        </div>
      )}
      {/* The lesson only streams while this tab is on screen — see the
          visibilitychange effect. Shown the moment it is not, so the tutor is
          never explaining to a class that stopped updating a minute ago. */}
      {tabHidden && studentCount > 0 && (
        <div className="px-4 py-2.5 flex items-center justify-center gap-3 text-sm font-semibold"
          style={{ background: '#FFFBEB', color: '#92400E', borderBottom: '1px solid #FCD34D' }}>
          <span>⚠️ This tab is in the background, so your class has stopped updating. Bring MathsLive back to the front to carry on.</span>
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
      <RoomStatusStrip
        expiresAt={expiresAt}
        claimed={claimed}
        claimedBy={claimedBy}
        savingBoard={savingBoard}
        onSaveBoard={() => {
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
        canSaveHistory={!!(auth.enabled && auth.user)}
        savingHistory={savingHistory}
        onSaveHistory={saveToHistory}
        slim={whiteboardMode}
      />

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
              myScreenOn={myScreenOn}
              onToggleMyScreen={() => (myScreenOn ? stopMyScreen(true) : void startMyScreen())}
              whiteboardMode={whiteboardMode}
              explanationActive={showTempContent && !!tempContent}
              explanationName={tempContent?.name ?? null}
              onUploadExplanation={() => setShowExplainModal(true)}
              onExitExplanation={clearTempContent}
              videoActive={videoActive}
              onShowVideo={() => setVideoPromptOpen(true)}
              onStopVideo={() => socket?.emit('video_close', { roomId })}
              onDownloadPack={requestClassPack}
              onOpenNotes={() => setShowHomework(true)}
              notesCount={homeworkItems.length}
              narrationOn={narrationOn}
              onToggleNarration={toggleNarration}
              packBusy={packBusy}
              packCount={packCounts.snapshots + packCounts.artifacts}
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

              {/* ── Explanation tabs ──
                  Every explanation the teacher has added this lesson, kept.
                  Closing one used to throw it away, so coming back to it meant
                  finding and uploading the same file again. Now: click to
                  reopen, × to delete, "＋ Add" for a new one. Hidden on the
                  whiteboard, which is its own surface. */}
              {!whiteboardMode && explanations.length > 0 && (
                <div className="absolute bottom-2 left-2 right-2 z-20 flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
                  <span className="ml-exp-tabs-label">Explanations</span>
                  {explanations.map((e) => {
                    const on = showTempContent && activeExplanationId === e.id;
                    return (
                      <span key={e.id} className={`ml-exp-tab${on ? ' is-on' : ''}`}>
                        <button
                          className="ml-exp-tab-open"
                          onClick={() => (on ? clearTempContent() : openExplanation(e.id))}
                          title={on ? `${e.name} — click to go back to the lesson` : `Show ${e.name} again`}
                        >
                          {e.name}
                        </button>
                        <button
                          className="ml-exp-tab-del"
                          onClick={() => deleteExplanation(e.id)}
                          aria-label={`Delete ${e.name}`}
                          title="Delete this explanation"
                        >×</button>
                      </span>
                    );
                  })}
                  <button className="ml-exp-tab-add" onClick={() => setShowExplainModal(true)} title="Add another explanation">
                    ＋ Add
                  </button>
                  {explanations.length > 1 && (
                    <button className="ml-exp-tab-clear" onClick={clearExplanations} title="Remove every explanation">
                      Clear all
                    </button>
                  )}
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

              {/* LESSON SURFACE — mounted for the whole session, exactly like
                  <Whiteboard> above and for exactly the same reason.
                  It used to share a ternary with the whiteboard and the
                  explanation, so opening either one UNMOUNTED it and destroyed
                  the running sim: a teacher on question 5 who showed an
                  explainer came back to question 1, every time.
                  Hidden with visibility rather than display:none, so the layout
                  box survives the round trip and every canvas inside it keeps
                  its measured size — a display:none iframe comes back at zero
                  width until something fires a resize, which is how a 3D scene
                  returns blank. */}
              {iframeUrl && (
                <div
                  className="w-full h-full flex"
                  style={lessonHidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
                  aria-hidden={lessonHidden || undefined}
                >
                  <div className={dualView ? "relative flex-1 border-r border-gray-300" : "relative w-full h-full"}>
                    {dualView && (
                      <div className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded text-xs font-semibold"
                        style={{ background: 'rgba(59,130,246,0.9)', color: '#fff' }}>
                        Teacher View
                      </div>
                    )}
                    <iframe ref={lessonFrameRef} src={iframeUrl} className="w-full h-full border-none"
                      style={{ background: '#ffffff' }}
                      onLoad={() => handleSurfaceLoad(lessonFrameRef.current, !lessonHidden)}
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
                      <iframe ref={mirrorIframeRef} src={mirrorFollowerUrl || undefined} className="w-full h-full border-none"
                        style={{ background: '#ffffff' }}
                        onLoad={handleMirrorLoad}
                        sandbox={LESSON_IFRAME_SANDBOX_VIEW_ONLY}
                        allow={LESSON_IFRAME_ALLOW}
                        allowFullScreen />
                      {/* Block all pointer interactions inside the mirror so it stays passive */}
                      <div className="absolute inset-0" style={{ pointerEvents: 'auto', cursor: 'not-allowed' }} />
                    </div>
                  )}
                </div>
              )}

              {/* EXPLANATION — an overlay ON TOP of the still-running lesson,
                  no longer a replacement for it. It carries the same script trio
                  as the lesson, so while it is showing it is the authoritative
                  mirror source and the lesson underneath is ignored (the relay
                  drops anything that is not the active surface). */}
              {showTempContent && tempContent && tempContentUrl && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 6 }}>
                  <iframe
                    ref={tempFrameRef}
                    src={tempContentUrl}
                    className="w-full h-full border-none"
                    style={{ background: '#ffffff' }}
                    onLoad={() => handleSurfaceLoad(tempFrameRef.current, true)}
                    sandbox={LESSON_IFRAME_SANDBOX}
                    allow={LESSON_IFRAME_ALLOW}
                    allowFullScreen
                  />
                </div>
              )}

              {!iframeUrl && !showTempContent && !whiteboardMode && (
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
                  // Ink belongs to the thing it was drawn on. Without this,
                  // notes made on an explanation stayed on screen over the
                  // lesson after closing it.
                  surface={showTempContent && activeExplanationId ? `exp:${activeExplanationId}` : 'main'}
                  onCanvasReady={holdAnnotationCanvas}
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

      {/* Face-to-face video, in a draggable window over the lesson. The teacher
          is the IMPOLITE side of the negotiation: if both press call at the
          same instant, the teacher's offer wins and the student yields, so the
          two never deadlock. */}
      <VideoCall socket={socket} roomId={roomId!} selfLabel="You" />

      {/* A YouTube clip over the top of everything — the teacher's playback is
          the one the room follows. */}
      <VideoOverlay
        socket={socket} roomId={roomId!} isTeacher
        promptOpen={videoPromptOpen}
        onPromptClose={() => setVideoPromptOpen(false)}
        onActiveChange={setVideoActive}
      />

      {/* ── "Anika is asking to interact" ──
          The other half of the student's locked-tap nudge. Sits high and
          centre with the fix one click away, because the whole point is that
          the teacher has forgotten and doesn't know it. Auto-hides itself once
          interaction is on, so it can't linger after the fact. */}
      {interactionAsk && !studentInteractionAllowed && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[86] animate-slide-down" style={{ maxWidth: '92vw' }}>
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--accent-indigo)', boxShadow: 'var(--shadow-xl)' }}>
            <span className="text-xl" aria-hidden="true">✋</span>
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
              <strong>{interactionAsk.studentName}</strong> is trying to use the lesson — it's still view-only.
            </span>
            <button onClick={allowStudentInteraction}
              className="px-3 py-1.5 text-xs rounded-lg font-semibold text-white shrink-0"
              style={{ background: 'var(--accent-indigo)' }}>
              Let them in
            </button>
            <button onClick={() => setInteractionAsk(null)}
              className="px-2 py-1 text-xs rounded-lg shrink-0"
              style={{ color: 'var(--text-secondary)' }}
              aria-label="Dismiss">✕</button>
          </div>
        </div>
      )}

      {/* ── Lesson notes and homework ──
          Everything the class pack needs that only the tutor knows: what this
          lesson was for, what came of it, last time's worksheet and her attempt
          at it. All optional; all of it makes the next worksheet better. */}
      <input
        ref={homeworkInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void attachHomework(file, homeworkKindRef.current);
          e.target.value = '';
        }}
      />
      {showHomework && (
        <div className="fixed inset-0 z-[92] flex items-start justify-center p-4 pt-16 overflow-y-auto"
          style={{ background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowHomework(false)}>
          <div className="w-full max-w-lg animate-bounce-in" onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-xl)' }}>
            <div className="px-5 pt-5 pb-1 flex items-center justify-between">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Lesson notes &amp; homework</div>
              <button onClick={() => setShowHomework(false)} className="px-2 py-1 text-sm rounded-lg"
                style={{ color: 'var(--text-secondary)' }} aria-label="Close">✕</button>
            </div>
            <div className="p-5 pt-3 flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>What this lesson is for</span>
                <textarea rows={2} value={intentBefore} onChange={(e) => setIntentBefore(e.target.value)}
                  placeholder="aiming to finish sets; homework should lean on interval notation"
                  className="w-full px-3 py-2 text-sm rounded-lg outline-none"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', lineHeight: 1.5 }} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Note after the lesson</span>
                <textarea rows={2} value={noteAfter} onChange={(e) => setNoteAfter(e.target.value)}
                  placeholder="still flipping the inequality when dividing by a negative"
                  className="w-full px-3 py-2 text-sm rounded-lg outline-none"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', lineHeight: 1.5 }} />
              </label>

              <div>
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>Homework</span>
                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Attach the worksheet you set last time and her attempt at it, and the pack
                  can be built knowing how the last one went instead of starting blind.
                </p>
                <div className="flex gap-2 mt-2.5">
                  <button
                    onClick={() => { homeworkKindRef.current = 'previous_worksheet'; homeworkInputRef.current?.click(); }}
                    className="flex-1 px-3 py-2 text-xs rounded-lg font-medium"
                    style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}>
                    ＋ Last worksheet
                  </button>
                  <button
                    onClick={() => { homeworkKindRef.current = 'submission'; homeworkInputRef.current?.click(); }}
                    className="flex-1 px-3 py-2 text-xs rounded-lg font-medium text-white"
                    style={{ background: 'var(--accent-indigo)' }}>
                    ＋ Her attempt
                  </button>
                </div>
                {homeworkItems.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {homeworkItems.map((h) => (
                      <li key={`${h.kind}-${h.name}-${h.addedAt}`}
                        className="flex items-center gap-2 text-xs px-2.5 py-2 rounded-lg"
                        style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}>
                        <span aria-hidden="true">{h.kind === 'submission' ? '✍️' : '📄'}</span>
                        <span className="flex-1 truncate">{h.name}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {h.kind === 'submission' ? 'her attempt' : 'last worksheet'}
                        </span>
                        <button
                          onClick={() => { packRef.current.removeHomework(h.name, h.kind); setHomeworkItems([...packRef.current.allHomework]); }}
                          aria-label={`Remove ${h.name}`}
                          style={{ color: 'var(--text-secondary)' }}>✕</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ SAVE STATE ═══
          Quiet, permanent, and bottom-left because nothing else lives there:
          the point is that it can be glanced at mid-lesson, not that it is
          noticed. It only appears once there is a class to save into and at
          least one save has been attempted. */}
      {classId && saveState !== 'idle' && (
        <div className="fixed bottom-3 left-3 z-30 pointer-events-none select-none">
          <div
            className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5"
            style={{
              background: saveState === 'failed' ? 'rgba(190, 30, 45, 0.95)' : 'var(--bg-card)',
              color: saveState === 'failed' ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${saveState === 'failed' ? 'transparent' : 'var(--border-subtle)'}`,
              boxShadow: 'var(--shadow-sm)',
            }}
            title={saveState === 'failed'
              ? 'The lesson is still only on this screen. It is being retried; keep the tab open.'
              : "This lesson is saved to the student's history on the server."}
          >
            {saveState === 'saving' && <>Saving…</>}
            {saveState === 'saved' && lastSavedAt && (
              <>Saved {new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
            )}
            {saveState === 'failed' && <>Not saved — retrying</>}
          </div>
        </div>
      )}

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

      {screenShare && (
        <ScreenShareViewer
          studentName={screenShare.name}
          status={screenStatus}
          stream={screenStream}
          error={screenError}
          onClose={stopWatchingScreen}
          onRetry={() => askForScreen(screenShare.id, screenShare.name)}
        />
      )}

    </div>
  );
}
