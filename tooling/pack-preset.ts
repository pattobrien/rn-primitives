import { defineConfig } from 'vite-plus';

const shared = { platform: 'neutral', banner: { js: "'use client'" } } as const;

export default defineConfig({
  pack: [
    {
      ...shared,
      inputOptions: { resolve: { extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts'] } },
    },
    { ...shared, entry: { 'index.native': 'src/index.ts' }, dts: false },
  ],
});
