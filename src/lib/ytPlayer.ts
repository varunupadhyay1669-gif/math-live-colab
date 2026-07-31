// Loads YouTube's iframe player API, once, for the whole app.
//
// We need the API (rather than a plain <iframe>) for one reason: keeping the
// student's playback on the teacher's. Only the API can tell us where the
// teacher currently is and seek the student there. If it fails to load — school
// network, blocker, offline — callers fall back to a plain embed, which still
// plays, just without the following.

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let pending: Promise<any> | null = null;

export function loadYouTubeApi(timeoutMs = 10000): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (pending) return pending;

  pending = new Promise<any>((resolve, reject) => {
    // The API calls this global exactly once. Chain any existing one rather
    // than stomping it.
    const previous = window.onYouTubeIframeAPIReady;
    const timer = setTimeout(() => reject(new Error('YouTube player took too long to load')), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      try { previous?.(); } catch { /* not ours to care about */ }
      resolve(window.YT);
    };
    window.onYouTubeIframeAPIReady = done;

    // Already injected by an earlier attempt that hasn't fired yet? Don't add
    // a second copy — just wait on the callback we've now installed.
    if (document.querySelector('script[data-yt-api]')) return;

    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.dataset.ytApi = '1';
    s.onerror = () => { clearTimeout(timer); reject(new Error('YouTube player script was blocked')); };
    document.head.appendChild(s);
  }).catch((err) => {
    pending = null;   // let a later attempt retry (the network may come back)
    throw err;
  });

  return pending;
}

/** Player states, spelled out — the API exposes them as bare numbers. */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;
