import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type Key } from "react";
import type { Socket } from "socket.io-client";

// ─────────────────────────────────────────────────────────────────────────
// Face-to-face video, inside the lesson.
//
// Meet / Zoom / Teams all send `X-Frame-Options`, so they physically cannot be
// embedded in a page — a pasted meeting link can never render faces here. So we
// connect the two browsers directly with WebRTC instead. The room's existing
// socket is the introduction channel (see `rtc_signal` on the server); once the
// two sides have swapped details the audio/video flows peer-to-peer and never
// touches our server.
//
// Camera and microphone are NEVER opened until the person clicks Start — no
// silent access, and stopping the call releases the devices immediately (the
// browser's recording indicator goes out).
// ─────────────────────────────────────────────────────────────────────────

const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

type Props = {
  socket: Socket | null;
  roomId: string;
  /** Exactly one side must be polite; it yields when both call at once
   *  ("glare"). Teacher = impolite, student = polite. */
  polite: boolean;
  /** Shown under the small self-view. */
  selfLabel?: string;
};

export default function VideoCall({ socket, roomId, polite, selfLabel = 'You' }: Props) {
  const [active, setActive] = useState(false);          // my camera is running
  const [connected, setConnected] = useState(false);     // remote media arrived
  const [peerReady, setPeerReady] = useState(false);     // other side is on camera
  const [peerName, setPeerName] = useState<string>('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [minimised, setMinimised] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bottom-right by default, and remembered.
  //
  // It used to sit at (16, 84) — directly on top of the tool rail, which runs
  // the entire left edge (top:76 to bottom:14). So the button permanently
  // covered the first tools, and being a plain fixed <button> it could not be
  // moved out of the way either.
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('mathslive:callpos') || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
    } catch { /* corrupt entry — fall through to the default */ }
    return {
      x: Math.max(120, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 210),
      y: Math.max(80, (typeof window !== 'undefined' ? window.innerHeight : 720) - 74),
    };
  });
  useEffect(() => {
    try { localStorage.setItem('mathslive:callpos', JSON.stringify(pos)); } catch { /* private mode */ }
  }, [pos]);
  // A remembered position must not survive a move to a smaller screen, or the
  // button sits off the edge with no way to grab it.
  useEffect(() => {
    const clamp = () => setPos(p => ({
      x: Math.max(4, Math.min(window.innerWidth - 120, p.x)),
      y: Math.max(4, Math.min(window.innerHeight - 56, p.y)),
    }));
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  // Distinguishes a drag from a click on the idle pill: the whole control is a
  // button, so the panel's "don't drag from a control" rule cannot apply here.
  const idleDragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  // Held in state (not just on the element) so the <video> can be re-attached
  // whenever it mounts or re-renders — see the wiring effects below.
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [camId, setCamId] = useState<string>('');
  const [micId, setMicId] = useState<string>('');
  const [spkId, setSpkId] = useState<string>('');
  const [menu, setMenu] = useState<null | 'mic' | 'cam'>(null);
  const [blur, setBlur] = useState<'off' | 'light' | 'strong'>('off');
  const [blurLoading, setBlurLoading] = useState(false);
  const blurSupported = !!(navigator.mediaDevices?.getSupportedConstraints?.() as any)?.backgroundBlur;

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  // The signalling effect subscribes once and must not re-subscribe on every
  // state change, so it reads "am I on a call" and "how do I hang up" through
  // refs rather than closing over values that would go stale.
  const activeRef = useRef(false);
  const stopCallRef = useRef<((tellPeer?: boolean) => void) | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  // Kept so 'off' can restore the untouched camera, and so teardown can stop
  // the segmentation loop instead of leaving it spinning.
  const blurHandleRef = useRef<import('../lib/backgroundBlur').BlurHandle | null>(null);
  const rawVideoTrackRef = useRef<MediaStreamTrack | null>(null);

  const emitSignal = useCallback((signal: unknown) => {
    socket?.emit('rtc_signal', { roomId, signal });
  }, [socket, roomId]);

  // Build the peer connection lazily; both starting a call and answering one
  // funnel through here so there is only ever one connection object.
  const ensurePc = useCallback(() => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: STUN });
    pc.onicecandidate = ({ candidate }) => { if (candidate) emitSignal({ candidate }); };
    pc.ontrack = ({ streams }) => {
      const [stream] = streams;
      if (stream) {
        // Keep it in state; a wiring effect attaches it to the element. The
        // element may not exist yet at this moment.
        setRemoteStream(stream);
        setConnected(true);
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') setConnected(true);
      if (s === 'failed') {
        // Almost always a restrictive network with no relay available. End it
        // rather than leaving the camera running against a dead connection —
        // 'disconnected' is the transient one, 'failed' is not recoverable here.
        setConnected(false);
        stopCallRef.current?.(false);
        setError("Couldn't connect — one of you may be on a restricted network.");
      }
      if (s === 'disconnected' || s === 'closed') setConnected(false);
    };
    // Perfect negotiation: renegotiate whenever tracks change.
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        emitSignal({ description: pc.localDescription });
      } catch (e) {
        console.warn('[call] negotiation failed', e);
      } finally {
        makingOfferRef.current = false;
      }
    };
    pcRef.current = pc;
    return pc;
  }, [emitSignal]);

  const stopCall = useCallback((tellPeer = true) => {
    // Stop the blur pipeline first or its rAF loop keeps running after hang-up.
    try { blurHandleRef.current?.stop(); } catch { /* noop */ }
    blurHandleRef.current = null;
    rawVideoTrackRef.current = null;
    setBlur('off');
    try { pcRef.current?.close(); } catch { /* already closed */ }
    pcRef.current = null;
    // Releasing every track is what turns the camera light off.
    localStreamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch { /* noop */ } });
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setActive(false);
    setConnected(false);
    if (tellPeer) socket?.emit('rtc_presence', { roomId, active: false });
  }, [socket, roomId]);

  const startCall = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      const pc = ensurePc();
      // Adding tracks fires onnegotiationneeded, which sends the offer.
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      setActive(true);
      setMicOn(true);
      setCamOn(true);
      socket?.emit('rtc_presence', { roomId, active: true });
    } catch (e) {
      const err = e as Error;
      setError(
        err?.name === 'NotAllowedError'
          ? 'Camera/microphone permission was blocked. Allow it in your browser, then try again.'
          : err?.name === 'NotFoundError'
            ? 'No camera or microphone found on this device.'
            : `Could not start the camera (${err?.name || 'unknown'})`,
      );
    }
  }, [ensurePc, socket, roomId]);

  // ── Signalling ──
  useEffect(() => {
    if (!socket) return;
    const onSignal = async ({ signal }: { signal: any }) => {
      if (!signal) return;
      // Only engage once this side has actually joined; otherwise we'd open a
      // connection (and a camera prompt) for someone who never asked to call.
      if (!pcRef.current && !localStreamRef.current) return;
      const pc = ensurePc();
      try {
        if (signal.description) {
          const desc = signal.description;
          const collision = desc.type === 'offer' && (makingOfferRef.current || pc.signalingState !== 'stable');
          ignoreOfferRef.current = !polite && collision;
          if (ignoreOfferRef.current) return;   // impolite side wins, ignore theirs
          await pc.setRemoteDescription(desc);
          if (desc.type === 'offer') {
            await pc.setLocalDescription();
            emitSignal({ description: pc.localDescription });
          }
        } else if (signal.candidate) {
          try { await pc.addIceCandidate(signal.candidate); }
          catch (e) { if (!ignoreOfferRef.current) console.warn('[call] ICE add failed', e); }
        }
      } catch (e) {
        console.warn('[call] signal handling failed', e);
      }
    };
    const onPresence = ({ active: a, name }: { active: boolean; name?: string }) => {
      setPeerReady(!!a);
      if (name) setPeerName(name);
      if (!a) {
        setConnected(false);
        // They hung up. Hang up here too, or this side sits there with the
        // camera still running and the other person's last frame frozen on
        // screen — it looks like a live call to someone who is alone.
        if (activeRef.current) {
          stopCallRef.current?.(false);
          setError(`${name || 'The other person'} ended the call.`);
        }
      }
    };
    socket.on('rtc_signal', onSignal);
    socket.on('rtc_presence', onPresence);
    return () => {
      socket.off('rtc_signal', onSignal);
      socket.off('rtc_presence', onPresence);
    };
  }, [socket, polite, ensurePc, emitSignal]);

  // ── Wire streams to the <video> elements AFTER they exist ──
  // THE self-view bug: while idle the component renders only the button, so
  // there is no <video> yet. Assigning srcObject inside startCall therefore hit
  // a null ref and the self-view stayed black forever. Doing it in an effect
  // runs after the elements mount, and re-runs whenever the window is
  // minimised/restored or the camera is swapped.
  useEffect(() => {
    if (active && localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play?.().catch(() => { /* autoplay policy — muted, so rare */ });
    }
  }, [active, minimised, camId]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current.play?.().catch(() => { /* user gesture already given */ });
    }
  }, [remoteStream, active, minimised]);

  // ── Device list ──
  // Labels are only readable once permission has been granted, so refresh after
  // the call starts and whenever the OS device list changes (headset plugged in).
  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
    } catch { /* enumeration blocked — menus just stay empty */ }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refreshDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refreshDevices);
    return () => md?.removeEventListener?.('devicechange', refreshDevices);
  }, [active, refreshDevices]);

  // Swap the camera (or mic) live: grab the new device, hand it to the peer via
  // replaceTrack so the call never drops, then swap it into the local preview.
  const switchDevice = useCallback(async (kind: 'video' | 'audio', deviceId: string) => {
    try {
      const constraints: MediaStreamConstraints = kind === 'video'
        ? { video: { deviceId: { exact: deviceId } }, audio: false }
        : { audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }, video: false };
      const fresh = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = kind === 'video' ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
      if (!newTrack) return;
      const sender = pcRef.current?.getSenders().find(s => s.track?.kind === kind);
      if (sender) await sender.replaceTrack(newTrack);
      const old = kind === 'video'
        ? localStreamRef.current?.getVideoTracks()[0]
        : localStreamRef.current?.getAudioTracks()[0];
      if (old && localStreamRef.current) { localStreamRef.current.removeTrack(old); old.stop(); }
      localStreamRef.current?.addTrack(newTrack);
      if (kind === 'video') { setCamId(deviceId); if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current; }
      else { setMicId(deviceId); newTrack.enabled = micOn; }
      setMenu(null);
    } catch (e) {
      setError(`Could not switch ${kind === 'video' ? 'camera' : 'microphone'}.`);
    }
  }, [micOn]);

  // Speaker choice applies to the element that plays the other person's audio.
  const switchSpeaker = useCallback(async (deviceId: string) => {
    try {
      const el = remoteVideoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
      if (el?.setSinkId) { await el.setSinkId(deviceId); setSpkId(deviceId); }
      setMenu(null);
    } catch { setError('Could not switch speaker.'); }
  }, []);

  // Blur has two routes. If the browser exposes it as a track constraint we use
  // that — it's free and hardware-accelerated. Otherwise we fall back to
  // segmenting the picture ourselves, which downloads a model on first use.
  const applyBlur = useCallback(async (mode: 'off' | 'light' | 'strong') => {
    const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'video');
    setError(null);

    // ── Turning it off ──
    if (mode === 'off') {
      if (blurHandleRef.current) {
        blurHandleRef.current.stop();
        blurHandleRef.current = null;
        const raw = rawVideoTrackRef.current;
        if (raw && sender) await sender.replaceTrack(raw);
        if (raw && localVideoRef.current) localVideoRef.current.srcObject = new MediaStream([raw, ...(localStreamRef.current?.getAudioTracks() || [])]);
      } else if (blurSupported) {
        try { await localStreamRef.current?.getVideoTracks()[0]?.applyConstraints({ backgroundBlur: false } as any); } catch { /* noop */ }
      }
      setBlur('off'); setMenu(null);
      return;
    }

    // ── Native path ──
    if (blurSupported && !blurHandleRef.current) {
      try {
        await localStreamRef.current?.getVideoTracks()[0]?.applyConstraints({ backgroundBlur: true } as any);
        setBlur(mode); setMenu(null);
        return;
      } catch { /* fall through to the model */ }
    }

    // ── Already blurring: just change strength ──
    if (blurHandleRef.current) {
      blurHandleRef.current.setStrength(mode);
      setBlur(mode); setMenu(null);
      return;
    }

    // ── Model path (first use downloads it) ──
    const src = localStreamRef.current;
    if (!src) return;
    setBlurLoading(true);
    setMenu(null);
    try {
      const { createBlurredStream } = await import('../lib/backgroundBlur');
      rawVideoTrackRef.current = src.getVideoTracks()[0] || null;
      const handle = await createBlurredStream(src, mode);
      blurHandleRef.current = handle;
      const blurredTrack = handle.stream.getVideoTracks()[0];
      if (sender && blurredTrack) await sender.replaceTrack(blurredTrack);
      // Show yourself blurred too, so what you see is what they see.
      if (localVideoRef.current && blurredTrack) {
        localVideoRef.current.srcObject = new MediaStream([blurredTrack]);
        localVideoRef.current.play?.().catch(() => { /* muted */ });
      }
      setBlur(mode);
    } catch (e) {
      setError('Background blur could not load (it needs a one-off download).');
      setBlur('off');
    } finally {
      setBlurLoading(false);
    }
  }, [blurSupported]);

  // Announce ourselves to a peer who joins after we started.
  useEffect(() => {
    if (!socket || !active) return;
    const t = setInterval(() => socket.emit('rtc_presence', { roomId, active: true }), 5000);
    return () => clearInterval(t);
  }, [socket, active, roomId]);

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { stopCallRef.current = stopCall; }, [stopCall]);

  // Closing the tab or navigating away is a hang-up, and the peer has to be
  // told — otherwise they keep filming an empty room. `pagehide` fires on close,
  // reload and back-navigation, and (unlike an unmount cleanup) never fires
  // spuriously in React's development double-mount.
  useEffect(() => {
    if (!socket || !active) return;
    const bye = () => { try { socket.emit('rtc_presence', { roomId, active: false }); } catch { /* socket already gone */ } };
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, [socket, active, roomId]);

  useEffect(() => () => stopCall(false), [stopCall]);

  const toggleMic = () => {
    const t = localStreamRef.current?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setMicOn(t.enabled);
  };
  const toggleCam = () => {
    const t = localStreamRef.current?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setCamOn(t.enabled);
  };

  // ── Dragging the floating window ──
  const onDragStart = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;   // don't drag from a control
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    const maxX = window.innerWidth - 220, maxY = window.innerHeight - 120;
    setPos({
      x: Math.max(4, Math.min(maxX, e.clientX - dragRef.current.dx)),
      y: Math.max(4, Math.min(maxY, e.clientY - dragRef.current.dy)),
    });
  };
  const onDragEnd = () => { dragRef.current = null; };

  const btn: CSSProperties = {
    border: 0, borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
    padding: '6px 10px', background: 'rgba(255,255,255,0.14)', color: '#fff',
  };

  // Idle: a small unobtrusive button, plus a nudge when the other side is on.
  if (!active) {
    return (
      <button
        onClick={() => { if (!idleDragRef.current?.moved) startCall(); }}
        onPointerDown={(e) => {
          idleDragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = idleDragRef.current;
          if (!d) return;
          const nx = e.clientX - d.dx, ny = e.clientY - d.dy;
          // A few pixels of travel while pressing is a click, not a drag —
          // otherwise a slightly shaky tap moves the button instead of calling.
          if (!d.moved && Math.abs(nx - pos.x) + Math.abs(ny - pos.y) < 4) return;
          d.moved = true;
          setPos({
            x: Math.max(4, Math.min(window.innerWidth - 120, nx)),
            y: Math.max(4, Math.min(window.innerHeight - 56, ny)),
          });
        }}
        onPointerUp={(e) => {
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
          // Cleared after the click handler has read it.
          setTimeout(() => { idleDragRef.current = null; }, 0);
        }}
        title="Start a video call — drag to move this out of the way"
        style={{
          position: 'fixed', left: pos.x, top: pos.y, zIndex: 70,
          touchAction: 'none',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', borderRadius: 999, border: 0, cursor: 'pointer',
          background: peerReady ? '#16a34a' : '#4f46e5', color: '#fff',
          fontSize: 13, fontWeight: 700, boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
        </svg>
        {/* Deliberately "call", never "video" — the toolbar's Video button
            shows a YouTube clip, and two buttons both saying "video" had the
            teacher hanging up on their student when they meant to stop a clip. */}
        {peerReady ? `Join ${peerName ? `${peerName}'s call` : 'the call'}` : 'Start call'}
        {error && <span style={{ fontWeight: 500, opacity: 0.9 }}>· {error}</span>}
      </button>
    );
  }

  return (
    <div
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 70,
        width: minimised ? 190 : 260, borderRadius: 14, overflow: 'hidden',
        background: '#0f1222', boxShadow: '0 10px 34px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.10)', cursor: 'grab', touchAction: 'none',
      }}
    >
      {/* Remote face — the big one */}
      <div style={{ position: 'relative', background: '#000', aspectRatio: '4 / 3', display: minimised ? 'none' : 'block' }}>
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: connected ? 'block' : 'none' }}
        />
        {!connected && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'rgba(255,255,255,0.65)', fontSize: 12.5, textAlign: 'center', padding: 12,
          }}>
            {peerReady ? 'Connecting…' : 'Waiting for the other person to join…'}
          </div>
        )}
        {/* Self-view, small */}
        <div style={{ position: 'absolute', right: 8, bottom: 8, width: 78, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.2)', background: '#111' }}>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '100%', display: 'block', transform: 'scaleX(-1)' }} />
          <div style={{ fontSize: 9, color: '#fff', textAlign: 'center', padding: '1px 0 2px', opacity: 0.75 }}>{selfLabel}</div>
        </div>
      </div>

      {/* Device menu — opens above the bar, like a system picker */}
      {menu && (
        <div style={{
          background: '#fff', color: '#0A0A0F', borderTop: '1px solid rgba(0,0,0,0.08)',
          maxHeight: 220, overflowY: 'auto', fontSize: 12.5,
        }}>
          {menu === 'mic' ? (
            <>
              <MenuHeading>Select a microphone</MenuHeading>
              {devices.filter(d => d.kind === 'audioinput').map((d, i) => (
                <MenuItem key={d.deviceId} selected={micId ? micId === d.deviceId : i === 0}
                  onClick={() => switchDevice('audio', d.deviceId)}>
                  {d.label || `Microphone ${i + 1}`}
                </MenuItem>
              ))}
              <MenuHeading>Select a speaker</MenuHeading>
              {devices.filter(d => d.kind === 'audiooutput').length === 0 && (
                <MenuNote>Your browser doesn’t allow choosing a speaker — it uses the system default.</MenuNote>
              )}
              {devices.filter(d => d.kind === 'audiooutput').map((d, i) => (
                <MenuItem key={d.deviceId} selected={spkId ? spkId === d.deviceId : i === 0}
                  onClick={() => switchSpeaker(d.deviceId)}>
                  {d.label || `Speaker ${i + 1}`}
                </MenuItem>
              ))}
            </>
          ) : (
            <>
              <MenuHeading>Select a camera</MenuHeading>
              {devices.filter(d => d.kind === 'videoinput').length === 0 && (
                <MenuNote>No cameras found.</MenuNote>
              )}
              {devices.filter(d => d.kind === 'videoinput').map((d, i) => (
                <MenuItem key={d.deviceId} selected={camId ? camId === d.deviceId : i === 0}
                  onClick={() => switchDevice('video', d.deviceId)}>
                  {d.label || `Camera ${i + 1}`}
                </MenuItem>
              ))}
              <MenuHeading>Video effects</MenuHeading>
              <MenuItem selected={blur === 'light'} onClick={() => applyBlur('light')}>Light background blur</MenuItem>
              <MenuItem selected={blur === 'strong'} onClick={() => applyBlur('strong')}>Strong background blur</MenuItem>
              <MenuItem selected={blur === 'off'} onClick={() => applyBlur('off')} danger>Stop background blur</MenuItem>
              {!blurSupported && blur === 'off' && (
                <MenuNote>First use downloads a small model, so give it a few seconds.</MenuNote>
              )}
            </>
          )}
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: 8, background: '#151832' }}>
        <button onClick={toggleMic} style={{ ...btn, background: micOn ? 'rgba(255,255,255,0.14)' : '#b91c1c' }} title={micOn ? 'Mute' : 'Unmute'}>
          {micOn ? '🎤' : '🔇'}
        </button>
        <button onClick={() => setMenu(m => m === 'mic' ? null : 'mic')} style={{ ...btn, padding: '6px 5px' }} title="Microphone & speaker options">▾</button>
        <button onClick={toggleCam} style={{ ...btn, background: camOn ? 'rgba(255,255,255,0.14)' : '#b91c1c' }} title={camOn ? 'Turn camera off' : 'Turn camera on'}>
          {camOn ? '📹' : '🚫'}
        </button>
        <button onClick={() => setMenu(m => m === 'cam' ? null : 'cam')} style={{ ...btn, padding: '6px 5px' }} title="Camera & video options">▾</button>
        <button onClick={() => setMinimised(m => !m)} style={btn} title={minimised ? 'Expand' : 'Minimise'}>
          {minimised ? '▢' : '—'}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={() => stopCall()} style={{ ...btn, background: '#dc2626' }} title="End call">End</button>
      </div>
      {blurLoading && (
        <div style={{ padding: '6px 8px', background: '#1e293b', color: '#cbd5e1', fontSize: 11 }}>
          Preparing background blur…
        </div>
      )}
      {error && (
        <div style={{ padding: '6px 8px', background: '#7f1d1d', color: '#fff', fontSize: 11 }}>{error}</div>
      )}
    </div>
  );
}

// ── Small presentational pieces for the device menu ──
function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: '8px 12px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: '#8A91A0',
    }}>{children}</div>
  );
}

function MenuItem({ children, onClick, selected, danger }: {
  key?: Key;
  children: ReactNode; onClick: () => void; selected?: boolean; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '8px 12px', border: 0, background: selected ? 'rgba(79,70,229,0.08)' : 'transparent',
        color: danger ? '#DC2626' : '#0A0A0F', cursor: 'pointer',
        fontSize: 12.5, fontWeight: selected ? 700 : 500, textAlign: 'left',
      }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
      {selected && <span style={{ color: '#4F46E5', fontWeight: 700 }}>✓</span>}
    </button>
  );
}

function MenuNote({ children }: { children: ReactNode }) {
  return <div style={{ padding: '6px 12px 10px', fontSize: 11.5, color: '#8A91A0', lineHeight: 1.45 }}>{children}</div>;
}
