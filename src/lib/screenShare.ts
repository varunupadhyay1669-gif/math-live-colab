// Watching the student's actual screen.
//
// Student Peek serialises the lesson iframe's DOM every couple of seconds. That
// answers "what does their lesson look like" — but when a tutor says "it isn't
// syncing", the question is what is on their screen right now, all of it: the
// whiteboard, the scroll position, the permission dialog they haven't noticed,
// the tab they're actually looking at. Only real screen capture shows that.
//
// One-way by construction. The student sends video; the teacher sends nothing
// back and cannot control anything. There is no microphone and no camera here —
// that is the video call's job, and this deliberately does not touch it.

/**
 * Can this device share its screen at all?
 *
 * The honest answer on an iPad is no. iOS and iPadOS Safari ship no
 * getDisplayMedia — screen capture there is a native-app privilege, not
 * something a web page can ask for, and no permission prompt or flag changes
 * it. A tutor whose student is on an iPad needs to be told that plainly rather
 * than left watching a spinner, so this is checked before anything is asked of
 * the student.
 */
export function screenShareSupported(nav: Partial<Navigator> = navigator): boolean {
  const md = nav.mediaDevices as (MediaDevices & { getDisplayMedia?: unknown }) | undefined;
  return typeof md?.getDisplayMedia === 'function';
}

/** A plain-English reason, for the teacher's panel — never a raw DOM error. */
export function shareFailureMessage(e: unknown, studentName: string): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return `${studentName} chose not to share, or the browser blocked it.`;
  if (name === 'NotFoundError') return `${studentName}'s device offered nothing to capture.`;
  if (name === 'NotReadableError') return `${studentName}'s screen could not be read — another app may be capturing it.`;
  return `${studentName}'s screen could not be captured.`;
}

/** What the teacher's panel is showing at any moment. */
export type ShareStatus =
  | 'idle'         // nothing asked
  | 'asking'       // waiting on the student
  | 'connecting'   // they said yes; the connection is coming up
  | 'live'
  | 'declined'
  | 'unsupported'  // their device cannot do this — see screenShareSupported
  | 'failed'
  | 'ended';

export function statusMessage(status: ShareStatus, who: string): string {
  switch (status) {
    case 'asking': return `Asked ${who} to share their screen — waiting for them to accept.`;
    case 'connecting': return `${who} accepted. Connecting…`;
    case 'live': return `Watching ${who}'s screen.`;
    case 'declined': return `${who} declined.`;
    case 'unsupported': return `${who} is on a device that cannot share its screen — iPads and iPhones have no screen sharing in the browser. Use "See their screen" for a view of the lesson instead.`;
    case 'failed': return `The screen share did not connect. ${who} may be on a restricted network.`;
    case 'ended': return `${who} stopped sharing.`;
    default: return '';
  }
}

const STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface ScreenPeerOptions {
  /** Send one signalling message to the other side. */
  send: (signal: unknown) => void;
  onStream?: (stream: MediaStream) => void;
  onState?: (state: RTCPeerConnectionState) => void;
  /** Injected in tests; the real one is the browser's. */
  PeerConnection?: typeof RTCPeerConnection;
}

/**
 * One direction of video, one peer.
 *
 * Simpler than the call's perfect-negotiation dance on purpose: only the
 * student ever adds a track, so only the student ever offers. There is no
 * glare to resolve, and a collision-handling branch that can never run is a
 * branch that will be wrong when someone finally changes this.
 */
export class ScreenPeer {
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private opts: ScreenPeerOptions;
  /** Candidates that arrived before the remote description — held, not dropped. */
  private pending: RTCIceCandidateInit[] = [];

  constructor(opts: ScreenPeerOptions) { this.opts = opts; }

  private ensure(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const Ctor = this.opts.PeerConnection || RTCPeerConnection;
    const pc = new Ctor({ iceServers: STUN });
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.opts.send({ candidate }); };
    pc.ontrack = ({ streams }) => { if (streams[0]) this.opts.onStream?.(streams[0]); };
    pc.onconnectionstatechange = () => this.opts.onState?.(pc.connectionState);
    this.pc = pc;
    return pc;
  }

  /** Student side: publish this stream and offer it. */
  async share(stream: MediaStream): Promise<void> {
    const pc = this.ensure();
    this.stream = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.opts.send({ description: pc.localDescription });
  }

  /** Teacher side: prepare to receive before the offer arrives. */
  prepare(): void { this.ensure(); }

  async accept(signal: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): Promise<void> {
    const pc = this.ensure();
    if (signal.description) {
      await pc.setRemoteDescription(signal.description);
      // Anything that raced ahead of the description can be applied now.
      for (const c of this.pending.splice(0)) {
        try { await pc.addIceCandidate(c); } catch { /* stale candidate */ }
      }
      if (signal.description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.opts.send({ description: pc.localDescription });
      }
    } else if (signal.candidate) {
      // A candidate before the remote description is not an error; it is the
      // normal race. Dropping them costs connectivity on exactly the networks
      // that need every candidate.
      if (!pc.remoteDescription) { this.pending.push(signal.candidate); return; }
      try { await pc.addIceCandidate(signal.candidate); } catch { /* stale candidate */ }
    }
  }

  /** Always safe to call twice; leaves nothing capturing. */
  close(): void {
    try { this.pc?.close(); } catch { /* already closed */ }
    this.pc = null;
    this.stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* noop */ } });
    this.stream = null;
    this.pending = [];
  }
}
