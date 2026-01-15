import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { cp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import pc from "picocolors";

const GLOBAL_ROOT = join(homedir(), ".bun-plugins");
const GLOBAL_REGISTRY_FILE = join(GLOBAL_ROOT, "registry.json");

interface GlobalRegistryData {
  plugins: {
    [name: string]: {
      latest: string;
      versions: string[];
    };
  };
}

export class GlobalRegistry {
  constructor() {
    if (!existsSync(GLOBAL_ROOT)) {
      mkdirSync(GLOBAL_ROOT, { recursive: true });
    }
  }

  async loadRegistry(): Promise<GlobalRegistryData> {
    if (!existsSync(GLOBAL_REGISTRY_FILE)) {
      return { plugins: {} };
    }
    const data = await readFile(GLOBAL_REGISTRY_FILE, "utf-8");
    return JSON.parse(data);
  }

  async saveRegistry(data: GlobalRegistryData) {
    await writeFile(GLOBAL_REGISTRY_FILE, JSON.stringify(data, null, 2));
  }

  async publish(pluginName: string, sourcePath: string, version: string) {
    const reg = await this.loadRegistry();
    const destPath = join(GLOBAL_ROOT, pluginName, version);

    if (existsSync(destPath)) {
      throw new Error(`Version ${version} of ${pluginName} already exists globally!`);
    }

    // Copy files
    await cp(sourcePath, destPath, { recursive: true });

    // Update Registry Metadata
    if (!reg.plugins[pluginName]) {
      reg.plugins[pluginName] = { latest: version, versions: [] };
    }
    reg.plugins[pluginName].versions.push(version);
    reg.plugins[pluginName].latest = version; // Naive "latest" update. Should resolve semantic version strictly.

    await this.saveRegistry(reg);
    console.log(pc.green(`✔ Published ${pluginName}@${version} to global registry.`));
  }

  async getAvailablePlugins() {
    const reg = await this.loadRegistry();
    return Object.entries(reg.plugins).map(([name, meta]) => ({
      name,
      latest: meta.latest,
      versions: meta.versions
    }));
  }

  async install(pluginName: string, version: string, targetPath: string) {
    const sourcePath = join(GLOBAL_ROOT, pluginName, version);
    if (!existsSync(sourcePath)) {
       throw new Error(`Plugin ${pluginName}@${version} not found in global registry.`);
    }

    if (existsSync(targetPath)) {
        // Simple overwrite policy (remove old, copy new)
       await rm(targetPath, { recursive: true, force: true });
    }

    // Copy
    await cp(sourcePath, targetPath, { recursive: true });

    // Create Metadata
    const meta = { origin: "global", name: pluginName, version, installedAt: new Date().toISOString() };
    await writeFile(join(targetPath, ".plugin-metadata.json"), JSON.stringify(meta, null, 2));
    
    console.log(pc.green(`✔ Installed ${pluginName}@${version} to ${targetPath}`));
  }
  
  async checkForUpdates(localPluginsDir: string): Promise<{ name: string, current: string, latest: string }[]> {
      const updates = [];
      const reg = await this.loadRegistry();
      
      try {
          const files = await readdir(localPluginsDir);
          for (const pluginName of files) {
              const metaFile = join(localPluginsDir, pluginName, ".plugin-metadata.json");
              if (existsSync(metaFile)) {
                  try {
                      const meta = JSON.parse(await readFile(metaFile, "utf-8"));
                      if (meta.origin === "global") {
                          const globalInfo = reg.plugins[meta.name];
                          if (globalInfo && globalInfo.latest !== meta.version) {
                              updates.push({
                                  name: meta.name,
                                  current: meta.version,
                                  latest: globalInfo.latest
                              });
                          }
                      }
                  } catch {}
              }
          }
      } catch {}
      
      return updates;
  }
}
