import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  plugins: ["./src/plugins/**/index.ts"],
  outDir: ".@donkeylabs/server",
});
