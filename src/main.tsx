import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// AUTONOMOUS: KaTeX styles for math text rendering. Loaded at root so the
// .katex CSS classes are available wherever a math label appears.
import 'katex/dist/katex.min.css';
// Paint immediately.
//
// This used to resolve database credentials before the first render, and then
// download an auth SDK alongside it. Both are gone: teacher accounts are served
// by this application now, so there are no third-party credentials to discover
// and no library to fetch. AuthProvider asks /api/auth/me once, on its own, and
// covers the wait with its `loading` state.
//
// What that removes is not abstract. Every student on an iPad used to wait for
// an authentication library they would never use — students never sign in —
// before a single pixel appeared.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
