// Pull a video id (and optional start time) out of whatever a teacher pastes.
// Kept separate from the UI so the parsing is unit-testable — people paste a
// surprising variety of YouTube URLs, and "nothing happened" is a terrible
// failure mode mid-lesson.

export type ParsedVideo = { id: string; start: number } | null;

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** "1h2m3s" / "90s" / "90" → seconds. YouTube uses both forms. */
function parseTime(raw: string | null): number {
  if (!raw) return 0;
  const plain = Number(raw);
  if (Number.isFinite(plain) && plain >= 0) return Math.floor(plain);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/**
 * Accepts: a bare 11-char id, youtu.be/ID, /watch?v=ID, /embed/ID, /shorts/ID,
 * /live/ID, /v/ID, plus &t= / ?start= timestamps and any extra query junk
 * (playlist params, si= share tokens, whitespace from copy-paste).
 */
export function parseYouTube(input: string): ParsedVideo {
  const raw = (input || '').trim();
  if (!raw) return null;

  // Someone pasted just the id.
  if (ID_RE.test(raw)) return { id: raw, start: 0 };

  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  const isYouTube = host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be';
  if (!isYouTube) return null;

  let id = '';
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v') || '';
  } else {
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (m) id = m[1];
  }
  if (!ID_RE.test(id)) return null;

  const start = parseTime(url.searchParams.get('t') || url.searchParams.get('start'));
  return { id, start };
}

/** Privacy-friendly embed URL. `nocookie` avoids YouTube setting ad cookies on
 *  a child's browser, which matters when the viewer is a school student. */
export function embedUrl(id: string, opts: { start?: number; autoplay?: boolean; mute?: boolean } = {}): string {
  const p = new URLSearchParams({
    enablejsapi: '1',
    rel: '0',                 // don't suggest unrelated videos afterwards
    modestbranding: '1',
    playsinline: '1',
    origin: typeof window !== 'undefined' ? window.location.origin : '',
  });
  if (opts.start) p.set('start', String(opts.start));
  if (opts.autoplay) p.set('autoplay', '1');
  if (opts.mute) p.set('mute', '1');
  return `https://www.youtube-nocookie.com/embed/${id}?${p.toString()}`;
}
