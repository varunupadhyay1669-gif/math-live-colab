import { useEffect, useRef, useState } from 'react';

// The tutor's screen, on the student's device.
//
// This is the escape hatch for every sync problem at once. Live Mirror can
// fail for reasons neither person can see — a lesson that will not render, a
// device that will not run it — and no amount of resyncing helps if the
// student's browser simply cannot show the thing. Whatever is wrong, this
// shows them exactly what the tutor is looking at.
//
// It is also the only screen sharing available on an iPad. iPadOS Safari has
// no getDisplayMedia, so a student there can never send their screen — but
// receiving video is ordinary WebRTC.

interface Props {
  stream: MediaStream;
  teacherName: string;
}

export default function TeacherScreenView({ stream, teacherName }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [minimised, setMinimised] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    // Muted autoplay is allowed everywhere, but iOS still refuses often enough
    // that a silent black rectangle is a real outcome. Offer a tap instead.
    v.play?.().catch(() => setNeedsTap(true));
  }, [stream, minimised]);

  if (minimised) {
    return (
      <button
        onClick={() => setMinimised(false)}
        style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 65,
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#4F46E5', color: '#fff', border: 0, borderRadius: 999,
          padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        }}
      >
        🖥️ Show {teacherName}&rsquo;s screen
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 64,
      background: '#0b0b0f', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 14px', background: 'rgba(255,255,255,0.06)', color: '#fff',
        borderBottom: '1px solid rgba(255,255,255,0.10)', flex: '0 0 auto',
      }}>
        <span style={{ fontSize: 15 }}>🖥️</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{teacherName}&rsquo;s screen</span>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
          background: '#dc2626', borderRadius: 999, padding: '2px 7px',
        }}>LIVE</span>
        <div style={{ flex: 1 }} />
        {/* Not a close button: the tutor decides when the share ends. This
            tucks it away so a student can still reach their own board. */}
        <button
          onClick={() => setMinimised(true)}
          style={{
            background: 'rgba(255,255,255,0.14)', color: '#fff', border: 0,
            borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Hide
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* contain, never cover — cropping a shared screen hides the corner the
            problem is usually in. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onClick={() => { videoRef.current?.play?.().then(() => setNeedsTap(false)).catch(() => {}); }}
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#0b0b0f' }}
        />
        {needsTap && (
          <button
            onClick={() => { videoRef.current?.play?.().then(() => setNeedsTap(false)).catch(() => {}); }}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              background: 'rgba(0,0,0,0.55)', color: '#fff', border: 0,
              fontSize: 16, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Tap to watch {teacherName}&rsquo;s screen
          </button>
        )}
      </div>
    </div>
  );
}
