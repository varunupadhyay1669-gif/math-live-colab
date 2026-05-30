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
  /** Send a passwordless magic-link to `email`. Returns an error message on failure. */
  signInWithEmail: (email: string) => Promise<{ error?: string }>;
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

  const signInWithEmail = useCallback(async (email: string): Promise<{ error?: string }> => {
    const { supabase } = await import('./supabase');
    if (!supabase) return { error: 'Auth not configured' };
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // Where the link in the email lands the teacher. This URL must be in
      // Supabase → Auth → URL Configuration (Site URL / Redirect URLs).
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    return { error: error?.message };
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
    // Provider not mounted — return a disabled stub so callers can safely
    // render the no-auth path without crashing.
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
