import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  base: './',
  resolve: { alias: { corkboard: new URL('./src/index.ts', import.meta.url).pathname } },
  build: { outDir: '../dist-demo', emptyOutDir: true },
  worker: { format: 'es' },
  server: { port: 5173 },
});
