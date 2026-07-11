import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer is a plain SPA. base './' so the production build loads from file://.
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
