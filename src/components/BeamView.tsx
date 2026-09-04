import { useEffect, useState } from 'react';
import { BEAM_STALE_MS } from '../lib/beam';

// The beam, on the student's device.
//
// A picture, not a video and not the lesson: the tutor has fallen back to
// showing rather than sharing, usually because a PDF is open in another window
// and there is no other way to get it here. So this says so, in words, at the
// top, permanently — VIEW ONLY. A child who taps a diagram and nothing happens
// concludes the app is broken, and then stops telling anyone when it is.
//
// The other honesty this owes them is the opposite of a spinner. A still frame
// that has stopped arriving looks exactly like a still frame that has not
// changed, so after twelve seconds it says which one it is. That is the same
// failure the whole feature exists for — "I thought he could see it" — read
// from the other end.

interface Props {
  /** The latest frame, as a data: URL. */
  src: string;
  /** When it arrived, so the overlay can notice it has stopped. */
  at: number;
  teacherName: string;
  /** What the tutor said they are showing, e.g. "The whiteboard". */
  label: string;
  /** Ask the tutor's browser for a whole frame — used when this goes stale. */
  onRequestFrame: () => void;
}

export default function BeamView({ src, at, teacherName, label, onRequestFrame }: Props) {
  const [hidden, setHidden] = useState(false);
  const [stale, setStale] = useState(false);

  // Re-armed on every frame. A timer per frame rather than a ticking interval
  // because frames are the only event that matters here, and an interval would
  // keep a phone awake between them for nothing.
  useEffect(() => {
    setStale(false);
    if (!src) return;
    const t = setTimeout(() => {
      setStale(true);
      // Ask once, at the moment it is noticed. The tutor's browser answers with
      // a keyframe if it is still beaming, and if it is not, nothing arrives
      // and the message below stays up — which is the correct outcome.
      onRequestFrame();
    }, BEAM_STALE_MS);
    return () => clearTimeout(t);
  }, [src, at, onRequestFrame]);

  if (hidden) {
    return (
      <button
        data-testid="beam-show"
        onClick={() => { setHidden(false); onRequestFrame(); }}
        style={{
          position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 65,
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#4F46E5', color: '#fff', border: 0, borderRadius: 999,
          padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        }}
      >
        Show what {teacherName} is displaying
      </button>
    );
  }

  return (
    // Dark ground in both themes on purpose, and not a token: this is a picture
    // viewer, and a page-coloured surround makes a white PDF bleed into the
    // chrome so the student cannot tell where the shared thing ends.
    <div
      data-testid="beam-view"
      style={{
        position: 'fixed', inset: 0, zIndex: 64,
        background: '#0b0b0f', display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 14px', background: 'rgba(255,255,255,0.06)', color: '#fff',
        borderBottom: '1px solid rgba(255,255,255,0.10)', flex: '0 0 auto',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {teacherName}&rsquo;s {label || 'screen'}
        </span>
        {/* The words, not a colour or an icon. A greyed-out cursor is not a
            message a child reads; "VIEW ONLY" is. */}
        <span
          data-testid="beam-viewonly"
          style={{
            fontSize: 10, fontWeight: 800, letterSpacing: 0.6,
            background: '#b45309', borderRadius: 999, padding: '2px 8px',
          }}
        >
          VIEW ONLY
        </span>
        <span style={{ fontSize: 11.5, opacity: 0.75 }}>
          You can watch this, but you cannot tap or type on it.
        </span>
        <div style={{ flex: 1 }} />
        {/* Not a close button: the tutor decides when the beam ends. This tucks
            it away so the student can still reach their own board. */}
        <button
          data-testid="beam-hide"
          onClick={() => setHidden(true)}
          style={{
            background: 'rgba(255,255,255,0.14)', color: '#fff', border: 0,
            borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Hide
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* contain, never cover — cropping a shared page hides the corner the
            question is usually in. */}
        <img
          data-testid="beam-image"
          src={src}
          alt={`What ${teacherName} is showing`}
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#0b0b0f' }}
        />
        {stale && (
          <div
            data-testid="beam-stale"
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0,
              padding: '10px 14px', background: 'rgba(180,83,9,0.95)', color: '#fff',
              fontSize: 12.5, fontWeight: 600, textAlign: 'center',
            }}
          >
            This picture has stopped updating — tell your teacher.
          </div>
        )}
      </div>
    </div>
  );
}
