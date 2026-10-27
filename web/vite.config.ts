import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI runs on Vite (5173) and proxies the REST API, SSE stream and map tiles to
// the SAS UI port. The SAS refuses changes from other origins, so the proxy presents the browser's
// requests as coming from the SAS itself.
const target = process.env.SAS_UI_URL ?? 'http://localhost:8080';
const proxy: ProxyOptions = {
  target,
  changeOrigin: true,
  configure: (p) => p.on('proxyReq', (req) => {
    if (req.getHeader('origin')) req.setHeader('origin', new URL(target).origin);
  }),
};

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { proxy: { '/api': proxy, '/tiles': proxy } },
});
