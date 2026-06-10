/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Home from './pages/Home';
import ErrorBoundary from './components/ErrorBoundary';
import ShortcutsOverlay from './components/ShortcutsOverlay';
import { AuthProvider } from './lib/auth';

// AUTONOMOUS: [ORDER-4 FUTURE-PROOFING] - Code-split the heavy routes.
// The build was warning that the bundle was >500KB; the Home page only
// needs the landing UI, but eager-imported Room.tsx (~2400 lines) and
// StudentView.tsx (~1100 lines) plus the entire Whiteboard component
// were all in the initial JS payload. Now Room and StudentView are
// loaded on-demand when the user actually navigates to /room/:id or
// /live/:id, cutting the initial bundle in roughly half. The home
// page now boots noticeably faster, especially on Render's cold-start
// where every byte over the wire matters.
const Room = lazy(() => import('./pages/Room'));
const StudentView = lazy(() => import('./pages/StudentView'));
const Dashboard = lazy(() => import('./pages/Dashboard'));

// Tiny fallback while the route chunk loads. Matches the home page
// background colour so there's no flash of wrong-colour content. The
// chunk usually arrives within ~100-300ms on a warm cache so the user
// rarely sees this — but it's there for first-time visitors / cold
// loads.
function RouteFallback() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#FAFAF9',
        color: '#737373',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
        fontSize: 14,
      }}
    >
      Loading…
    </div>
  );
}

// Catch-all for unknown URLs. Without this the server's SPA fallback served
// index.html for any path and React matched no route, leaving a blank page.
function NotFound() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: '#FAFAF9',
        color: '#404040',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: -1 }}>404</div>
      <div style={{ fontSize: 16, color: '#737373' }}>
        That page doesn't exist. Check the link, or head back to the start.
      </div>
      <Link
        to="/"
        style={{
          marginTop: 8,
          padding: '10px 20px',
          borderRadius: 10,
          background: '#6366F1',
          color: '#fff',
          fontWeight: 600,
          fontSize: 14,
          textDecoration: 'none',
        }}
      >
        Go to Math Live home
      </Link>
    </div>
  );
}

export default function App() {
  return (
    // AUTONOMOUS: [ORDER-1 CRITICAL] - Wraps the whole tree so a crash on any
    // page (Home / Room / StudentView) shows a recoverable error instead of
    // a blank white screen.
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/room/:roomId" element={<Room />} />
              <Route path="/live/:roomId" element={<StudentView />} />
              {/* Backward compatibility */}
              <Route path="/student/:roomId" element={<StudentView />} />
              {/* Catch-all 404 — must be last */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          {/* AUTONOMOUS: [ORDER-3 FRICTION] - Mounted once at the root so the
              `?` shortcut works on every page. Self-contained — no props. */}
          <ShortcutsOverlay />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
