import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session, User } from '@supabase/supabase-js';

// Read the resolved flag rather than import.meta.env directly. Credentials may
// have arrived at RUN time from the server, in which case the build-time
// variables are empty and this flag would have said "no auth" on a deployment
// with a perfectly good database. initConfig() has already resolved by the time
// anything renders (see main.tsx).
//
// Imported from runtimeConfig, NOT from ./supabase. Both export this flag, but
// ./supabase carries the client; importing the flag from there pulled the whole
// auth SDK into the entry bundle and undid the lazy import below.
import { authConfigured } from './runtimeConfig';

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
  const isAuthEnabled = authConfigured;
  const [loading, setLoading] = useState<boolean>(isAuthEnabled);

  useEffect(() => {
    if (!isAuthEnabled) {
      setLoading(false);
      return;
    }
    let active = true;
    let unsub: (() => void) | undefined;
    // Never let a third-party service strand the whole app.
    //
    // getSession() below can hang rather than fail: with an expired token it
    // goes to the network to refresh, and if Supabase is slow, throttled or
    // over quota that request may never settle. Nothing else clears `loading`,
    // so every auth-gated page — the dashboard, a student's page, /admin —
    // sat on "Loading…" indefinitely with no message and no way out. That is
    // indistinguishable from the app being broken.
    //
    // After this deadline we give up waiting and render as signed-out. The
    // session, if it does arrive later, still lands via onAuthStateChange and
    // the UI corrects itself. Showing a sign-in button a few seconds early is
    // a small wrong; a permanent spinner is a much larger one.
    const settle = () => { if (active) setLoading(false); };
    const watchdog = setTimeout(() => {
      console.warn('Auth did not resolve in time — rendering as signed out.');
      settle();
    }, 8000);
    // Lazy chunk — fetched only because auth is enabled. getSupabase() awaits
    // the client being built rather than reading whatever `supabase` happens to
    // hold right now: the first paint no longer waits for the SDK, so reading
    // the binding directly could catch a null mid-construction and report "not
    // signed in" to a teacher who is.
    import('./supabase')
      .then(({ getSupabase }) => getSupabase())
      .then((supabase) => {
        if (!active) return;
        if (!supabase) {
          settle();
          return;
        }
        // .catch is not optional here. Without it a rejected getSession()
        // left `loading` true forever — the outer .catch below never sees it,
        // because this promise was not returned into that chain.
        supabase.auth.getSession()
          .then(({ data }) => {
            if (!active) return;
            setSession(data.session);
          })
          .catch((err) => {
            console.error('Could not read the saved session:', err);
          })
          .finally(settle);
        const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
          setSession(s);
        });
        unsub = () => sub.subscription.unsubscribe();
      })
      .catch((err) => {
        console.error('Failed to load auth:', err);
        settle();
      });
    return () => {
      active = false;
      clearTimeout(watchdog);
      unsub?.();
    };
  }, []);

  const signInWithEmail = useCallback(async (email: string): Promise<{ error?: string }> => {
    const { getSupabase } = await import('./supabase');
    const supabase = await getSupabase();
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
    const { getSupabase } = await import('./supabase');
    const supabase = await getSupabase();
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
