import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  plugins: ["./src/server/plugins/**/index.ts"],
  outDir: ".@donkeylabs/server",
  entry: "./src/server/index.ts",
  routes: "./src/server/routes/**/{route,index}.ts",
  adapter: "@donkeylabs/adapter-sveltekit",
  client: {
    output: "./src/lib/api.ts",
  },
});
