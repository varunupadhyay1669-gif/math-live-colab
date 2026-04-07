/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Room from './pages/Room';
import StudentView from './pages/StudentView';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:roomId" element={<Room />} />
        <Route path="/live/:roomId" element={<StudentView />} />
        {/* Backward compatibility */}
        <Route path="/student/:roomId" element={<StudentView />} />
      </Routes>
    </BrowserRouter>
  );
}
