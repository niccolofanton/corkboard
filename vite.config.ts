import { defineConfig } from 'vitest/config';

// Library build: ES + CJS bundles in dist/. pixi.js, rbush and thumbhash stay external (dependencies).
// The decode worker is emitted as its own chunk and referenced with `new URL(..., import.meta.url)`.
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
