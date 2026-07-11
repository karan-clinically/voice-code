import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the harness at /m, so assets must resolve under /m/.
export default defineConfig({
  root: 'src',
  base: '/m/',
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
