import { defineConfig, type Options } from 'tsup';

const webExtensions = ['.web.tsx', '.web.ts', '.tsx', '.ts'];

const shared: Options = {
  format: 'esm',
  banner: { js: "'use client'" },
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    dts: true,
    esbuildOptions(options) {
      options.jsx = 'transform';
      options.resolveExtensions = webExtensions;
    },
  },
  {
    ...shared,
    entry: { 'index.web': 'src/index.ts' },
    outExtension: () => ({ js: '.jsx' }),
    esbuildOptions(options) {
      options.jsx = 'preserve';
      options.resolveExtensions = webExtensions;
    },
  },
  {
    ...shared,
    entry: { 'index.native': 'src/index.ts' },
    outExtension: () => ({ js: '.jsx' }),
    esbuildOptions(options) {
      options.jsx = 'preserve';
    },
  },
]);
