import type { SupabaseClient } from '@supabase/supabase-js';
import { initConfig, resolvedConfig, authConfigured } from './runtimeConfig';

// ── Supabase client (teacher auth + records) ──────────────────────────────
//
// Auth is OFF unless a usable URL *and* anon key are found. With it off the app
// behaves exactly as before: link-based rooms, the whiteboard and live sync all
// work with no login. Only the records side is unavailable.
//
// `supabase` is `let`, not `const`, and that is deliberate. Credentials may
// only arrive from the server (see runtimeConfig — a host that injects
// environment variables at run time produces a bundle with nothing baked in),
// so the client is built in initSupabase() before React mounts. ES module live
// bindings mean every `import { supabase }` sees the assignment; no caller
// needs changing.
//
// The client is NEVER constructed without validated credentials. Calling
// createClient('') throws during module evaluation and takes down the entire
// app — a blank page instead of a whiteboard, for a tutor who simply has no
// database configured.
//
// The anon key is public by design; row-level security protects the data. The
// service-role key must never reach this file.
//
// NOTE the `import type` above, and the dynamic import inside build(). A value
// import of @supabase/supabase-js here would put 210 kB (55 kB gzipped) of auth
// SDK in the entry bundle for every visitor — including students, who never
// sign in and never need a line of it. `import type` is erased at compile time,
// so the types cost nothing and the code arrives only when auth is actually on.

export let isAuthEnabled = false;
export let supabase: SupabaseClient | null = null;

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
    const config = await initConfig();
    if (!config) return;                     // no database: a valid state
    try {
      // Fetched only when there are real credentials to use it with.
      const { createClient } = await import('@supabase/supabase-js');
      supabase = createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // So the magic-link redirect (?code=…) is consumed into a session.
          detectSessionInUrl: true,
        },
      });
      isAuthEnabled = true;
    } catch {
      // Belt and braces. Even validated input must not be able to blank the
      // page; running without records beats not running. A failed chunk fetch
      // (flaky network) lands here too, and costs records rather than the app.
      supabase = null;
      isAuthEnabled = false;
    }
  })();
  return started;
}

/**
 * The client, once it exists.
 *
 * Prefer this over importing `supabase` directly when you cannot be sure
 * initSupabase() has settled — it awaits rather than handing back a null that
 * would read as "no database configured".
 */
export async function getSupabase(): Promise<SupabaseClient | null> {
  await initSupabase();
  return supabase;
}

// Re-exported so callers that only need the flag can read it without pulling in
// this module's dependencies. Prefer importing it from runtimeConfig directly.
export { authConfigured, resolvedConfig };
