import adapter from '@donkeylabs/adapter-sveltekit';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter(),
		alias: {
			$server: '.@donkeylabs/server',
		}
	}
};

export default config;
