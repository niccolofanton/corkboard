import { defineConfig, type Plugin } from 'vitest/config';

// Vite builds the inlined worker with the library's `sourcemap` setting and emits dist/assets/decode.worker-*.js.map,
// which the blob worker never loads. Drop that asset and blank the `sourceMappingURL` comment pointing at it (the
// line stays, so the library's own sourcemap keeps its line numbers).
const dropInlineWorkerMap: Plugin = {
  name: 'drop-inline-worker-map',
  apply: 'build',
  generateBundle(_, bundle) {
    for (const [name, file] of Object.entries(bundle)) {
      if (/^assets\/decode\.worker-.*\.js\.map$/.test(name)) delete bundle[name];
      else if (file.type === 'chunk') file.code = file.code.replace(/\/\/# sourceMappingURL=decode\.worker-[\w-]+\.js\.map/g, '');
    }
  },
};

// Library build: one ES bundle in dist/. pixi.js, rbush and thumbhash stay external (peer / dependencies).
// The decode worker is inlined (`?worker&inline`, started from a blob URL), so a host's bundler or dev server
// never has to resolve a worker asset. vite.worker.config.ts also emits it as dist/decode.worker.js for
// pages whose CSP forbids blob workers (`textures.workerUrl`).
export default defineConfig({
  base: './',
  plugins: [dropInlineWorkerMap],
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
