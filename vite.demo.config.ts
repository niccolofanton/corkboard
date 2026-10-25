import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The demo's version badge shows the package's version (`%APP_VERSION%` in index.html).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: 'demo',
  base: './',
  plugins: [
    {
      name: 'demo-version',
      transformIndexHtml: (html: string) => html.replaceAll('%APP_VERSION%', version),
    },
  ],
  resolve: {
    // The subpath first: an alias matches by prefix.
    alias: [
      { find: '@niccolofanton/corkboard/unstable', replacement: new URL('./src/unstable.ts', import.meta.url).pathname },
      { find: '@niccolofanton/corkboard', replacement: new URL('./src/index.ts', import.meta.url).pathname },
    ],
  },
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./demo/index.html', import.meta.url)),
        embeds: fileURLToPath(new URL('./demo/embeds.html', import.meta.url)),
      },
    },
  },
  worker: { format: 'es' },
  server: { port: 5173 },
});
