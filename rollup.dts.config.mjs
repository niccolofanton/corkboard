import { dts } from 'rollup-plugin-dts';

// Bundles the per-file declarations that tsc emits to .types/ into dist/index.d.ts (the root entry) and
// dist/unstable.d.ts, so no relative import into src/ is left for node16 / nodenext consumers to resolve.
// Declarations both entries need (the `Corkboard` class, the element types...) land in one shared chunk that the
// two files import, so a type is declared once and a `Corkboard` from the root is the one `getInternals` takes.
// Runtime dependencies stay external.
export default {
  input: { index: '.types/index.d.ts', unstable: '.types/unstable.d.ts' },
  output: { dir: 'dist', format: 'es', entryFileNames: '[name].d.ts', chunkFileNames: 'chunk-[hash].d.ts' },
  external: [/^pixi\.js(\/.*)?$/, 'rbush', 'thumbhash'],
  plugins: [dts()],
};
