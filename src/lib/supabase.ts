import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveConfig, fetchRuntimeConfig } from './runtimeConfig';

// ── Supabase client (teacher auth + records) ──────────────────────────────
//
// Auth is OFF unless a usable URL *and* anon key are found. With it off the app
// behaves exactly as before: link-based rooms, the whiteboard and live sync all
// work with no login. Only the records side is unavailable.
//
// These are `let`, not `const`, and that is deliberate. Credentials may only
// arrive from the server (see runtimeConfig — a host that injects environment
// variables at run time produces a bundle with nothing baked in), so the client
// is built in initSupabase() before React mounts. ES module live bindings mean
// every `import { supabase }` sees the assignment; no caller needs changing.
//
// The client is NEVER constructed without validated credentials. Calling
// createClient('') throws during module evaluation and takes down the entire
// app — a blank page instead of a whiteboard, for a tutor who simply has no
// database configured.
//
// The anon key is public by design; row-level security protects the data. The
// service-role key must never reach this file.

export let isAuthEnabled = false;
export let supabase: SupabaseClient | null = null;

function build(config: { url: string; anonKey: string }): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // So the magic-link redirect (?code=…) is consumed into a session.
      detectSessionInUrl: true,
    },
  });
}

let started: Promise<void> | null = null;

/**
 * Resolve credentials and build the client. Safe to call more than once.
 *
 * Awaited before the app renders, so anything reading `supabase` during the
 * first paint sees the final answer rather than a null that later changes.
 */
export function initSupabase(): Promise<void> {
  if (started) return started;
  started = (async () => {
    const fromBuild = {
      url: import.meta.env.VITE_SUPABASE_URL,
      anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    };
    // Only ask the server when the build had nothing — saves a request on
    // every normal deployment.
    let config = resolveConfig(fromBuild, null);
    if (!config) config = resolveConfig(fromBuild, await fetchRuntimeConfig());
    if (!config) return;                     // no database: a valid state
    try {
      supabase = build(config);
      isAuthEnabled = true;
    } catch {
      // Belt and braces. Even validated input must not be able to blank the
      // page; running without records beats not running.
      supabase = null;
      isAuthEnabled = false;
    }
  })();
  return started;
}
