import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Alias the package name to the local source tree so the demo always
// runs against the live source — no rebuild needed when you edit hooks.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin realtime: the client connects to ws://localhost:5173/realtime
      // and vite forwards to the demo server (server.mjs on :4001). Zero client
      // config; override with VITE_GATEWAY_URL to point at a real gateway.
      '/realtime': {
        target: 'ws://localhost:4001',
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@connorhoehn/realtime-modules/client': path.resolve(__dirname, '../src/client/index.ts'),
      '@connorhoehn/realtime-modules': path.resolve(__dirname, '../src/index.ts'),
    },
  },
});
