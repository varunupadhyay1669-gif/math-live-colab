import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    // NOTE: there is deliberately no `define` block for GEMINI_API_KEY here.
    //
    // There used to be:
    //   define: { 'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY) }
    //
    // `loadEnv(mode, '.', '')` reads every variable, not just VITE_-prefixed
    // ones, so that line substituted the raw key as a string literal into the
    // browser bundle — downloadable by anyone who opened the site. Nothing in
    // src/ ever read it: the key is used only in server.ts, which reads
    // process.env directly at runtime and never ships to the client.
    // Re-adding this leaks the key. Server-only secrets stay server-side.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          // Split the framework away from application code.
          //
          // These packages change only when a dependency is upgraded, while
          // app code changes on every deploy. Bundled together, one typo-fix
          // deploy invalidates ~140 kB gzipped for every returning student.
          // Split, their browser re-uses the cached vendor chunk and downloads
          // only what actually changed — which matters most on the phones and
          // iPads students join from, often on mobile data.
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-socket': ['socket.io-client'],
            // 'vendor-supabase' is gone with the dependency: teacher accounts are
            // served by this application, so no auth SDK reaches the browser.
          },
        },
      },
      // The heavy chunks (Whiteboard, pdf, html2canvas) are already lazy —
      // they load on demand, not on first paint. Warning about them on every
      // build trains you to ignore build output, so raise the bar to a size
      // that would signal something genuinely new had crept into the entry.
      chunkSizeWarningLimit: 600,
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
