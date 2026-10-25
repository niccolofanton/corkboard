import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  base: './',
  resolve: { alias: { '@niccolofanton/corkboard': new URL('./src/index.ts', import.meta.url).pathname } },
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
