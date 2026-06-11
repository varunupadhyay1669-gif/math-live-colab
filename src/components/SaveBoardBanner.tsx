// AUTONOMOUS: Miro-style "X left to save your board" banner.
//
// Shown at the top of an anonymous room (claimed=false). Live-counts
// down to the server-authoritative expiresAt. Click "Save to my boards"
// → emits claim_room and the parent persists locally.
//
// Visual style mimics Miro's banner: a clean white card on the left
// with the timer + message, a primary indigo CTA on the right. Subtle
// drop shadow against a slightly tinted background so it doesn't blend
// into the page chrome.

import { useEffect, useState } from 'react';

interface Props {
  expiresAt: number; // ms epoch
  saving: boolean;
  onSave: () => void;
}

function formatTimeLeft(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    // Round up to nearest hour for big numbers — Miro just shows "24h"
    return hours >= 2 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  // Final minute: "0m left" read like a bug — the 30s tick can sit there
  // for most of a minute before flipping to expired.
  return minutes < 1 ? 'less than a minute' : `${minutes}m`;
}

export default function SaveBoardBanner({ expiresAt, saving, onSave }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    // Tick every 30s — minute-resolution UI doesn't need second-by-second.
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const left = expiresAt - now;
  const expired = left <= 0;
  const text = expired
    ? 'This board is past its expiry — save now to keep working on it.'
    : `${formatTimeLeft(left)} left to save your board.`;

  return (
    <div
      className="px-4 py-2 flex items-center justify-center gap-3"
      style={{
        background: 'rgba(238,242,255,0.9)',
        borderBottom: '1px solid rgba(79,70,229,0.15)',
        fontSize: 13,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span style={{ color: '#312E81', fontWeight: 600 }}>{text}</span>
      <button
        onClick={onSave}
        disabled={saving}
        style={{
          padding: '5px 14px',
          borderRadius: 8,
          border: 'none',
          background: saving ? '#A5B4FC' : '#4F46E5',
          color: '#fff',
          fontWeight: 700,
          fontSize: 12.5,
          cursor: saving ? 'wait' : 'pointer',
          letterSpacing: '0.01em',
          boxShadow: '0 2px 6px rgba(79,70,229,0.25)',
        }}
        aria-label="Save this board to my boards"
      >
        {saving ? 'Saving…' : 'Save to my boards'}
      </button>
    </div>
  );
}
