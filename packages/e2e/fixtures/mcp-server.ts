import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";

export function createDonkeyMcpServer(projectDir: string) {
  return createSdkMcpServer({
    name: "donkey-server",
    version: "0.1.0",
    tools: [
      tool(
        "add_route",
        "Add a new route to a @donkeylabs/server router file with a class-based handler",
        {
          routerFile: z.string().describe("Path to the router file (relative to project root)"),
          routeName: z.string().describe("Name of the route (e.g., 'hello', 'users')"),
          method: z.enum(["get", "post", "put", "delete"]).optional().describe("HTTP method, defaults to post"),
          handlerBody: z.string().optional().describe("The handler implementation code"),
        },
        async (args) => {
          const { routerFile, routeName, method = "post", handlerBody } = args;
          const fullPath = join(projectDir, routerFile);

          if (!existsSync(fullPath)) {
            return {
              content: [{ type: "text", text: `Error: Router file not found: ${routerFile}` }],
              isError: true,
            };
          }

          const content = await readFile(fullPath, "utf-8");

          const routerDir = join(projectDir, routerFile.replace(/\/[^/]+$/, ""));
          const handlersDir = join(routerDir, "handlers");
          if (!existsSync(handlersDir)) {
            mkdirSync(handlersDir, { recursive: true });
          }

          const handlerClassName = toPascalCase(routeName) + "Handler";
          const inputTypeName = `${handlerClassName}Input`;
          const outputTypeName = `${handlerClassName}Output`;
          const handlerFileName = routeName.toLowerCase().replace(/[^a-z0-9]/g, "-");
          const handlerFileContent = `import type { Handler, AppContext } from "@donkeylabs/server";

type ${inputTypeName} = Record<string, unknown>;
type ${outputTypeName} = Record<string, unknown>;

export class ${handlerClassName} implements Handler {
  ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async handle(input: ${inputTypeName}): Promise<${outputTypeName}> {
    ${handlerBody ?? "return input;"}
  }
}
`;

          await writeFile(join(handlersDir, `${handlerFileName}.ts`), handlerFileContent);

          const updated = addRouteToRouter(
            content,
            routeName,
            handlerClassName,
            method
          );
          await writeFile(fullPath, updated);

          return {
            content: [{ type: "text", text: `Added route ${routeName}` }],
          };
        }
      ),
      tool(
        "create_plugin",
        "Create a new plugin scaffold",
        {
          name: z.string().describe("Plugin name"),
          description: z.string().optional().describe("Plugin description"),
          withService: z.boolean().optional().describe("Create a service file"),
          withHandlers: z.boolean().optional().describe("Create a handlers file"),
        },
        async (args) => {
          const { name, description, withService = true, withHandlers = false } = args;
          const pluginDir = join(projectDir, "src/plugins", name);
          if (!existsSync(pluginDir)) {
            mkdirSync(pluginDir, { recursive: true });
          }

          const indexContent = `import { PluginBuilder } from "@donkeylabs/server";
${withService ? `import { ${toPascalCase(name)}Service } from "./service";` : ""}
${withHandlers ? `import { handlers } from "./handlers";` : ""}

export const ${name}Plugin = new PluginBuilder("${name}")
  ${withService ? `.withService(() => new ${toPascalCase(name)}Service())` : `.withService(() => ({}))`}
  ${withHandlers ? `.withHandlers(handlers)` : ";"}
`;

          await writeFile(join(pluginDir, "index.ts"), indexContent);

          if (withService) {
            const serviceContent = `export class ${toPascalCase(name)}Service {
  async health() {
    return { ok: true };
  }
}
`;
            await writeFile(join(pluginDir, "service.ts"), serviceContent);
          }

          if (withHandlers) {
            const handlersContent = `export const handlers = {};
`;
            await writeFile(join(pluginDir, "handlers.ts"), handlersContent);
          }

          return {
            content: [{ type: "text", text: `Created plugin ${name}` }],
          };
        }
      ),
    ],
  });
}

function addRouteToRouter(
  content: string,
  routeName: string,
  handlerClassName: string,
  method: string
): string {
  const handlerImport = `import { ${handlerClassName} } from "./handlers/${routeName.toLowerCase().replace(/[^a-z0-9]/g, "-")}";`;
  const methodChain = method !== "post" ? `.${method}()` : "";

  let updated = content;
  if (!content.includes(handlerImport)) {
    updated = `${handlerImport}\n${updated}`;
  }

  const routerMatch = updated.match(/(export\s+)?const\s+(\w+)\s*=\s*createRouter\([^)]*\);/);
  if (routerMatch) {
    const routerLine = routerMatch[0];
    const routerName = routerMatch[2];
    const chained = routerLine.replace(
      /;\s*$/,
      `\n  .route("${routeName}")${methodChain}.typed({ handle: ${handlerClassName} });`
    );
    updated = updated.replace(routerLine, chained);
    return updated;
  }

  const existingRouter = updated.match(/const\s+(\w+)\s*=\s*createRouter\([^\n]+/);
  if (existingRouter) {
    const routerName = existingRouter[1];
    const exportDefaultPattern = new RegExp(`export\s+default\s+${routerName}\s*;`);
    const routeChain = `\n${routerName}\n  .route("${routeName}")${methodChain}.typed({ handle: ${handlerClassName} });\n`;
    if (exportDefaultPattern.test(updated)) {
      return updated.replace(exportDefaultPattern, `${routeChain}export default ${routerName};`);
    }
    return `${updated}${routeChain}`;
  }

  return updated;
}

function toPascalCase(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function escapeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
