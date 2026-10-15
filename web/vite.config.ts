import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = resolve(__dirname, '..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@mocks': resolve(repoRoot, 'mocks') },
  },
  server: {
    port: 5173,
    // mocks/ lives outside web/, so Vite needs permission to read it.
    fs: { allow: [repoRoot] },
    proxy: {
      // Override when the API is on another port, e.g. two servers side by side.
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // Phaser is most of the bundle and never changes — keep it in its own chunk.
      output: { manualChunks: { phaser: ['phaser'] } },
    },
  },
});
