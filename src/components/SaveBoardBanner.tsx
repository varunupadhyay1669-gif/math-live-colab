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
  /** Whiteboard open: trim to one tight line, every pixel here costs board. */
  slim?: boolean;
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

export default function SaveBoardBanner({ expiresAt, saving, onSave, slim = false }: Props) {
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
      className="ml-status-strip"
      style={{ fontSize: slim ? 12 : 13 }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span className="ml-status-strip-text">{slim ? text.replace(' to save your board.', ' to save this board') : text}</span>
      <button
        className="ml-status-strip-btn is-primary"
        onClick={onSave}
        disabled={saving}
        aria-label="Save this board to my boards"
      >
        {saving ? 'Saving…' : slim ? 'Save board' : 'Save to my boards'}
      </button>
    </div>
  );
}
