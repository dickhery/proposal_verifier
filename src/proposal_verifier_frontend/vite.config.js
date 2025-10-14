import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'url';
import environment from 'vite-plugin-environment';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

const DEV_CSP =
  "default-src 'self'; " +
  "connect-src 'self' http://localhost:* http://127.0.0.1:* " +
  "https://icp0.io https://*.icp0.io " +
  "https://ic0.app https://*.ic0.app " +
  "https://icp-api.io https://ic-api.internetcomputer.org " +
  "https://api.github.com https://raw.githubusercontent.com " +
  "https://forum.dfinity.org https://dashboard.internetcomputer.org " +
  "https://download.dfinity.systems https://download.dfinity.network " +
  "data: blob:; " +
  "img-src 'self' data: https: blob:; " +           // ✅ allow blob: images in dev
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; " +
  "script-src-elem 'self' https://cdn.jsdelivr.net; " + // ✅ load your embed script in dev
  "object-src 'none'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self';";

export default defineConfig({
  build: { emptyOutDir: true },
  optimizeDeps: {
    esbuildOptions: { define: { global: 'globalThis' } },
  },
  server: {
    headers: {
      'Content-Security-Policy': DEV_CSP,
      'Permissions-Policy': 'clipboard-read=(self), clipboard-write=(self)',
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4943',
        changeOrigin: true,
      },
    },
  },
  publicDir: 'assets',
  plugins: [
    environment('all', { prefix: 'CANISTER_' }),
    environment('all', { prefix: 'DFX_' }),
  ],
  resolve: {
    alias: [
      {
        find: 'declarations',
        replacement: fileURLToPath(new URL('../declarations', import.meta.url)),
      },
    ],
    dedupe: ['@dfinity/agent'],
  },
});
