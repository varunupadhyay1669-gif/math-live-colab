import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// AUTONOMOUS: KaTeX styles for math text rendering. Loaded at root so the
// .katex CSS classes are available wherever a math label appears.
import 'katex/dist/katex.min.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
