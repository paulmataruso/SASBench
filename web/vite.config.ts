import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI runs on Vite (5173) and proxies the REST API + SSE stream to the SAS UI port.
const target = process.env.SAS_UI_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { proxy: { '/api': { target, changeOrigin: true } } },
});
