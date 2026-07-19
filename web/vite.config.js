import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from the domain root on Vercel (unlike mobile-web, which the harness
// mounts at /m). The api/ directory is deployed as Vercel serverless functions
// and is not part of this bundle; `vercel dev` serves both together locally.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // `npm run dev` against a `vercel dev` instance running on :3000
      '/api': 'http://localhost:3000',
    },
  },
});
