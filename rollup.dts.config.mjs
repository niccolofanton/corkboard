import { dts } from 'rollup-plugin-dts';

// Bundles the per-file declarations that tsc emits to .types/ into the single dist/index.d.ts, so no relative
// import is left for node16 / nodenext consumers to resolve. Runtime dependencies stay external.
export default {
  input: '.types/index.d.ts',
  output: { file: 'dist/index.d.ts', format: 'es' },
  external: [/^pixi\.js(\/.*)?$/, 'rbush', 'thumbhash'],
  plugins: [dts()],
};
