import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// AUTONOMOUS: KaTeX styles for math text rendering. Loaded at root so the
// .katex CSS classes are available wherever a math label appears.
import 'katex/dist/katex.min.css';
import { initSupabase } from './lib/supabase';

// Resolve the database credentials before the first render.
//
// They may only be available from the server: a host that injects environment
// variables at RUN time leaves a Vite build with nothing baked in, so the app
// has to ask. Awaiting here means the first paint already knows whether auth
// exists, instead of flashing a signed-out UI and correcting itself.
//
// It never rejects — an unconfigured or unreachable server simply means the
// app runs without records, which is a supported state.
void initSupabase().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
