import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  plugins: ["./src/server/plugins/**/index.ts"],
  outDir: ".@donkeylabs/server",
  adapter: "@donkeylabs/adapter-sveltekit",
  client: {
    output: "./src/lib/api.ts",
  },
});
