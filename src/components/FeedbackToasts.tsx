import React from 'react';

interface FeedbackItem {
  id: number;
  emoji: string;
  label: string;
  studentName: string;
}

interface FeedbackToastsProps {
  feedback: FeedbackItem[];
}

export default function FeedbackToasts({ feedback }: FeedbackToastsProps) {
  if (feedback.length === 0) return null;

  return (
    <div className="absolute top-4 right-4 z-20 flex flex-col gap-2 pointer-events-none">
      {feedback.map(f => (
        <div key={f.id} className="animate-slide-in-right flex items-center gap-2 px-3.5 py-2.5 rounded-xl pointer-events-auto"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--shadow-lg)',
          }}>
          <span className="text-lg">{f.emoji}</span>
          <div>
            <div className="text-[10px] font-bold" style={{ color: 'var(--accent-indigo)' }}>{f.studentName}</div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{f.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
