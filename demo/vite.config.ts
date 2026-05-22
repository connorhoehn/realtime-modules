import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Alias the package name to the local source tree so the demo always
// runs against the live source — no rebuild needed when you edit hooks.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@connorhoehn/realtime-modules/client': path.resolve(__dirname, '../src/client/index.ts'),
      '@connorhoehn/realtime-modules': path.resolve(__dirname, '../src/index.ts'),
    },
  },
});
