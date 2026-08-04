import React from 'react';
import { Socket } from 'socket.io-client';

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

interface UserListProps {
  users: UserInfo[];
  attention: Record<string, StudentAttention>;
  isTeacher: boolean;
  socket: Socket | null;
  roomId: string;
  // Control handoff: name of the student who currently holds "the chalk".
  controlHolderName?: string | null;
  onGrantControl?: (holderName: string | null) => void;
  onPeek?: (studentId: string, studentName: string) => void;
  /** Ask this student to share their real screen (Zoom-style). */
  onScreenShare?: (studentId: string, studentName: string) => void;
}

export default function UserList({ users, attention, isTeacher, socket, roomId, controlHolderName, onGrantControl, onPeek, onScreenShare }: UserListProps) {
  const handleKick = (userId: string) => {
    if (!socket) return;
    socket.emit('kick_user', { roomId, userId });
  };

  if (users.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <span className="text-[10px] font-bold mb-1" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
        PARTICIPANTS ({users.length})
      </span>
      {users.map(user => {
        const att = attention[user.id];
        const isActive = att?.isAttentive ?? true;
        const elapsed = att ? (Date.now() - att.lastSeen) / 1000 : 0;
        let dotColor = '#10B981';
        if (!isActive && elapsed > 30) dotColor = '#F43F5E';
        else if (!isActive && elapsed > 10) dotColor = '#F59E0B';

        const holdsControl = user.role === 'student' && !!controlHolderName && user.name === controlHolderName;
        return (
          <div key={user.id}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all group"
            style={{ background: holdsControl ? 'rgba(244,63,94,0.10)' : 'var(--bg-surface)', boxShadow: holdsControl ? '0 0 0 1px rgba(244,63,94,0.35)' : 'none' }}>
            {/* Attention dot */}
            <div className="w-2 h-2 rounded-full shrink-0" style={{
              background: dotColor,
              boxShadow: `0 0 6px ${dotColor}50`,
            }} />
            {/* Name */}
            <span className="text-[12px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)', maxWidth: 110 }}>
              {user.name}{holdsControl ? ' ✋' : ''}
            </span>
            {/* Role badge */}
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{
                background: user.role === 'teacher' ? 'var(--accent-emerald-light)' : 'var(--accent-indigo-light)',
                color: user.role === 'teacher' ? 'var(--accent-emerald)' : 'var(--accent-indigo)',
              }}>
              {user.role === 'teacher' ? '🎓' : '🎒'}
            </span>
            {/* Teacher controls for a student row */}
            {isTeacher && user.role === 'student' && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {/* Peek at their real screen */}
                {onPeek && (
                  <button onClick={() => onPeek(user.id, user.name)}
                    className="text-[12px]" title="See this student's screen"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>
                    👁️
                  </button>
                )}
                {/* Ask them to share their actual screen. Distinct from the
                    eye above: that shows the lesson's DOM, this shows their
                    whole screen live — the one that answers "why does it look
                    different on your side". */}
                {onScreenShare && (
                  <button onClick={() => onScreenShare(user.id, user.name)}
                    className="text-[12px]" title="Ask to see their whole screen (live)"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>
                    🖥️
                  </button>
                )}
                {/* Give / take back control */}
                {onGrantControl && (
                  <button onClick={() => onGrantControl(holdsControl ? null : user.name)}
                    className="text-[12px]"
                    title={holdsControl ? 'Take back control' : 'Give this student control'}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, opacity: holdsControl ? 1 : 0.85 }}>
                    {holdsControl ? '🔙' : '✋'}
                  </button>
                )}
                {/* Kick */}
                <button onClick={() => handleKick(user.id)}
                  className="text-[11px]"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1 }}
                  title="Remove student">
                  ✕
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
