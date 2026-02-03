import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { donkeylabsDev } from '@donkeylabs/adapter-sveltekit/vite';

export default defineConfig({
  plugins: [donkeylabsDev(), tailwindcss(), sveltekit()],
  ssr: {
    // Bundle @donkeylabs packages in SSR so TypeScript files get transpiled
    noExternal: ['@donkeylabs/adapter-sveltekit', '@donkeylabs/server'],
  },
});
