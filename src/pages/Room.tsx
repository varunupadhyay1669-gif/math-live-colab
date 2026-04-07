import React, { useEffect, useState, useRef, useCallback } from "react";
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

interface UserInfo {
  id: string;
  name: string;
  role: string;
}

const CURSOR_COLORS = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"];

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const teacherName = searchParams.get('name') || 'Teacher';

  // ── View Mode ──
  type ViewMode = 'split' | 'code' | 'preview';
  const [viewMode, setViewMode] = useState<ViewMode>('split');

  // ── State ──
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [htmlCode, setHtmlCode] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [iframeUrl, setIframeUrl] = useState("");
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  const [isPaused, setIsPaused] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
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
  // ── Drawing/Annotation State ──
  const [drawMode, setDrawMode] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [penColor, setPenColor] = useState('#00ff88');
  const [penWidth, setPenWidth] = useState(3);
  const [showPenMenu, setShowPenMenu] = useState(false);
  // ── Laser Pointer ──
  const [laserMode, setLaserMode] = useState(false);
  const [localMousePos, setLocalMousePos] = useState({ x: 0, y: 0 });
  // ── Challenge Timer ──
  const [challengeTimer, setChallengeTimer] = useState<{ seconds: number; remaining: number } | null>(null);
  const [showTimerMenu, setShowTimerMenu] = useState(false);
  // ── Student Feedback ──
  const [studentFeedback, setStudentFeedback] = useState<Array<{ id: number; emoji: string; label: string; studentName: string }>>([]);
  const feedbackIdRef = useRef(0);
  // ── Celebration ──
  const [showCelebration, setShowCelebration] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const reactionIdRef = useRef(0);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const currentStrokeRef = useRef<Array<{x: number; y: number}>>([]);
  const strokesRef = useRef<Array<{points: Array<{x: number; y: number}>; color: string; width: number; time: number; transient?: boolean}>>([]);
  const isTransientDrawRef = useRef(false);
  const drawAnimFrameRef = useRef<number>();
  const challengeTimerRef = useRef<ReturnType<typeof setInterval>>();

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
      showNotif(`${data.userName} left the session`);
    });
    newSocket.on("file_uploaded", (file: FileEntry) => setFiles(prev => [...prev, file]));
    newSocket.on("file_updated", ({ fileId, html }: { fileId: string; html: string }) => {
      setFiles(prev => prev.map(f => f.id === fileId ? { ...f, html } : f));
    });
    newSocket.on("file_deleted", ({ fileId, newActiveId }: { fileId: string; newActiveId: string | null }) => {
      setFiles(prev => prev.filter(f => f.id !== fileId));
      if (newActiveId) setActiveFileId(newActiveId);
    });
    newSocket.on("active_file_changed", (fileId: string) => setActiveFileId(fileId));
    newSocket.on("run_preview", ({ html }: { fileId: string; html: string }) => setPreviewHtml(html));
    newSocket.on("chat_message", (msg: ChatMessage) => setChatMessages(prev => [...prev, msg]));
    newSocket.on("hand_raised", ({ studentName }: { studentName: string }) => {
      setHandRaised({ studentName });
      showNotif(`✋ ${studentName} raised their hand!`);
      setTimeout(() => setHandRaised(null), 8000);
    });
    newSocket.on("quiz_answer_received", ({ answer, studentName }: { answer: string; studentName: string }) => {
      setQuizAnswers(prev => [...prev, { answer, studentName }]);
      showNotif(`📝 ${studentName} answered!`);
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
      } else if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({ ...event, type: event.type.replace("SYNC_", "REMOTE_") }, "*");
      }
    });

    // ── Student Feedback Alerts ──
    newSocket.on("student_feedback", ({ emoji, label, studentName }: { emoji: string; label: string; studentName: string }) => {
      const id = feedbackIdRef.current++;
      setStudentFeedback(prev => [...prev, { id, emoji, label, studentName }]);
      showNotif(`${emoji} ${studentName}: ${label}`);
      setTimeout(() => setStudentFeedback(prev => prev.filter(f => f.id !== id)), 5000);
    });

    // ── Timer Events ──
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
  }, [roomId, navigate, teacherName]);

  // ── Relay iframe messages to socket ──
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!socket || !e.data?.type?.startsWith("SYNC_")) return;
      socket.emit("interaction", { roomId, event: e.data });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [socket, roomId]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  // ── Build iframe URL ──
  useEffect(() => {
    if (!previewHtml) { setIframeUrl(""); return; }
    let content = previewHtml;
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
    return () => URL.revokeObjectURL(url);
  }, [previewHtml]);

  // ── Sync code when active file changes ──
  useEffect(() => {
    if (activeFileId) {
      const file = files.find(f => f.id === activeFileId);
      if (file) { setHtmlCode(file.html); setPreviewHtml(file.html); }
    }
  }, [activeFileId]);

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
    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => /\.html?$/i.test(f.name));
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
    socket.emit("run_preview", { roomId, fileId: activeFileId, html: htmlCode });
    setPreviewHtml(htmlCode);
    showNotif("▶ Preview updated");
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
    navigator.clipboard.writeText(`${window.location.origin}/live/${roomId}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const sendReaction = (emoji: string) => {
    if (!socket) return;
    socket.emit("send_reaction", { roomId, emoji, fromName: teacherName });
    const id = reactionIdRef.current++;
    setReactions(prev => [...prev, { id, emoji }]);
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 2500);
  };

  const [penType, setPenType] = useState<'transient' | 'permanent'>('transient');

  // ── Drawing Functions ──
  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  };

  const startDraw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const isRightClick = e.button === 2 || e.buttons === 2;
    if (!drawMode && !laserMode) return;
    
    // In laser mode, left click does nothing. Only right click draws transient ink.
    // In draw mode, left click draws based on penType. Right click draws transient ink.
    if (!drawMode && !isRightClick) return;

    setIsDrawing(true);
    const pt = getCanvasCoords(e);
    currentStrokeRef.current = [pt];
    isTransientDrawRef.current = isRightClick ? true : (drawMode && penType === 'transient');
  };

  const moveDraw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const pt = getCanvasCoords(e);
    currentStrokeRef.current.push(pt);
    renderStrokes();
  };

  const endDraw = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const points = currentStrokeRef.current;
    if (points.length > 1 && socket) {
      const stroke = { points, color: penColor, width: penWidth, time: Date.now(), transient: isTransientDrawRef.current };
      strokesRef.current.push(stroke);
      socket.emit('draw_stroke', { roomId, points, color: penColor, width: penWidth, transient: isTransientDrawRef.current });
    }
    currentStrokeRef.current = [];
  };

  const clearDrawing = () => {
    strokesRef.current = [];
    renderStrokes();
    if (socket) socket.emit('draw_clear', { roomId });
  };

  const renderStrokes = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Match canvas resolution to display size
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

    // Render saved strokes with fade
    strokesRef.current = strokesRef.current.filter(s => {
      if (!s.transient) return true; // Permanent strokes live forever
      return (now - s.time) < 1000;  // Transient strokes die at 1000ms
    });
    strokesRef.current.forEach(stroke => {
      const age = now - stroke.time;
      let alpha = 1;
      let blur = 0;
      
      if (stroke.transient) {
        const fadeStart = 200;
        const fadeDuration = 800;
        alpha = age > fadeStart ? 1 - (age - fadeStart) / fadeDuration : 1;
        blur = 20; // Neon blur
      }

      if (alpha <= 0) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (stroke.transient) {
        ctx.shadowColor = stroke.color;
        ctx.shadowBlur = blur;
      } else {
        ctx.shadowBlur = 0; // Solid whiteboard pen
      }
      ctx.beginPath();
      stroke.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    });

    // Render current live stroke
    if (currentStrokeRef.current.length > 1) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = penColor;
      ctx.lineWidth = penWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = penColor;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      currentStrokeRef.current.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  };

  // Auto-fade animation loop
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      if (strokesRef.current.length > 0) renderStrokes();
      drawAnimFrameRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => { running = false; if (drawAnimFrameRef.current) cancelAnimationFrame(drawAnimFrameRef.current); };
  }, [penColor, penWidth]);

  // Receive remote strokes
  useEffect(() => {
    if (!socket) return;
    const handleStroke = (data: { points: Array<{x:number;y:number}>; color: string; width: number }) => {
      strokesRef.current.push({ ...data, time: Date.now() });
      renderStrokes();
    };
    const handleClear = () => { strokesRef.current = []; renderStrokes(); };
    socket.on('draw_stroke', handleStroke);
    socket.on('draw_clear', handleClear);
    return () => { socket.off('draw_stroke', handleStroke); socket.off('draw_clear', handleClear); };
  }, [socket]);

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

  const startChallengeTimer = (seconds: number) => {
    if (!socket) return;
    socket.emit('start_timer', { roomId, seconds });
    setShowTimerMenu(false);
  };

  const stopChallengeTimer = () => {
    if (!socket) return;
    socket.emit('stop_timer', { roomId });
    setChallengeTimer(null);
    if (challengeTimerRef.current) clearInterval(challengeTimerRef.current);
  };

  // ── Laser Pointer ──
  const handleLaserMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!laserMode && !drawMode) return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (laserMode) setLocalMousePos({ x, y });
    if (!laserMode || !socket) return;
    socket.emit('laser_pointer', { roomId, x, y, active: true });
  };

  const handleLaserLeave = () => {
    if (!socket) return;
    socket.emit('laser_pointer', { roomId, x: 0, y: 0, active: false });
  };

  // ── Celebration ──
  const triggerCelebration = () => {
    if (!socket) return;
    socket.emit('trigger_celebration', { roomId, type: 'confetti' });
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!socket || !chatInput.trim()) return;
    socket.emit("send_chat", { roomId, message: chatInput.trim(), userName: teacherName });
    setChatInput("");
  };

  const sendQuiz = () => {
    if (!socket || !quizQuestion.trim()) return;
    socket.emit("send_quiz", { roomId, question: quizQuestion.trim() });
    setQuizAnswers([]);
    setShowQuizModal(false);
    showNotif("🎯 Quiz sent!");
  };

  const togglePause = () => {
    if (!socket) return;
    if (isPaused) { socket.emit("resume_session", { roomId }); setIsPaused(false); }
    else { socket.emit("pause_session", { roomId }); setIsPaused(true); }
  };

  const studentCount = users.filter(u => u.role === 'student').length;
  const showLeftPanel = viewMode === 'split' || viewMode === 'code';
  const showPreview = viewMode === 'split' || viewMode === 'preview';

  // ── Styles as objects for cleanliness ──
  const s = {
    headerBtn: (active?: boolean, color?: string): React.CSSProperties => ({
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '6px 14px', borderRadius: '8px',
      fontSize: '12px', fontWeight: 600,
      border: `1px solid ${active ? (color || 'rgba(79,143,255,0.3)') : 'var(--border-subtle)'}`,
      background: active ? (color === 'emerald' ? 'rgba(52,211,153,0.12)' : 'rgba(79,143,255,0.1)') : 'var(--bg-card)',
      color: active ? (color === 'emerald' ? '#34d399' : '#4f8fff') : 'var(--text-secondary)',
      cursor: 'pointer', transition: 'all 0.2s',
    }),
    viewBtn: (active: boolean): React.CSSProperties => ({
      padding: '5px 12px', borderRadius: '6px',
      fontSize: '11px', fontWeight: 600,
      background: active ? 'rgba(79,143,255,0.15)' : 'transparent',
      color: active ? '#4f8fff' : 'var(--text-muted)',
      border: 'none', cursor: 'pointer', transition: 'all 0.2s',
    }),
    sidebarBtn: (highlight?: boolean): React.CSSProperties => ({
      width: '42px', height: '42px', borderRadius: '12px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '18px', border: `1px solid ${highlight ? 'rgba(139,92,246,0.3)' : 'var(--border-subtle)'}`,
      background: highlight ? 'rgba(139,92,246,0.1)' : 'var(--bg-card)',
      cursor: 'pointer', transition: 'all 0.15s',
    }),
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDragging(false); }}
      onDrop={handleDrop}>

      {/* ═══ GLOBAL DROP OVERLAY ═══ */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(7,8,10,0.92)' }}>
          <div className="text-center animate-bounce-in">
            <div className="text-7xl mb-4">📂</div>
            <div className="text-2xl font-bold" style={{ color: '#4f8fff' }}>Drop HTML files here</div>
            <div className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>They'll be added to your file library</div>
          </div>
        </div>
      )}

      {/* ═══ MINIMALIST APPLE-STYLE HEADER ═══ */}
      <div className="pt-6 px-6 shrink-0 z-40">
        <header className="flex items-center justify-between px-6 glass rounded-full"
          style={{ height: '60px', border: '1px solid rgba(255,255,255,0.08)' }}>

          {/* Left: Logo + Room */}
          <div className="flex items-center gap-6">
            <button onClick={() => navigate('/')} className="flex items-center gap-3 transition-opacity hover:opacity-70" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
              <span className="text-xl">🧮</span>
              <span className="font-semibold tracking-tight text-white/90 text-[17px]">MathsLive</span>
            </button>
            
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <span className="text-[10px] font-medium text-white/40 uppercase tracking-widest">Room</span>
              <span className="text-[13px] font-mono font-medium text-white/90">{roomId}</span>
            </div>
            
            {/* View Mode Toggles */}
            <div className="flex items-center rounded-full overflow-hidden p-1 ml-2" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <button onClick={() => setViewMode('code')} className="px-5 py-1.5 rounded-full text-[13px] font-medium transition-all" style={{ background: viewMode === 'code' ? 'white' : 'transparent', color: viewMode === 'code' ? 'black' : 'rgba(255,255,255,0.6)' }}>Code</button>
              <button onClick={() => setViewMode('split')} className="px-5 py-1.5 rounded-full text-[13px] font-medium transition-all" style={{ background: viewMode === 'split' ? 'white' : 'transparent', color: viewMode === 'split' ? 'black' : 'rgba(255,255,255,0.6)' }}>Split</button>
              <button onClick={() => setViewMode('preview')} className="px-5 py-1.5 rounded-full text-[13px] font-medium transition-all" style={{ background: viewMode === 'preview' ? 'white' : 'transparent', color: viewMode === 'preview' ? 'black' : 'rgba(255,255,255,0.6)' }}>Preview</button>
            </div>
          </div>

          {/* Right: Status + Actions */}
          <div className="flex items-center gap-2">
            {/* Challenge Timer */}
            <div className="relative">
              <button onClick={() => setShowTimerMenu(!showTimerMenu)} className="transition-all active:scale-95 px-4 py-1.5 rounded-full text-[13px] font-medium flex items-center gap-2"
                style={{ background: challengeTimer ? 'rgba(255,204,0,0.15)' : 'transparent', color: challengeTimer ? '#ffcc00' : 'rgba(255,255,255,0.8)' }}>
                {challengeTimer ? `⏱ ${challengeTimer.remaining}s` : 'Timer ⏱'}
              </button>
              {showTimerMenu && (
                <div className="absolute top-full right-0 mt-3 z-50 animate-slide-down glass rounded-2xl p-2 min-w-[140px] mac-shadow" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
                  {[30, 60, 90, 120, 180].map(sec => (
                    <button key={sec} onClick={() => startChallengeTimer(sec)} className="w-full text-left px-4 py-2 rounded-xl text-[13px] font-medium hover:bg-white/10 transition-all text-white/90">
                      ⏱ {sec >= 60 ? `${sec / 60} min` : `${sec}s`}
                    </button>
                  ))}
                  {challengeTimer && (
                    <button onClick={stopChallengeTimer} className="w-full text-left px-4 py-2 rounded-xl text-[13px] font-medium hover:bg-red-500/20 transition-all text-red-500 mt-1">
                      ✕ Stop Timer
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Celebration */}
            <button onClick={triggerCelebration} className="transition-all active:scale-95 hover:bg-white/10 flex items-center justify-center w-8 h-8 rounded-full" style={{ fontSize: '15px' }}>
              🎉
            </button>

            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full text-[13px] font-mono font-medium text-white/50">
              {formatTime(sessionTimer)}
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[13px] font-medium"
              style={{ color: studentCount > 0 ? '#34c759' : 'rgba(255,255,255,0.4)', background: studentCount > 0 ? 'rgba(52,199,89,0.1)' : 'transparent' }}>
              <div className={`connection-dot ${studentCount > 0 ? 'online' : 'offline'}`} style={{ width: 6, height: 6 }} />
              {studentCount}
            </div>

            <button onClick={copyStudentLink} className="transition-all active:scale-95 px-5 py-1.5 rounded-full text-[13px] font-medium flex items-center gap-2 ml-2"
              style={{ background: linkCopied ? '#34c759' : 'white', color: linkCopied ? 'white' : 'black', border: 'none' }}>
              {linkCopied ? 'Copied ✓' : 'Share 🔗'}
            </button>
          </div>
        </header>
      </div>

      {/* ═══ HAND RAISED BANNER ═══ */}
      {handRaised && (
        <div className="animate-slide-down px-4 py-2 text-center text-sm font-semibold" style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', borderBottom: '1px solid rgba(251,191,36,0.2)' }}>
          ✋ {handRaised.studentName} raised their hand!
        </div>
      )}

      {/* ═══ MAIN CONTENT ═══ */}
      <div className="flex-1 flex overflow-hidden px-4 pb-4 pt-2 gap-4">

        {/* ──── LEFT: Files + Code Editor ──── */}
        {showLeftPanel && (
          <div className="flex flex-col glass rounded-2xl overflow-hidden mac-shadow" style={{
            width: viewMode === 'code' ? '100%' : '40%', minWidth: viewMode === 'split' ? '320px' : undefined,
            transition: 'width 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
          }}>

            {/* Upload Bar */}
            <div className="flex items-center gap-3 px-5 py-4 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <input type="file" accept=".html,.htm" ref={fileInputRef} onChange={uploadFileFromInput} className="hidden" multiple />

              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-5 py-2 rounded-full text-[13px] font-medium transition-all hover:bg-white/90 active:scale-95"
                style={{ background: 'white', color: 'black' }}>
                Upload HTML
              </button>

              <button onClick={() => setShowPasteModal(true)} className="flex items-center gap-2 px-5 py-2 rounded-full text-[13px] font-medium transition-all hover:bg-white/10 active:scale-95"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'white' }}>
                Paste Code
              </button>

              <div className="flex-1" />
            </div>

            {/* File Tabs */}
            {files.length > 0 && (
              <div className="flex gap-2 px-4 py-2 overflow-x-auto shrink-0 scrollbar-hide" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                {files.map(f => (
                  <button key={f.id} onClick={() => switchFile(f.id)}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-full text-[13px] shrink-0 transition-all group"
                    style={{
                      background: activeFileId === f.id ? 'rgba(255,255,255,0.1)' : 'transparent',
                      color: activeFileId === f.id ? 'white' : 'rgba(255,255,255,0.5)',
                      fontWeight: activeFileId === f.id ? 600 : 400,
                    }}>
                    <span className="max-w-[120px] truncate">{f.name}</span>
                    <span onClick={(e) => { e.stopPropagation(); deleteFile(f.id); }}
                      className="opacity-0 group-hover:opacity-100 ml-1 hover:text-white cursor-pointer text-lg leading-none transition-opacity" style={{ color: 'rgba(255,255,255,0.3)' }}>
                      ×
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Code Area */}
            <div className="flex-1 flex flex-col overflow-hidden relative">
              {files.length === 0 ? (
                // Empty state: Upload prompt
                <div className="absolute inset-0 flex items-center justify-center p-8 bg-transparent">
                  <div className="text-center max-w-sm glass p-10 rounded-[32px] mac-shadow animate-slide-up" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
                    <div className="text-5xl mb-6 animate-float opacity-80" style={{ filter: 'grayscale(100%)' }}>📄</div>
                    <h3 className="text-2xl font-bold mb-3 text-white tracking-tight">No Simulation</h3>
                    <p className="text-[13px] mb-8 text-white/40 leading-relaxed font-medium">
                      Select a file from your device or paste an HTML snippet to begin.
                    </p>
                    <div className="flex flex-col gap-3 justify-center">
                      <button onClick={() => fileInputRef.current?.click()} className="py-3 px-6 rounded-full font-medium transition-all active:scale-95 text-black text-[14px]"
                        style={{ background: 'white' }}>
                        Browse Files
                      </button>
                      <button onClick={() => setShowPasteModal(true)} className="py-3 px-6 rounded-full font-medium transition-all active:scale-95 hover:bg-white/10 text-[14px]"
                        style={{ background: 'rgba(255,255,255,0.05)', color: 'white' }}>
                        Paste Snippet
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Editor header with Run button */}
                  <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span className="text-[11px] font-medium tracking-widest text-white/30 uppercase">
                      {files.find(f => f.id === activeFileId)?.name || 'Editor'}
                    </span>
                    <div className="flex items-center gap-4">
                      <span className="text-[11px] font-mono text-white/20 hidden sm:inline">⌘ + Enter</span>
                      <button onClick={runPreview} className="flex items-center gap-1.5 px-5 py-1.5 rounded-full text-[13px] font-bold text-black transition-all hover:scale-105 active:scale-95"
                        style={{ background: 'white' }}>
                        ▶ Run
                      </button>
                    </div>
                  </div>
                  {/* Textarea editor */}
                  <textarea
                    value={htmlCode}
                    onChange={(e) => setHtmlCode(e.target.value)}
                    className="flex-1 w-full p-5 resize-none focus:outline-none code-editor"
                    style={{ background: 'rgba(0,0,0,0.2)', color: '#e2e8f0', caretColor: 'var(--accent-blue)', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', lineHeight: '1.6' }}
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
          <div className="flex-1 flex flex-col relative rounded-[32px] overflow-hidden bg-white mac-shadow" style={{ border: '1px solid rgba(0,0,0,0.05)' }}>

            {/* Preview Header */}
            <div className="shrink-0" style={{ background: '#ffffff', borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
              <div className="flex items-center justify-between px-6 py-3" style={{ minHeight: '50px' }}>
                <div className="flex items-center gap-4">
                  {/* Browser dots - Modern flat style */}
                  <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
                    <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
                    <div className="w-3 h-3 rounded-full bg-[#27c93f]" />
                  </div>
                  <span className="text-[13px] font-semibold tracking-tight text-black/60">
                    {isPaused && <span className="text-red-500 mr-2 animate-pulse">⏸ Paused</span>}
                    {files.find(f => f.id === activeFileId)?.name || 'Preview'}
                  </span>
                </div>
                
                <div className="flex items-center gap-1 p-1 rounded-full" style={{ background: 'rgba(0,0,0,0.04)' }}>
                  {/* Cursor Toggle (Removes Pen/Laser so you can interact) */}
                  <button onClick={() => { setDrawMode(false); setLaserMode(false); }} 
                    className="transition-all active:scale-95 px-5 py-1.5 rounded-full text-[12px] font-bold" style={{
                    background: (!drawMode && !laserMode) ? 'white' : 'transparent',
                    color: (!drawMode && !laserMode) ? 'black' : 'rgba(0,0,0,0.5)', cursor: 'pointer',
                    boxShadow: (!drawMode && !laserMode) ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
                  }}>
                    Cursor
                  </button>
                  {/* Disappearing Pen Toggle */}
                  <button onClick={() => { setDrawMode(true); setPenType('transient'); setLaserMode(false); }} 
                    className="transition-all active:scale-95 px-5 py-1.5 rounded-full text-[12px] font-bold" style={{
                    background: (drawMode && penType === 'transient') ? 'black' : 'transparent',
                    color: (drawMode && penType === 'transient') ? 'white' : 'rgba(0,0,0,0.5)', cursor: 'pointer',
                  }}>
                    Pen
                  </button>
                  {/* Permanent Pen Toggle */}
                  <button onClick={() => { setDrawMode(true); setPenType('permanent'); setLaserMode(false); }} 
                    className="transition-all active:scale-95 px-5 py-1.5 rounded-full text-[12px] font-bold" style={{
                    background: (drawMode && penType === 'permanent') ? 'black' : 'transparent',
                    color: (drawMode && penType === 'permanent') ? 'white' : 'rgba(0,0,0,0.5)', cursor: 'pointer',
                  }}>
                    PP
                  </button>
                  {/* Laser Pointer Toggle */}
                  <button onClick={() => { setLaserMode(true); setDrawMode(false); }} 
                    className="transition-all active:scale-95 px-5 py-1.5 rounded-full text-[12px] font-bold" style={{
                    background: laserMode ? '#ef4444' : 'transparent',
                    color: laserMode ? 'white' : 'rgba(0,0,0,0.5)', cursor: 'pointer',
                  }}>
                    Laser
                  </button>
                  {/* Pause Button */}
                  <button onClick={togglePause} className="transition-all active:scale-95 px-5 py-1.5 rounded-full text-[12px] font-bold" style={{
                    background: isPaused ? 'rgba(0,0,0,0.06)' : 'transparent',
                    color: isPaused ? '#ef4444' : 'rgba(0,0,0,0.5)', cursor: 'pointer',
                  }}>
                    {isPaused ? '▶ Play' : '⏸ Pause'}
                  </button>
                </div>
              </div>
              
              {/* Pen Controls Row */}
              {drawMode && (
                <div className="flex items-center gap-4 px-6 py-2 animate-slide-down" style={{ background: '#fafafa', borderTop: '1px solid rgba(0,0,0,0.02)' }}>
                  <div className="flex gap-2">
                    {['#34c759', '#ff3b30', '#ffcc00', '#007aff', '#af52de', '#000000'].map(c => (
                      <button key={c} onClick={() => setPenColor(c)} className="transition-all active:scale-90" style={{
                        width: 20, height: 20, borderRadius: '50%',
                        background: c, cursor: 'pointer',
                        transform: penColor === c ? 'scale(1.2)' : 'scale(1)',
                        boxShadow: penColor === c ? '0 0 0 2px white, 0 0 0 4px rgba(0,0,0,0.1)' : 'none',
                      }} />
                    ))}
                  </div>
                  <div style={{ width: '1px', height: '16px', background: 'rgba(0,0,0,0.1)', margin: '0 4px' }} />
                  <select value={penWidth} onChange={(e) => setPenWidth(Number(e.target.value))} className="font-semibold outline-none" style={{
                    background: 'transparent', color: 'black', border: 'none',
                    fontSize: '12px', cursor: 'pointer'
                  }}>
                    <option value={2}>Thin</option>
                    <option value={4}>Medium</option>
                    <option value={7}>Thick</option>
                  </select>
                  <div className="flex-1" />
                  <button onClick={clearDrawing} className="transition-all active:scale-95 px-4 py-1.5 rounded-full text-[12px] font-semibold text-black hover:bg-black/5" style={{ cursor: 'pointer' }}>
                    Clear Board
                  </button>
                </div>
              )}
            </div>

            {/* Iframe */}
            <div className="flex-1 relative overflow-hidden bg-[#fafafa]">
              {iframeUrl ? (
                <iframe ref={iframeRef} src={iframeUrl} className="w-full h-full border-none"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock" />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center opacity-40">
                    <div className="text-6xl mb-4" style={{ filter: 'grayscale(100%)' }}>🎯</div>
                    <h3 className="text-xl font-bold tracking-tight text-black">Preview Environment</h3>
                  </div>
                </div>
              )}

              {/* Drawing Canvas Overlay */}
              <canvas
                ref={drawCanvasRef}
                className="absolute inset-0 w-full h-full"
                style={{
                  cursor: drawMode ? 'crosshair' : laserMode ? 'none' : 'default',
                  pointerEvents: (drawMode || laserMode) ? 'auto' : 'none',
                  zIndex: 10,
                }}
                onMouseDown={startDraw}
                onMouseMove={(e) => { moveDraw(e); handleLaserMove(e); }}
                onMouseUp={endDraw}
                onMouseLeave={(e) => { endDraw(); handleLaserLeave(); }}
                onContextMenu={(e) => e.preventDefault()}
                onWheel={(e) => {
                  if (iframeRef.current?.contentWindow) {
                    iframeRef.current.contentWindow.scrollBy(e.deltaX, e.deltaY);
                  }
                }}
              />

              {/* Teacher's Own Laser Pointer Overlay */}
              {laserMode && (
                <div className="absolute inset-0 pointer-events-none z-20">
                  <div className="absolute w-4 h-4 rounded-full"
                    style={{
                      left: `${localMousePos.x * 100}%`, top: `${localMousePos.y * 100}%`,
                      transform: 'translate(-50%, -50%)',
                      background: 'rgba(239,68,68,0.9)',
                      boxShadow: '0 0 12px 6px rgba(239,68,68,0.6)',
                      animation: 'laser-pulse 1s infinite',
                    }} />
                </div>
              )}

              {/* Cursors */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 11 }}>
                {(Object.entries(cursors) as [string, Cursor][]).map(([id, c]) => (
                  <div key={id} className="absolute transition-all duration-100 ease-linear" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, transform: 'translate(-2px,-2px)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill={c.color}><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.86a.5.5 0 0 0-.85.35Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/></svg>
                    <span className="absolute left-4 top-3 text-[9px] font-bold px-1.5 py-0.5 rounded-md text-white whitespace-nowrap" style={{ background: c.color }}>{c.name}</span>
                  </div>
                ))}
              </div>

              {/* Reactions */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {reactions.map(r => (
                  <div key={r.id} className="absolute" style={{ left: `${20 + Math.random() * 60}%`, bottom: '10%', fontSize: '44px', animation: 'reaction-float-up 2.5s ease-out forwards' }}>{r.emoji}</div>
                ))}
              </div>

              {/* ── Challenge Timer Overlay ── */}
              {challengeTimer && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none z-20 animate-bounce-in">
                  <div className="flex items-center gap-3 px-6 py-3 rounded-2xl" style={{
                    background: challengeTimer.remaining <= 10 ? 'rgba(239,68,68,0.9)' : 'rgba(0,0,0,0.8)',
                    backdropFilter: 'blur(10px)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                    animation: challengeTimer.remaining <= 5 ? 'pulse 0.5s ease-in-out infinite' : 'none',
                  }}>
                    <span className="text-2xl">⏱</span>
                    <span className="text-3xl font-black text-white tabular-nums">{challengeTimer.remaining}s</span>
                    <div className="w-24 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.2)' }}>
                      <div className="h-full rounded-full transition-all duration-1000 ease-linear" style={{
                        width: `${(challengeTimer.remaining / challengeTimer.seconds) * 100}%`,
                        background: challengeTimer.remaining <= 10 ? '#fbbf24' : '#10b981',
                      }} />
                    </div>
                  </div>
                </div>
              )}

              {/* ── Student Feedback Alerts ── */}
              <div className="absolute top-4 right-4 z-20 flex flex-col gap-2 pointer-events-none">
                {studentFeedback.map(f => (
                  <div key={f.id} className="animate-slide-in-right flex items-center gap-2 px-4 py-2 rounded-xl" style={{
                    background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)', boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                  }}>
                    <span className="text-xl">{f.emoji}</span>
                    <div>
                      <div className="text-[10px] font-bold" style={{ color: '#4f8fff' }}>{f.studentName}</div>
                      <div className="text-xs font-semibold text-white">{f.label}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Celebration Confetti ── */}
              {showCelebration && (
                <div className="absolute inset-0 pointer-events-none z-30 overflow-hidden">
                  {Array.from({ length: 60 }).map((_, i) => (
                    <div key={i} className="absolute" style={{
                      left: `${Math.random() * 100}%`, top: '-5%',
                      width: `${6 + Math.random() * 8}px`, height: `${6 + Math.random() * 8}px`,
                      background: ['#ff3366', '#00ff88', '#ffdd00', '#4f8fff', '#ff8800', '#8b5cf6', '#ec4899', '#06b6d4'][i % 8],
                      borderRadius: Math.random() > 0.5 ? '50%' : '2px',
                      animation: `confetti-fall ${2 + Math.random() * 2}s ease-in forwards`,
                      animationDelay: `${Math.random() * 0.8}s`,
                      transform: `rotate(${Math.random() * 360}deg)`,
                    }} />
                  ))}
                </div>
              )}

              {/* Paused Overlay */}
              {isPaused && (
                <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
                  <div className="text-center">
                    <div className="text-5xl mb-2">⏸</div>
                    <div className="text-lg font-bold text-white">Session Paused</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ──── RIGHT: Engagement Sidebar ──── */}
        <div className="flex flex-col shrink-0" style={{
          width: chatOpen ? '280px' : '52px',
          borderLeft: '1px solid var(--border-subtle)',
          background: 'var(--bg-secondary)',
          transition: 'width 0.25s ease',
        }}>
          {chatOpen ? (
            <div className="flex flex-col h-full animate-fade-in">
              <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <span className="text-[10px] font-bold" style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}>CHAT</span>
                <button onClick={() => setChatOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px' }}>✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {chatMessages.length === 0 && <p className="text-center text-xs py-8" style={{ color: 'var(--text-muted)' }}>No messages yet</p>}
                {chatMessages.map(msg => (
                  <div key={msg.id}>
                    <div className="text-[10px] font-bold mb-0.5" style={{ color: '#4f8fff' }}>{msg.userName}</div>
                    <div className="text-[13px] px-3 py-2" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', borderRadius: '4px 12px 12px 12px' }}>{msg.message}</div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={sendChat} className="p-2.5 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <div className="flex gap-2">
                  <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Message..."
                    className="input-field text-[13px]" style={{ padding: '7px 10px' }} />
                  <button type="submit" style={{
                    padding: '7px 12px', borderRadius: '8px', fontSize: '14px', fontWeight: 700,
                    background: 'rgba(79,143,255,0.12)', color: '#4f8fff', border: 'none', cursor: 'pointer',
                  }}>↑</button>
                </div>
              </form>
            </div>
          ) : (
            <div className="flex flex-col items-center py-3 gap-1.5">
              <button onClick={() => setChatOpen(true)} style={s.sidebarBtn()} title="Chat">💬</button>
              <div style={{ width: '24px', height: '1px', background: 'var(--border-subtle)', margin: '4px 0' }} />
              {['🎉', '✅', '🤔', '❌', '👏', '🔥'].map(emoji => (
                <button key={emoji} onClick={() => sendReaction(emoji)} style={s.sidebarBtn()}
                  className="hover:scale-110 active:scale-90 transition-transform">{emoji}</button>
              ))}
              <div style={{ width: '24px', height: '1px', background: 'var(--border-subtle)', margin: '4px 0' }} />
              <button onClick={() => setShowQuizModal(true)} style={s.sidebarBtn(true)} title="Pop Quiz">❓</button>
            </div>
          )}
        </div>
      </div>

      {/* ═══ NOTIFICATION ═══ */}
      {notification && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 animate-slide-down">
          <div className="glass px-5 py-2.5 rounded-xl text-sm font-medium shadow-xl" style={{ color: 'var(--text-primary)' }}>{notification}</div>
        </div>
      )}

      {/* ═══ PASTE CODE MODAL ═══ */}
      {showPasteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)' }}>
          <div className="w-full max-w-2xl animate-bounce-in" style={{ background: 'var(--bg-card)', borderRadius: '16px', border: '1px solid var(--border-default)' }}>
            <div className="flex items-center justify-between p-5 pb-0">
              <h3 className="text-lg font-bold">📋 Paste HTML Code</h3>
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
                style={{ minHeight: '250px', resize: 'vertical', lineHeight: '1.6' }} />
              <div className="flex gap-3 justify-end">
                <button onClick={() => { setShowPasteModal(false); setPasteCode(''); setPasteFileName(''); }} className="btn-secondary">Cancel</button>
                <button onClick={handlePasteSubmit} disabled={!pasteCode.trim()} className="btn-primary disabled:opacity-40">
                  Add & Run ▶
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ QUIZ MODAL ═══ */}
      {showQuizModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)' }}>
          <div className="w-full max-w-md animate-bounce-in" style={{ background: 'var(--bg-card)', borderRadius: '16px', border: '1px solid var(--border-default)' }}>
            <div className="p-5">
              <h3 className="text-lg font-bold mb-4">🎯 Pop Quiz</h3>
              <textarea value={quizQuestion} onChange={(e) => setQuizQuestion(e.target.value)}
                placeholder="Type your question... e.g. What is 3/4 + 1/2?"
                className="input-field mb-4" style={{ minHeight: '90px', resize: 'vertical' }} />
              {quizAnswers.length > 0 && (
                <div className="mb-4 p-3 rounded-xl" style={{ background: 'var(--bg-primary)' }}>
                  <div className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>ANSWERS RECEIVED</div>
                  {quizAnswers.map((a, i) => (
                    <div key={i} className="text-sm mb-1"><span style={{ color: '#4f8fff' }}>{a.studentName}:</span> {a.answer}</div>
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
    </div>
  );
}
