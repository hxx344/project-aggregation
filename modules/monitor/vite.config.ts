import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  appType: 'custom',
  server: { host: '127.0.0.1' },
  build: {
    outDir: isSsrBuild ? 'dist/server' : 'dist/client',
    emptyOutDir: true,
    manifest: !isSsrBuild,
    copyPublicDir: !isSsrBuild,
    // SSR may include a lazy panel before its browser chunk is requested.
    // A shared stylesheet keeps that first HTML styled without loading its JS.
    cssCodeSplit: false,
    rolldownOptions: isSsrBuild ? { output: { entryFileNames: 'entry-server.js' } } : undefined,
  },
}));
