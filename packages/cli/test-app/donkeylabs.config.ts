import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  plugins: ["./src/server/plugins/*/index.ts"],
  routes: "./src/server/routes/**/*.ts",
  outDir: ".@donkeylabs",
  adapter: "@donkeylabs/adapter-sveltekit",
  client: {
    output: "./src/lib/api.ts",
  },
});
