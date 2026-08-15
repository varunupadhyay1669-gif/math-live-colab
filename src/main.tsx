import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// AUTONOMOUS: KaTeX styles for math text rendering. Loaded at root so the
// .katex CSS classes are available wherever a math label appears.
import 'katex/dist/katex.min.css';
import { initConfig } from './lib/runtimeConfig';
import { initSupabase } from './lib/supabase';

// Resolve the database credentials, then paint.
//
// Two separate steps, and the split is the point:
//
//   initConfig()   — cheap. Reads the build-time variables and, only if those
//                    are empty, makes one small request to /api/config. No SDK.
//   initSupabase() — expensive. Downloads @supabase/supabase-js (55 kB gzipped)
//                    and constructs the client.
//
// Only the cheap half is awaited. It settles `authConfigured`, which is all the
// first render needs in order to decide whether a sign-in UI belongs on screen
// — so there is still no flash of a signed-out page, which is why this awaited
// at all. The SDK then downloads alongside React while the shell is already
// painting, and AuthProvider's `loading` state covers the gap until the session
// check finishes.
//
// Blocking the first paint on the SDK, as this used to, meant every student on
// an iPad waited for an auth library they would never use before seeing a
// single pixel. Students never sign in.
//
// Neither call rejects — an unconfigured or unreachable server simply means the
// app runs without records, which is a supported state.
void initConfig().finally(() => {
  // Kick off the client build, but do not wait for it. Anything that needs the
  // client awaits getSupabase(), so there is no window where a caller sees a
  // null and mistakes it for "no database configured".
  void initSupabase();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
