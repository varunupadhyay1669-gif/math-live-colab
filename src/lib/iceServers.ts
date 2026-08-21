// How the two browsers find each other.
//
// STUN tells a browser what its own public address looks like, which is enough
// when both sides are on networks that permit a direct path. A great many are
// not: Indian mobile carriers put subscribers behind a shared address, and so do
// most school and office networks. Between two such networks there is no direct
// path at all — and with no relay the call does not connect, ever, with nothing
// to try differently.
//
// So the servers come from `/api/turn`, which mints short-lived relay
// credentials (see the endpoint for the provider shapes it accepts). The
// browser never holds a lasting secret. When no relay is configured the answer
// is STUN-only and everything still works for the networks that allow it — the
// difference is `relay` comes back false, so the UI can tell the tutor WHY a
// call failed instead of leaving them guessing.

export interface IceConfig {
  iceServers: RTCIceServer[];
  /** Is a relay available? False means restrictive networks cannot connect. */
  relay: boolean;
}

const STUN_ONLY: IceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  relay: false,
};

// Credentials expire, so this is cached only for their lifetime — long enough
// that opening a call twice in a lesson costs one request, short enough that a
// long lesson never negotiates with a stale credential.
let cached: { at: number; ttlMs: number; value: IceConfig } | null = null;

export async function getIceConfig(): Promise<IceConfig> {
  if (cached && Date.now() - cached.at < cached.ttlMs) return cached.value;
  try {
    const res = await fetch('/api/turn', { cache: 'no-store' });
    if (!res.ok) return STUN_ONLY;
    const body = await res.json() as { iceServers?: RTCIceServer[]; relay?: boolean; expiresIn?: number };
    if (!Array.isArray(body.iceServers) || body.iceServers.length === 0) return STUN_ONLY;
    const value: IceConfig = { iceServers: body.iceServers, relay: !!body.relay };
    // Re-fetch at 80% of the credential's life, and never hold one for more
    // than 10 minutes even if the server offers longer.
    const ttlMs = Math.min(10 * 60_000, Math.max(60_000, (body.expiresIn || 3600) * 800));
    cached = { at: Date.now(), ttlMs, value };
    return value;
  } catch {
    // Offline, or the endpoint is missing on an older deployment. STUN still
    // connects the easy networks; it must never block the call from starting.
    return STUN_ONLY;
  }
}

/**
 * Which path did this connection actually take?
 *
 * "relay" means the media is going through the TURN server — normal, and the
 * only thing that works on a restrictive network. Worth surfacing because it is
 * the single most useful fact when someone says the call is poor: a relayed call
 * has further to travel, and a call that failed WITHOUT a relay available has an
 * obvious fix.
 */
export async function describeConnection(pc: RTCPeerConnection): Promise<'direct' | 'relayed' | 'unknown'> {
  try {
    const stats = await pc.getStats();
    let pairId: string | null = null;
    stats.forEach((r: any) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let localId: string | null = null;
    stats.forEach((r: any) => {
      const chosen = pairId ? r.id === pairId : (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated);
      if (chosen && r.localCandidateId) localId = r.localCandidateId;
    });
    if (!localId) return 'unknown';
    let type: string | null = null;
    stats.forEach((r: any) => { if (r.id === localId) type = r.candidateType; });
    if (!type) return 'unknown';
    return type === 'relay' ? 'relayed' : 'direct';
  } catch {
    return 'unknown';
  }
}
