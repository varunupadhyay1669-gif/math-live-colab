import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ── Supabase client (teacher auth + records) ──────────────────────────────
// Auth is OFF unless BOTH public env vars are present at build time. When off,
// the app behaves exactly as before — link-based rooms work with no login, so
// nothing about the current deployment changes until you opt in. To enable
// teacher accounts, set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see
// SUPABASE.md) and redeploy.
//
// These are the *public* anon keys — safe to ship to the browser. Row-Level
// Security on the database is what actually protects each teacher's records;
// never put the service-role key in client code.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isAuthEnabled: boolean = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isAuthEnabled
  ? createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Needed so the OAuth redirect (?code=…) is consumed and turned into a
        // session when Google sends the teacher back to the app.
        detectSessionInUrl: true,
      },
    })
  : null;
