/// <reference types="vite/client" />

// Public (anon) Supabase credentials, inlined at build time by Vite. Both must
// be present to enable teacher accounts; when absent the app runs in its
// original no-login mode. See SUPABASE.md.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
