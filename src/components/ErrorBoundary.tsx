// AUTONOMOUS: [ORDER-1 CRITICAL] - Without this, any uncaught render error
// crashes the entire app to a blank white screen with no recovery path. The
// teacher loses their lesson, students get a dead tab. Shipping a real
// product without an error boundary is a bug.
//
// Implementation note: this codebase doesn't have @types/react installed
// (React 19 ships its own runtime; types come transitively via skipLibCheck
// and allowJs). So `extends React.Component<P, S>` doesn't get proper
// generic typing for `state` / `setState` / `props`. We work around that
// with a small `any` cast on the class declaration — only this file pays
// that cost, and the runtime behaviour is exactly what an error boundary
// should be.

import React, { Fragment } from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  // Stable identity so we can force a remount when the user clicks "Try again"
  resetKey: number;
}

const ReactComponent = (React as any).Component as new <P, S>(props: P) => {
  state: S;
  props: P;
  setState: (updater: ((s: S) => Partial<S>) | Partial<S>) => void;
};

export default class ErrorBoundary extends (ReactComponent as any) {
  constructor(props: Props) {
    super(props);
    (this as any).state = { error: null, resetKey: 0 } as State;
    (this as any).handleReset = this.handleReset.bind(this);
    (this as any).handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    // Log to the console with a clear marker so it's findable in production
    // logs. Sentry / a real telemetry sink is a follow-up; this is the
    // minimum responsible behaviour today.
    console.error('[ErrorBoundary] caught', error, info);
  }

  handleReset() {
    (this as any).setState((s: State) => ({ error: null, resetKey: s.resetKey + 1 }));
  }

  handleReload() {
    window.location.reload();
  }

  render() {
    const state = (this as any).state as State;
    const props = (this as any).props as Props;
    if (!state.error) {
      // Wrap children in a Fragment with key so "Try again" forces a remount
      // and re-runs all useEffects. Without this the same broken state would
      // re-throw immediately.
      return <Fragment key={state.resetKey}>{props.children}</Fragment>;
    }
    const message = state.error.message || 'An unexpected error occurred.';
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: '#FAFAF9',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          color: '#0A0A0F',
        }}
      >
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 12px' }}>Something went sideways</h1>
          <p style={{ fontSize: 15, color: '#525252', margin: '0 0 24px', lineHeight: 1.5 }}>
            The page hit an unexpected error. Your work is most likely safe on the server — try
            reloading first; if it persists, let us know what you were doing.
          </p>
          <details
            style={{
              textAlign: 'left',
              fontSize: 12,
              color: '#737373',
              background: '#fff',
              border: '1px solid #E5E7EB',
              borderRadius: 10,
              padding: '12px 14px',
              marginBottom: 20,
            }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Technical detail</summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{message}</pre>
          </details>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              onClick={(this as any).handleReset}
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                border: '1px solid #D4D4D8',
                background: '#fff',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              onClick={(this as any).handleReload}
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                border: 'none',
                background: '#4F46E5',
                color: '#fff',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
