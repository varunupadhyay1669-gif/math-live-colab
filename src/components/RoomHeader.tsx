import React from 'react';
import { Socket } from 'socket.io-client';
import ConnectionStatus from './ConnectionStatus';
import UserList from './UserList';

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

interface RoomHeaderProps {
  roomId: string;
  viewMode: 'split' | 'code' | 'preview';
  setViewMode: (mode: 'split' | 'code' | 'preview') => void;
  socket: Socket | null;
  connected: boolean;
  sessionTimer: number;
  studentCount: number;
  showUserPanel: boolean;
  setShowUserPanel: (show: boolean) => void;
  users: UserInfo[];
  attention: Record<string, StudentAttention>;
  showShareMenu: boolean;
  setShowShareMenu: (show: boolean) => void;
  linkCopied: boolean;
  roomPassword?: string;
  saveRoomPassword: (pw: string) => void;
  copyStudentLink: () => void;
  setShowLibrary: (show: boolean) => void;
  isRecording: boolean;
  toggleRecording: () => void;
  soundMuted: boolean;
  setSoundMuted: (muted: boolean) => void;
  navigate: (path: string) => void;
}

export default function RoomHeader({
  roomId, viewMode, setViewMode, socket, connected, sessionTimer,
  studentCount, showUserPanel, setShowUserPanel, users, attention,
  showShareMenu, setShowShareMenu, linkCopied, roomPassword,
  saveRoomPassword, copyStudentLink, setShowLibrary,
  isRecording, toggleRecording, soundMuted, setSoundMuted, navigate
}: RoomHeaderProps) {

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <header className="app-header">
      <div className="header-section">
        <button onClick={() => navigate('/')} className="flex items-center hover:opacity-80 transition-opacity bg-transparent border-none cursor-pointer">
          <span className="font-display font-extrabold text-[15px] text-[var(--text-primary)] tracking-[-0.03em]">
            Maths<span className="text-[var(--accent-indigo)]">Live</span>
          </span>
        </button>

        <div className="header-divider hidden sm:block" />

        <span className="hidden sm:inline text-[12px] font-mono font-semibold text-[var(--text-muted)]">{roomId}</span>

        <div className="header-divider hidden sm:block" />

        {/* View Mode Toggles */}
        <div className="flex gap-[2px]">
          {(['code', 'split', 'preview'] as const).map(mode => (
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

        <span className="text-[12px] font-mono hidden sm:block text-[var(--text-muted)] tabular-nums">
          {formatTime(sessionTimer)}
        </span>

        <div className="header-divider hidden sm:block" />

        {/* Students pill */}
        <div className="relative">
          <button onClick={() => setShowUserPanel(!showUserPanel)} className="status-pill cursor-pointer border-none">
            <div className={`connection-dot ${studentCount > 0 ? 'online' : 'offline'}`} />
            <span className="tabular-nums">{studentCount}</span>
          </button>
          {showUserPanel && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowUserPanel(false)} />
              <div className="absolute top-full right-0 mt-2 z-50 rounded-xl overflow-hidden animate-slide-down w-[280px] bg-[var(--bg-card)] border border-[var(--border-subtle)] shadow-[var(--shadow-xl)] max-h-[420px] overflow-y-auto">
                {users.length === 0 ? (
                  <div className="text-center py-8 px-4">
                    <div className="text-3xl mb-2 opacity-30">👥</div>
                    <p className="text-xs text-[var(--text-muted)]">No participants yet</p>
                  </div>
                ) : (
                  <UserList users={users} attention={attention} isTeacher={true} socket={socket} roomId={roomId!} />
                )}
              </div>
            </>
          )}
        </div>

        {/* Invite */}
        <div className="relative">
          <button onClick={() => setShowShareMenu(!showShareMenu)}
            className={`${linkCopied ? 'btn-accent' : 'btn'} h-[32px] px-[12px] text-[12.5px]`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
            </svg>
            {linkCopied ? 'Copied!' : 'Invite'}
          </button>
          {showShareMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowShareMenu(false)} />
              <div className="absolute top-full right-0 mt-2 z-50 animate-slide-down w-[300px] bg-[var(--bg-card)] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] shadow-[var(--shadow-xl)] p-4">
                <div className="text-[11px] font-bold mb-3 text-[var(--text-muted)] tracking-[0.06em] uppercase">Share with students</div>

                <div className="flex items-center gap-2 p-2.5 rounded-lg mb-3 bg-[var(--bg-surface)]">
                  <span className="text-[12px] font-mono truncate flex-1 text-[var(--accent-indigo)] font-semibold">
                    {window.location.origin}/live/{roomId}
                  </span>
                </div>

                <div className="mb-3">
                  <label className="block text-[11px] font-semibold mb-1.5 text-[var(--text-secondary)]">
                    Room Passcode <span className="text-[var(--text-muted)] font-normal">(optional)</span>
                  </label>
                  <input type="text" placeholder="e.g. math123" value={roomPassword}
                    onChange={(e) => saveRoomPassword(e.target.value)}
                    className="input-field text-[13px] px-3 py-2" />
                </div>

                <button onClick={copyStudentLink} className="btn-primary w-full justify-center h-[38px] text-[13px] rounded-lg gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                  </svg>
                  {roomPassword ? 'Copy Link + Passcode' : 'Copy Link'}
                </button>
              </div>
            </>
          )}
        </div>

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

        <button onClick={() => { setSoundMuted(!soundMuted); }}
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
  );
}
