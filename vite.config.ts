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

// Vite's inline worker module makes its Blob at import time (`const blob = ... new Blob([...])`), which costs a
// copy of the worker source for every page that merely imports the library, and defeats tree shaking. Make it
// on the first worker start instead (the first TextureManager that does not use `textures.workerUrl`). The
// build fails if Vite's wrapper changes shape, so this cannot silently stop working.
const lazyWorkerBlob: Plugin = {
  name: 'lazy-inline-worker-blob',
  apply: 'build',
  enforce: 'post',
  transform(code, id) {
    if (!id.includes('?worker&inline')) return;
    const eager = 'const blob = typeof self !== "undefined" && self.Blob && new Blob(';
    const use = 'objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);';
    if (!code.includes(eager) || !code.includes(use)) {
      this.error('lazy-inline-worker-blob: unexpected shape of the inline worker wrapper (Vite changed?)');
    }
    return {
      code: code
        .replace(eager, 'let memo;\n            const makeBlob = () => memo ??= typeof self !== "undefined" && self.Blob && new Blob(')
        .replace(use, 'const blob = makeBlob();\n                objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);'),
      map: null,
    };
  },
};

// Library build: two ES entries in dist/ (corkboard.js, unstable.js) sharing code through chunks. pixi.js, rbush
// and thumbhash stay external (peer / dependencies).
// The decode worker is inlined (`?worker&inline`, started from a blob URL), so a host's bundler or dev server
// never has to resolve a worker asset. vite.worker.config.ts also emits it as dist/decode.worker.js for
// pages whose CSP forbids blob workers (`textures.workerUrl`).
export default defineConfig(({ mode }) => ({
  base: './',
  // `__CORKBOARD_TEST__` guards the test hooks in the sources (textures.ts): true under vitest (mode `test`) and in
  // the e2e build (`vite build --mode e2e`, see `test:e2e`), the literal `false` otherwise, so a library build
  // drops them as dead code.
  define: { __CORKBOARD_TEST__: JSON.stringify(mode === 'test' || mode === 'e2e') },
  plugins: [dropInlineWorkerMap, lazyWorkerBlob],
  build: {
    lib: {
      entry: { corkboard: 'src/index.ts', unstable: 'src/unstable.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: [/^pixi\.js(\/.*)?$/, 'rbush', 'thumbhash'],
      output: {
        chunkFileNames: 'chunk-[name]-[hash].js',
        // The import-free value modules of the root API in a chunk of their own: a host that imports only
        // `parseEmbedUrl`, `DARK_THEME` or `CorkboardError` does not pull the board (and Pixi) in with them.
        manualChunks: (id) =>
          /\/src\/(embed\/providers|errors|types|render\/theme)\.ts$/.test(id) ? 'values' : undefined,
      },
    },
    sourcemap: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
}));
