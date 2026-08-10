// Where the Supabase credentials come from.
//
// They were build-time only: `import.meta.env.VITE_SUPABASE_URL` is substituted
// when Vite builds, so a host that injects environment variables at RUN time
// produces a bundle with nothing in it. That is exactly what happened on Google
// AI Studio — the deployment ran perfectly but had no database, no login, no
// dashboard and no admin page, and setting the variables afterwards changed
// nothing because the build had already happened.
//
// So the server also offers them at /api/config, and the client falls back to
// that. Build-time still wins when present: it costs no request.
//
// Only ever the PUBLIC pair. The anon key is designed to be shipped to
// browsers — row-level security is what protects the data. The service-role key
// must never come near this path.

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * Is this a URL the Supabase client will accept?
 *
 * The guard exists because of a real crash: with the variables unset, calling
 * createClient('') throws "Invalid supabaseUrl: Must be a valid HTTP or HTTPS
 * URL" during module evaluation, which takes down the WHOLE app — not just
 * login. A tutor with no database configured got a blank page instead of a
 * working whiteboard.
 */
export function validSupabaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Accept a bare project ref where a URL was expected.
 *
 * The Supabase dashboard shows the ref ("umskfpcvaiybdxlnpcck") prominently
 * next to the URL, and pasting the ref into SUPABASE_URL is an easy mistake —
 * it is the one that took the AI Studio deployment down, because createClient
 * rejects it and throws during module evaluation.
 *
 * A ref is 20 lowercase letters with no dot, slash or protocol, so it cannot be
 * confused with a URL or with anything else that belongs in this field. Rather
 * than fail on a value whose intent is unambiguous, expand it.
 */
export function coerceSupabaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  if (validSupabaseUrl(raw)) return raw;
  if (/^[a-z]{20}$/.test(raw)) return `https://${raw}.supabase.co`;
  // A host with no protocol — "umsk….supabase.co" — is also unambiguous.
  if (/^[a-z0-9-]+\.supabase\.(co|in)$/.test(raw)) return `https://${raw}`;
  return null;
}

function usableKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 20;
}

/**
 * Pick the credentials to use, or null for "run without a database".
 *
 * Null is a first-class outcome, not a failure: link-based rooms, the
 * whiteboard and live sync all work with no account at all. Only the records
 * side needs Supabase.
 */
export function resolveConfig(
  build: { url?: unknown; anonKey?: unknown },
  fetched?: { url?: unknown; anonKey?: unknown } | null,
): SupabaseConfig | null {
  // Build-time first: already in the bundle, no round trip.
  const fromBuild = coerceSupabaseUrl(build.url);
  if (fromBuild && usableKey(build.anonKey)) {
    return { url: fromBuild, anonKey: (build.anonKey as string).trim() };
  }
  const fromServer = fetched ? coerceSupabaseUrl(fetched.url) : null;
  if (fromServer && usableKey(fetched?.anonKey)) {
    return { url: fromServer, anonKey: (fetched!.anonKey as string).trim() };
  }
  // Half a configuration is not a configuration. Proceeding with one of the
  // two produces the crash this module exists to prevent.
  return null;
}

/** Ask the server. Never throws — an unreachable server just means no auth. */
export async function fetchRuntimeConfig(): Promise<{ url?: string; anonKey?: string } | null> {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return { url: body?.supabaseUrl, anonKey: body?.supabaseAnonKey };
  } catch {
    return null;
  }
}
