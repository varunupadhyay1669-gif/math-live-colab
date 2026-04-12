import React from 'react';

interface StudentAttention {
  studentId: string;
  studentName: string;
  isAttentive: boolean;
  lastSeen: number;
}

interface AttentionIndicatorProps {
  attention: Record<string, StudentAttention>;
}

function getStatus(student: StudentAttention): { color: string; label: string } {
  if (student.isAttentive) return { color: '#10B981', label: 'Active' };
  const elapsed = (Date.now() - student.lastSeen) / 1000;
  if (elapsed > 30) return { color: '#F43F5E', label: `Away ${Math.floor(elapsed)}s` };
  if (elapsed > 10) return { color: '#F59E0B', label: `Idle ${Math.floor(elapsed)}s` };
  return { color: '#10B981', label: 'Active' };
}

export default function AttentionIndicator({ attention }: AttentionIndicatorProps) {
  const students = Object.values(attention);
  if (students.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <span className="text-[10px] font-bold" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
        ATTENTION
      </span>
      {students.map(s => {
        const status = getStatus(s);
        return (
          <div key={s.studentId}
            className="flex items-center gap-2 px-2 py-1 rounded-lg text-[12px] tooltip-wrapper"
            data-tooltip={status.label}
            style={{ background: 'var(--bg-surface)' }}>
            <div className="w-2 h-2 rounded-full shrink-0" style={{
              background: status.color,
              boxShadow: `0 0 6px ${status.color}50`,
            }} />
            <span className="truncate font-medium" style={{ color: 'var(--text-primary)', maxWidth: 120 }}>
              {s.studentName}
            </span>
          </div>
        );
      })}
    </div>
  );
}
