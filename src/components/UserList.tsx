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
}

export default function UserList({ users, attention, isTeacher, socket, roomId }: UserListProps) {
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

        return (
          <div key={user.id}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all group"
            style={{ background: 'var(--bg-surface)' }}>
            {/* Attention dot */}
            <div className="w-2 h-2 rounded-full shrink-0" style={{
              background: dotColor,
              boxShadow: `0 0 6px ${dotColor}50`,
            }} />
            {/* Name */}
            <span className="text-[12px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)', maxWidth: 120 }}>
              {user.name}
            </span>
            {/* Role badge */}
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              style={{
                background: user.role === 'teacher' ? 'var(--accent-emerald-light)' : 'var(--accent-indigo-light)',
                color: user.role === 'teacher' ? 'var(--accent-emerald)' : 'var(--accent-indigo)',
              }}>
              {user.role === 'teacher' ? '🎓' : '🎒'}
            </span>
            {/* Kick button (teacher only, for students) */}
            {isTeacher && user.role === 'student' && (
              <button onClick={() => handleKick(user.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px]"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                title="Remove student">
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
