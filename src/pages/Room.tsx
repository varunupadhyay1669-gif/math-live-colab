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

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
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
    Array.from(uploadedFiles).forEach(file => {
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
    droppedFiles.forEach(file => {
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

      {/* ═══ HEADER ═══ */}
      <header className="flex items-center justify-between px-4 shrink-0"
        style={{ height: '52px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>

        {/* Left: Logo + Room */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-lg">🧮</span>
            <span className="font-bold text-sm">MathsLive</span>
          </div>
          <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>ROOM</span>
            <span className="text-xs font-mono font-bold" style={{ color: '#4f8fff' }}>{roomId}</span>
          </div>
          {/* View Mode Toggles */}
          <div className="flex items-center rounded-lg overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <button onClick={() => setViewMode('code')} style={s.viewBtn(viewMode === 'code')}>Code</button>
            <button onClick={() => setViewMode('split')} style={s.viewBtn(viewMode === 'split')}>Split</button>
            <button onClick={() => setViewMode('preview')} style={s.viewBtn(viewMode === 'preview')}>Preview</button>
          </div>
        </div>

        {/* Right: Status + Actions */}
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-mono" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
            ⏱ {formatTime(sessionTimer)}
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold"
            style={{ background: studentCount > 0 ? 'rgba(52,211,153,0.1)' : 'var(--bg-card)',
              border: `1px solid ${studentCount > 0 ? 'rgba(52,211,153,0.25)' : 'var(--border-subtle)'}`,
              color: studentCount > 0 ? '#34d399' : 'var(--text-muted)' }}>
            <div className={`connection-dot ${studentCount > 0 ? 'online' : 'offline'}`} style={{ width: 6, height: 6 }} />
            {studentCount} online
          </div>

          <button onClick={copyStudentLink} style={s.headerBtn(linkCopied, linkCopied ? 'emerald' : undefined)}>
            {linkCopied ? '✓ Copied' : '🔗 Share'}
          </button>
        </div>
      </header>

      {/* ═══ HAND RAISED BANNER ═══ */}
      {handRaised && (
        <div className="animate-slide-down px-4 py-2 text-center text-sm font-semibold" style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', borderBottom: '1px solid rgba(251,191,36,0.2)' }}>
          ✋ {handRaised.studentName} raised their hand!
        </div>
      )}

      {/* ═══ MAIN CONTENT ═══ */}
      <div className="flex-1 flex overflow-hidden">

        {/* ──── LEFT: Files + Code Editor ──── */}
        {showLeftPanel && (
          <div className="flex flex-col" style={{
            width: viewMode === 'code' ? '100%' : '42%', minWidth: viewMode === 'split' ? '300px' : undefined,
            borderRight: viewMode === 'split' ? '1px solid var(--border-subtle)' : 'none',
            transition: 'width 0.3s ease',
          }}>

            {/* Upload Bar */}
            <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
              <input type="file" accept=".html,.htm" ref={fileInputRef} onChange={uploadFileFromInput} className="hidden" multiple />

              <button onClick={() => fileInputRef.current?.click()} style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px',
                fontSize: '12px', fontWeight: 600, background: 'linear-gradient(135deg, #4f8fff 0%, #6366f1 100%)',
                color: 'white', border: 'none', cursor: 'pointer', transition: 'all 0.2s',
              }} className="hover:opacity-90 active:scale-95">
                📤 Upload HTML
              </button>

              <button onClick={() => setShowPasteModal(true)} style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px',
                fontSize: '12px', fontWeight: 600, background: 'var(--bg-card)',
                color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', cursor: 'pointer',
              }}>
                📋 Paste Code
              </button>

              <div className="flex-1" />

              <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                {files.length} file{files.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* File Tabs */}
            {files.length > 0 && (
              <div className="flex gap-1 px-3 py-1.5 overflow-x-auto shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {files.map(f => (
                  <button key={f.id} onClick={() => switchFile(f.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs shrink-0 transition-all group"
                    style={{
                      background: activeFileId === f.id ? 'rgba(79,143,255,0.12)' : 'transparent',
                      border: `1px solid ${activeFileId === f.id ? 'rgba(79,143,255,0.3)' : 'transparent'}`,
                      color: activeFileId === f.id ? '#4f8fff' : 'var(--text-muted)',
                      fontWeight: activeFileId === f.id ? 600 : 400,
                    }}>
                    <span style={{ fontSize: '10px' }}>📄</span>
                    <span className="max-w-[120px] truncate">{f.name}</span>
                    <span onClick={(e) => { e.stopPropagation(); deleteFile(f.id); }}
                      className="opacity-0 group-hover:opacity-100 ml-0.5 hover:text-red-400 cursor-pointer" style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                      ×
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Code Area */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {files.length === 0 ? (
                // Empty state: Upload prompt
                <div className="flex-1 flex items-center justify-center p-8">
                  <div className="text-center max-w-sm">
                    <div className="text-5xl mb-5 animate-float">📤</div>
                    <h3 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Add a Simulation</h3>
                    <p className="text-sm mb-6 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Upload an HTML file, paste code directly, or drag & drop anywhere
                    </p>
                    <div className="flex gap-3 justify-center">
                      <button onClick={() => fileInputRef.current?.click()} className="btn-primary text-sm" style={{ padding: '10px 20px' }}>
                        📤 Upload File
                      </button>
                      <button onClick={() => setShowPasteModal(true)} className="btn-secondary text-sm" style={{ padding: '10px 20px' }}>
                        📋 Paste HTML
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Editor header with Run button */}
                  <div className="flex items-center justify-between px-3 py-1.5 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                      {files.find(f => f.id === activeFileId)?.name || 'Editor'}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Ctrl+Enter</span>
                      <button onClick={runPreview} style={{
                        display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 14px', borderRadius: '7px',
                        fontSize: '12px', fontWeight: 700, background: 'linear-gradient(135deg, #10b981 0%, #06b6d4 100%)',
                        color: 'white', border: 'none', cursor: 'pointer',
                      }} className="active:scale-95 hover:opacity-90 transition-all">
                        ▶ Run
                      </button>
                    </div>
                  </div>
                  {/* Textarea editor */}
                  <textarea
                    value={htmlCode}
                    onChange={(e) => setHtmlCode(e.target.value)}
                    className="flex-1 w-full p-4 resize-none focus:outline-none code-editor"
                    style={{ background: 'var(--bg-primary)', color: '#c9d1d9', caretColor: '#4f8fff' }}
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
          <div className="flex-1 flex flex-col relative" style={{ background: '#ffffff' }}>

            {/* Preview Header */}
            <div className="flex items-center justify-between px-3 shrink-0" style={{ height: '36px', background: '#f5f6f8', borderBottom: '1px solid #e2e4ea' }}>
              <div className="flex items-center gap-2">
                {/* Browser dots */}
                <div className="flex gap-1.5">
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57' }} />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e' }} />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840' }} />
                </div>
                <span className="text-[11px] font-medium ml-2" style={{ color: '#6b7280' }}>
                  {isPaused && '⏸ PAUSED — '}{files.find(f => f.id === activeFileId)?.name || 'Preview'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={togglePause} className="transition-all active:scale-95" style={{
                  padding: '4px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
                  background: isPaused ? 'rgba(52,211,153,0.12)' : 'rgba(244,63,94,0.08)',
                  color: isPaused ? '#10b981' : '#f43f5e', border: 'none', cursor: 'pointer',
                }}>
                  {isPaused ? '▶ Resume' : '⏸ Pause'}
                </button>
              </div>
            </div>

            {/* Iframe */}
            <div className="flex-1 relative overflow-hidden">
              {iframeUrl ? (
                <iframe ref={iframeRef} src={iframeUrl} className="w-full h-full border-none"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock" />
              ) : (
                <div className="flex items-center justify-center h-full" style={{ background: '#fafbfc' }}>
                  <div className="text-center">
                    <div className="text-5xl mb-4">🎯</div>
                    <h3 className="text-lg font-bold" style={{ color: '#374151' }}>Upload & Run</h3>
                    <p className="text-sm mt-1" style={{ color: '#9ca3af' }}>Upload HTML, paste code, or drag & drop</p>
                  </div>
                </div>
              )}

              {/* Cursors */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {Object.entries(cursors).map(([id, c]) => (
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
