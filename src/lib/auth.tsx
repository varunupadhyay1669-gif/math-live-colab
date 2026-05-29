import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session, User } from '@supabase/supabase-js';

// SDK-free, build-time flag. We only dynamically import the Supabase client
// (a sizeable chunk) when auth is actually enabled, so the no-login deployment
// and every student device never download it. `import type` above is erased at
// build time and does NOT pull the SDK into the bundle.
const isAuthEnabled: boolean = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);

interface AuthState {
  /** True when Supabase is configured (the two VITE_ env vars are set). */
  enabled: boolean;
  /** True until the initial session check resolves (avoids a login flash). */
  loading: boolean;
  session: Session | null;
  user: User | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Only "loading" when auth is enabled — otherwise resolve instantly so the
  // no-login app renders without delay.
  const [loading, setLoading] = useState<boolean>(isAuthEnabled);

  useEffect(() => {
    if (!isAuthEnabled) {
      setLoading(false);
      return;
    }
    let active = true;
    let unsub: (() => void) | undefined;
    // Lazy chunk — fetched only because auth is enabled.
    import('./supabase')
      .then(({ supabase }) => {
        if (!active) return;
        if (!supabase) {
          setLoading(false);
          return;
        }
        supabase.auth.getSession().then(({ data }) => {
          if (!active) return;
          setSession(data.session);
          setLoading(false);
        });
        const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
          setSession(s);
        });
        unsub = () => sub.subscription.unsubscribe();
      })
      .catch((err) => {
        console.error('Failed to load auth:', err);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsub?.();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { supabase } = await import('./supabase');
    if (!supabase) return;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      // Return to wherever the teacher started. Students never hit this path.
      options: { redirectTo: window.location.origin },
    });
  }, []);

  const signOut = useCallback(async () => {
    const { supabase } = await import('./supabase');
    if (!supabase) return;
    await supabase.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        enabled: isAuthEnabled,
        loading,
        session,
        user: session?.user ?? null,
        signInWithGoogle,
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
    // Provider not mounted — return a disabled stub so callers can safely
    // render the no-auth path without crashing.
    return {
      enabled: false,
      loading: false,
      session: null,
      user: null,
      signInWithGoogle: async () => {},
      signOut: async () => {},
    };
  }
  return ctx;
}
