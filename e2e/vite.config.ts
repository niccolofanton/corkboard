import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Serves e2e/fixture with the BUILT library (dist-e2e/corkboard.js) and pixi.js from node_modules: what a user's
// bundler would see, not the sources. `pnpm build:e2e` makes dist-e2e from the library's own config in mode `e2e`,
// which keeps the test hooks (`__CORKBOARD_TEST__`) that the published `dist` drops. Dedicated to the e2e run; the
// demo has its own config.
export default defineConfig({
  root: fileURLToPath(new URL('./fixture', import.meta.url)),
  resolve: { alias: { 'corkboard-dist': fileURLToPath(new URL('../dist-e2e/corkboard.js', import.meta.url)) } },
  // Bundle the dependencies up front: a re-optimise while the page loads would reload it under the test.
  optimizeDeps: { include: ['pixi.js', 'rbush', 'thumbhash'] },
  server: { port: 4179, strictPort: true, fs: { strict: false } },
  worker: { format: 'es' },
});
