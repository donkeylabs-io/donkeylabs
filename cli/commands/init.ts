/**
 * Init Command
 *
 * Initialize a new @donkeylabs/server project
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import pc from "picocolors";
import prompts from "prompts";

export async function initCommand(args: string[]) {
  const projectDir = args[0] || ".";
  const targetDir = resolve(process.cwd(), projectDir);

  console.log(pc.bold("\nInitializing @donkeylabs/server project...\n"));

  // Check if directory exists and has files
  if (existsSync(targetDir)) {
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(targetDir)
    );
    const hasConflicts = files.some(
      (f) => f === "src" || f === "donkeylabs.config.ts"
    );

    if (hasConflicts) {
      const { overwrite } = await prompts({
        type: "confirm",
        name: "overwrite",
        message: "Directory contains existing files. Overwrite?",
        initial: false,
      });

      if (!overwrite) {
        console.log(pc.yellow("Cancelled."));
        return;
      }
    }
  }

  // Create directories
  await mkdir(join(targetDir, "src/plugins"), { recursive: true });
  await mkdir(join(targetDir, ".@donkeylabs/server"), { recursive: true });

  // Create donkeylabs.config.ts
  const configContent = `import { defineConfig } from "@donkeylabs/server";

export default defineConfig({
  // Glob patterns for plugin files
  plugins: ["./src/plugins/**/index.ts"],

  // Generated types output (hidden directory)
  outDir: ".@donkeylabs/server",

  // Optional: Client generation
  // client: {
  //   output: "./src/client/api.ts",
  // },
});
`;
  await writeFile(join(targetDir, "donkeylabs.config.ts"), configContent);
  console.log(pc.green("  Created:"), "donkeylabs.config.ts");

  // Create src/index.ts
  const indexContent = `import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { AppServer, createRouter } from "@donkeylabs/server";
import { z } from "zod";

// Setup Database (replace with your actual database)
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

// Create Server
const server = new AppServer({
  port: 3000,
  db,
  config: { env: process.env.NODE_ENV || "development" },
});

// Define Routes
const router = createRouter("api")
  .route("hello").typed({
    input: z.object({ name: z.string().optional() }),
    output: z.object({ message: z.string() }),
    handle: async (input, ctx) => {
      return { message: \`Hello, \${input.name || "World"}!\` };
    },
  });

server.use(router);

// Start Server
await server.start();
`;
  await writeFile(join(targetDir, "src/index.ts"), indexContent);
  console.log(pc.green("  Created:"), "src/index.ts");

  // Create .gitignore entries for generated files
  const gitignorePath = join(targetDir, ".gitignore");
  const gitignoreContent = existsSync(gitignorePath)
    ? await readFile(gitignorePath, "utf-8")
    : "";

  if (!gitignoreContent.includes(".@donkeylabs")) {
    const newGitignore = gitignoreContent + "\n# Generated types\n.@donkeylabs/\n";
    await writeFile(gitignorePath, newGitignore);
    console.log(pc.green("  Updated:"), ".gitignore");
  }

  // Create tsconfig.json if it doesn't exist
  if (!existsSync(join(targetDir, "tsconfig.json"))) {
    const tsconfigContent = `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  },
  "include": ["src/**/*", "*.ts", ".@donkeylabs/**/*"]
}
`;
    await writeFile(join(targetDir, "tsconfig.json"), tsconfigContent);
    console.log(pc.green("  Created:"), "tsconfig.json");
  }

  // Update or create package.json
  const pkgPath = join(targetDir, "package.json");
  let pkg: any = { type: "module", scripts: {} };

  if (existsSync(pkgPath)) {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    pkg.scripts = pkg.scripts || {};
  }

  pkg.type = "module";
  pkg.scripts.dev = "bun --watch src/index.ts";
  pkg.scripts.start = "bun src/index.ts";
  pkg.scripts["gen:types"] = "donkeylabs generate";

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(pc.green("  Updated:"), "package.json");

  console.log(`
${pc.bold(pc.green("Success!"))} Project initialized.

${pc.bold("Next steps:")}
  1. Install dependencies:
     ${pc.cyan("bun install @donkeylabs/server kysely zod")}

  2. Start development:
     ${pc.cyan("bun run dev")}

  3. Generate types after adding plugins:
     ${pc.cyan("bun run gen:types")}
`);
}
