import { defineConfig } from 'vite';

// The decode worker as a standalone module, dist/decode.worker.js (thumbhash bundled in). The library
// inlines its own copy; this file is for hosts whose CSP forbids blob workers: serve it and pass its URL
// as `textures.workerUrl`. Runs after the library build, so it must not empty dist/.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/render/decode.worker.ts',
      formats: ['es'],
      fileName: () => 'decode.worker.js',
    },
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2022',
  },
});
