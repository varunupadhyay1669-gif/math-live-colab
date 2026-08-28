import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, NotSignedIn } from './api';

// Teacher sign-in, served by this application.
//
// Replaces Supabase Auth. What changed for anything using this file: nothing —
// `enabled`, `loading`, `user`, `signInWithEmail`, `signOut` all mean what they
// meant before. What changed underneath is worth knowing:
//
//   * The session is an HttpOnly cookie, so JavaScript cannot read it. That is
//     strictly safer than the previous token in localStorage, which any script
//     on the page could have taken. It also means the socket handshake carries
//     the session automatically and no longer needs a token passed by hand.
//   * There is no auth SDK to download. The 210 kB chunk this file worked hard
//     to lazy-load does not exist any more.
//   * There is no third party in the sign-in path, which removes the failure
//     the watchdog below was written for — a hosted service being slow or over
//     quota leaving every teacher on "Loading…" forever. The watchdog is kept
//     anyway: our own server can be slow too, and a spinner with no way out is
//     the worst possible answer.

/** Shaped like the old Supabase user, so screens reading `.email` still work. */
export interface AuthUser { id: string; email: string; }

interface AuthState {
  /** True when accounts are available at all (the server has a database). */
  enabled: boolean;
  /** True until the initial session check resolves (avoids a login flash). */
  loading: boolean;
  session: { user: AuthUser } | null;
  user: AuthUser | null;
  /** Send a passwordless magic-link to `email`. Returns an error message on failure. */
  signInWithEmail: (email: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  // Accounts are assumed available until the server says otherwise, so the
  // sign-in button is not hidden from a teacher during the first round trip.
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let active = true;
    const settle = () => { if (active) setLoading(false); };
    // A spinner that never resolves is indistinguishable from a broken app.
    const watchdog = setTimeout(() => {
      console.warn('Auth did not resolve in time — rendering as signed out.');
      settle();
    }, 8000);

    api.get<{ user: AuthUser | null }>('/api/auth/me')
      .then(({ user }) => { if (active) setUser(user); })
      .catch((err) => {
        if (!active) return;
        // 404 means this server has no accounts configured — a valid state, and
        // the app must run without them. Anything else is simply signed out.
        if (err?.status === 404) setEnabled(false);
        setUser(null);
      })
      .finally(() => { clearTimeout(watchdog); settle(); });

    return () => { active = false; clearTimeout(watchdog); };
  }, []);

  const signInWithEmail = useCallback(async (email: string): Promise<{ error?: string }> => {
    try {
      await api.post('/api/auth/magic-link', { email: email.trim() });
      return {};
    } catch (err) {
      return { error: (err as Error).message || 'Could not send the sign-in link.' };
    }
  }, []);

  const signOut = useCallback(async () => {
    try { await api.post('/api/auth/signout'); } catch { /* clearing locally is what matters */ }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        enabled,
        loading,
        session: user ? { user } : null,
        user,
        signInWithEmail,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Provider not mounted — a disabled stub so callers can render the
    // no-account path without crashing.
    return {
      enabled: false,
      loading: false,
      session: null,
      user: null,
      signInWithEmail: async () => ({}),
      signOut: async () => {},
    };
  }
  return ctx;
}

// NotSignedIn is re-exported so screens can distinguish "you are signed out"
// from "something went wrong" without importing the API client themselves.
export { NotSignedIn };
