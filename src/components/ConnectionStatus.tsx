import React, { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

interface ConnectionStatusProps {
  socket: Socket | null;
  connected: boolean;
}

export default function ConnectionStatus({ socket, connected }: ConnectionStatusProps) {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'disconnected' | 'connecting'>('connecting');
  const [attempts, setAttempts] = useState(0);
  const [showToast, setShowToast] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  // AUTONOMOUS: [ORDER-3 FRICTION] - Refs to fix two real bugs in this
  // component:
  //   1. The "✅ Reconnected!" toast used to fire on the very first
  //      successful connect (initial page load) because status started at
  //      'disconnected'. Track whether we've EVER connected before to
  //      distinguish first-time connect from a real reconnect.
  //   2. The onConnect closure captured `status` at effect-mount time, so
  //      it always saw the initial value. Use a ref for the freshness
  //      check.
  const hasConnectedOnceRef = useRef(false);
  const wasOfflineRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showAutoToast = (msg: string, ms = 3000) => {
    setToastMsg(msg);
    setShowToast(true);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setShowToast(false), ms);
  };

  useEffect(() => {
    if (!socket) return;

    const onConnect = () => {
      setStatus('connected');
      setAttempts(0);
      if (hasConnectedOnceRef.current && wasOfflineRef.current) {
        // Genuine reconnect (not first-ever connect on page load).
        showAutoToast('✅ Reconnected — your changes are syncing again');
      }
      hasConnectedOnceRef.current = true;
      wasOfflineRef.current = false;
    };

    const onDisconnect = () => {
      setStatus('disconnected');
      wasOfflineRef.current = true;
      showAutoToast('⚠️ Disconnected — trying to reconnect…', 4000);
    };

    const onReconnectAttempt = (attempt: number) => {
      setStatus('reconnecting');
      setAttempts(attempt);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.io.on('reconnect_attempt' as any, onReconnectAttempt);

    // Initial state — if the socket is already connected when the
    // component mounts (HMR / late mount), reflect that immediately.
    if (socket.connected) {
      setStatus('connected');
      hasConnectedOnceRef.current = true;
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.io.off('reconnect_attempt' as any, onReconnectAttempt);
    };
  }, [socket]);

  useEffect(() => {
    // The parent passes `connected` as a prop; honour it but DON'T overwrite
    // a more specific state ('reconnecting' / 'connecting') with a
    // generic 'disconnected' on every render.
    if (connected) {
      setStatus('connected');
      hasConnectedOnceRef.current = true;
      wasOfflineRef.current = false;
    } else if (status === 'connected') {
      setStatus('disconnected');
      wasOfflineRef.current = true;
    }
  }, [connected]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const statusConfig = {
    connected: { color: '#10B981', label: 'Connected', icon: '🟢' },
    connecting: { color: '#94a3b8', label: 'Connecting…', icon: '⚪' },
    reconnecting: { color: '#F59E0B', label: `Reconnecting (${attempts})`, icon: '🟡' },
    disconnected: { color: '#F43F5E', label: 'Disconnected', icon: '🔴' },
  };

  const cfg = statusConfig[status];

  return (
    <>
      {/* Inline indicator */}
      <div className="flex items-center gap-1.5 tooltip-wrapper" data-tooltip={cfg.label}>
        <div className="w-2 h-2 rounded-full" style={{
          background: cfg.color,
          boxShadow: `0 0 6px ${cfg.color}60`,
          animation: status === 'reconnecting' ? 'dot-pulse 1s ease-in-out infinite' : 'none',
        }} />
        {status !== 'connected' && (
          <span className="text-[11px] font-medium" style={{ color: cfg.color }}>
            {cfg.label}
          </span>
        )}
      </div>

      {/* Toast notification */}
      {showToast && (
        <div className="fixed top-3 right-3 z-[999] animate-slide-in-right">
          <div className="px-4 py-2.5 rounded-xl text-sm font-medium"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
              boxShadow: 'var(--shadow-lg)',
            }}>
            {toastMsg}
          </div>
        </div>
      )}
    </>
  );
}
