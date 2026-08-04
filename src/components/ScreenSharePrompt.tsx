import React from 'react';

// The student's side of a screen-share request.
//
// This dialog is not a policy choice we could skip — getDisplayMedia refuses to
// run without a user gesture, so a button is the only way a share can begin at
// all. Given that, it says plainly who is asking and what they will see, and
// "Not now" is a real answer with no consequence.

interface Props {
  teacherName: string;
  onShare: () => void;
  onDecline: () => void;
}

export default function ScreenSharePrompt({ teacherName, onShare, onDecline }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}>
      <div className="ml-surface-elevated"
        style={{ width: 'min(420px, 94vw)', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-xl)' }}>
        <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 12 }}>🖥️</div>
        <h2 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 8px', color: 'var(--text-primary)' }}>
          {teacherName} would like to see your screen
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.5, margin: '0 0 6px', color: 'var(--text-secondary)' }}>
          This helps them check that everything is showing up properly on your side.
        </p>
        <p style={{ fontSize: 13, lineHeight: 1.5, margin: '0 0 20px', color: 'var(--text-secondary)' }}>
          You pick what to share on the next screen, and you can stop any time.
          They can only watch — they can't click anything.
        </p>
        <div className="flex gap-2">
          <button className="ml-btn ml-btn-primary" style={{ flex: 1 }} onClick={onShare} autoFocus>
            Share my screen
          </button>
          <button className="ml-btn" style={{ flex: 1 }} onClick={onDecline}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
