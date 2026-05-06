/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Room from './pages/Room';
import StudentView from './pages/StudentView';
import ErrorBoundary from './components/ErrorBoundary';
import ShortcutsOverlay from './components/ShortcutsOverlay';

export default function App() {
  return (
    // AUTONOMOUS: [ORDER-1 CRITICAL] - Wraps the whole tree so a crash on any
    // page (Home / Room / StudentView) shows a recoverable error instead of
    // a blank white screen.
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/room/:roomId" element={<Room />} />
          <Route path="/live/:roomId" element={<StudentView />} />
          {/* Backward compatibility */}
          <Route path="/student/:roomId" element={<StudentView />} />
        </Routes>
        {/* AUTONOMOUS: [ORDER-3 FRICTION] - Mounted once at the root so the
            `?` shortcut works on every page. Self-contained — no props. */}
        <ShortcutsOverlay />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
