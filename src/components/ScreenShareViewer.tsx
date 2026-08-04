import React, { useEffect, useRef } from 'react';
import { statusMessage, type ShareStatus } from '../lib/screenShare';

// The teacher's window onto the student's real screen.
//
// Read-only by construction — there is no input path back, so nothing here can
// click anything on the student's machine. The point is diagnosis: seeing that
// their whiteboard is scrolled somewhere else, or that a dialog is sitting over
// the lesson, in the moment rather than after the class.

interface Props {
  studentName: string;
  status: ShareStatus;
  stream: MediaStream | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}

export default function ScreenShareViewer({ studentName, status, stream, error, onClose, onRetry }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attached in an effect, not at assignment time: while connecting there is no
  // <video> mounted yet, so setting srcObject when the stream arrives would hit
  // a null ref and leave the panel black once it did render.
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play?.().catch(() => { /* muted, so autoplay is allowed */ });
    }
  }, [stream, status]);

  const live = status === 'live' && !!stream;
  const waiting = status === 'asking' || status === 'connecting';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}>
      <div className="ml-surface-elevated flex flex-col"
        style={{ width: 'min(1100px, 96vw)', height: 'min(720px, 90vh)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-xl)' }}
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 16 }}>🖥️</span>
          <div className="flex flex-col" style={{ minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
              {studentName}&rsquo;s screen
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {error || statusMessage(status, studentName)}
            </span>
          </div>
          {live && (
            <span style={{
              marginLeft: 8, fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
              color: '#fff', background: '#dc2626', borderRadius: 999, padding: '2px 8px',
            }}>LIVE</span>
          )}
          <div style={{ flex: 1 }} />
          {(status === 'declined' || status === 'failed' || status === 'ended') && (
            <button className="ml-btn" onClick={onRetry}>Ask again</button>
          )}
          <button className="ml-btn" onClick={onClose}>
            {live ? 'Stop watching' : 'Close'}
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center" style={{ background: '#0b0b0f', minHeight: 0 }}>
          {live ? (
            // object-fit: contain — never crop. A cropped share hides the very
            // corner the problem is usually in.
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#0b0b0f' }} />
          ) : (
            <div style={{ textAlign: 'center', padding: 32, maxWidth: 520 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>{waiting ? '⏳' : status === 'unsupported' ? '📱' : '🖥️'}</div>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
                {error || statusMessage(status, studentName) || 'Ask the student to share their screen.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
