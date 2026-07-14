import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bindingsDir = path.resolve(here, '../../shared/bindings');
const sharedTypesDir = path.resolve(here, '../../shared/types');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@bindings$/, replacement: path.join(bindingsDir, 'index.ts') },
      { find: /^@bindings\//, replacement: bindingsDir + '/' },
      { find: /^@shared\//, replacement: sharedTypesDir + '/' },
      // shared/bindings sits outside this package root; without this alias the
      // bindings would resolve the repo-root copy of spacetimedb while app code
      // resolves the local one (two class identities). Force a single copy.
      { find: /^spacetimedb$/, replacement: path.resolve(here, 'node_modules/spacetimedb') },
    ],
  },
  server: {
    port: 5173,
    fs: {
      // allow importing shared/ from outside the app root
      allow: [path.resolve(here, '../..')],
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: path.resolve(here, 'index.html'),
        // MSAL v5 popup landing page (runs the redirect bridge; see the file)
        'auth-redirect': path.resolve(here, 'auth-redirect.html'),
      },
    },
  },
});
