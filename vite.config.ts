import { defineConfig } from 'vitest/config';

// Library build: one ES bundle in dist/. pixi.js, rbush and thumbhash stay external (peer / dependencies).
// The decode worker is inlined (`?worker&inline`, started from a blob URL), so a host's bundler or dev server
// never has to resolve a worker asset. vite.worker.config.ts also emits it as dist/decode.worker.js for
// pages whose CSP forbids blob workers (`textures.workerUrl`).
export default defineConfig({
  base: './',
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'corkboard.js',
    },
    rollupOptions: {
      external: [/^pixi\.js(\/.*)?$/, 'rbush', 'thumbhash'],
    },
    sourcemap: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
