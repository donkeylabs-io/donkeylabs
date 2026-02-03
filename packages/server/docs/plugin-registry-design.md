# Plugin Registry System Design

A design document for a centralized plugin registry to enable discovery, sharing, and distribution of DonkeyLabs plugins.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Registry API](#registry-api)
- [CLI Integration](#cli-integration)
- [Plugin Discovery](#plugin-discovery)
- [Versioning & Dependencies](#versioning--dependencies)
- [Security & Validation](#security--validation)
- [Implementation Roadmap](#implementation-roadmap)

---

## Overview

### Problem Statement

Currently, plugins are:
- Hard to discover (no centralized repository)
- Difficult to share (manual copy-paste)
- No versioning system
- No dependency resolution
- No quality standards

### Goals

1. **Discoverability** - Search and browse available plugins
2. **Easy Installation** - One-command plugin installation
3. **Version Management** - Semantic versioning and updates
4. **Dependency Resolution** - Auto-install dependencies
5. **Quality Assurance** - Verified plugins with tests
6. **Community** - Ratings, reviews, and contributions

### Use Cases

**Developer A:** Wants to add authentication to their app
```bash
donkeylabs plugin search auth
# Shows: auth-jwt, auth-oauth, auth-magic-link
donkeylabs plugin install auth-jwt
```

**Developer B:** Built a stripe plugin, wants to share
```bash
donkeylabs plugin publish ./plugins/stripe
# Plugin uploaded to registry, others can install
```

**Developer C:** Updating dependencies
```bash
donkeylabs plugin update
# Checks for updates, resolves conflicts
```

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Plugin Registry                          │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Web UI     │  │   Registry   │  │   Package    │      │
│  │  (Next.js)   │  │    API       │  │   Storage    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            │                                │
│  ┌──────────────┐  ┌──────┴────────┐  ┌──────────────┐     │
│  │   Search     │  │   Database    │  │   CDN        │     │
│  │   (Algolia)  │  │  (PostgreSQL) │  │  (CloudFront)│     │
│  └──────────────┘  └───────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │   CLI   │          │   CLI   │          │   CLI   │
   │ User A  │          │ User B  │          │ User C  │
   └─────────┘          └─────────┘          └─────────┘
```

### Registry API Endpoints

```typescript
// Registry API Specification

interface RegistryAPI {
  // Search plugins
  "GET /api/plugins": {
    query: { q?: string; category?: string; sort?: "downloads" | "rating" | "recent" };
    response: PaginatedResponse<PluginSummary>;
  };

  // Get plugin details
  "GET /api/plugins/:name": {
    response: PluginDetails;
  };

  // Get plugin versions
  "GET /api/plugins/:name/versions": {
    response: PluginVersion[];
  };

  // Download plugin package
  "GET /api/plugins/:name/:version/download": {
    response: Blob; // .tar.gz package
  };

  // Publish plugin (authenticated)
  "POST /api/plugins": {
    body: FormData; // package.tar.gz + metadata
    headers: { Authorization: string };
    response: { success: boolean; plugin: PluginSummary };
  };

  // Update plugin (authenticated)
  "PUT /api/plugins/:name": {
    body: FormData;
    headers: { Authorization: string };
    response: { success: boolean };
  };

  // Rate plugin (authenticated)
  "POST /api/plugins/:name/ratings": {
    body: { rating: 1-5; review?: string };
    headers: { Authorization: string };
  };
}
```

### Data Models

```typescript
// Plugin entity
interface Plugin {
  id: string;
  name: string;              // e.g., "auth-jwt"
  displayName: string;       // e.g., "JWT Authentication"
  description: string;
  author: {
    name: string;
    email: string;
    github?: string;
  };
  repository?: string;       // GitHub URL
  license: string;
  categories: string[];      // ["auth", "security"]
  tags: string[];            // ["jwt", "authentication"]
  
  // Stats
  downloads: number;
  rating: number;            // 0-5 average
  ratingCount: number;
  
  // Versions
  versions: PluginVersion[];
  latestVersion: string;
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  verified: boolean;         // Official/community
}

interface PluginVersion {
  version: string;           // semver
  description?: string;      // changelog entry
  deprecated?: boolean;
  
  // Dependencies
  dependencies: {
    plugins?: string[];      // ["users@^1.0.0"]
    packages?: Record<string, string>; // npm deps
  };
  
  // Package info
  packageUrl: string;
  checksum: string;          // sha256
  size: number;              // bytes
  
  // Compatibility
  engine: {
    node?: string;
    bun?: string;
  };
  framework: string;         // @donkeylabs/server version range
  
  createdAt: Date;
}

// Search index document
interface PluginSearchDoc {
  objectID: string;          // plugin name
  name: string;
  displayName: string;
  description: string;
  categories: string[];
  tags: string[];
  author: string;
  downloads: number;
  rating: number;
  verified: boolean;
  _tags: string[];
}
```

---

## Registry API

### Core Endpoints

```typescript
// packages/registry/src/server.ts
import { createRouter, defineRoute } from "@donkeylabs/server";
import { z } from "zod";

export const registryRouter = createRouter("registry");

// List/search plugins
registryRouter.route("plugins.list").typed(defineRoute({
  input: z.object({
    q: z.string().optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
    author: z.string().optional(),
    sort: z.enum(["downloads", "rating", "recent", "name"]).default("downloads"),
    page: z.number().default(1),
    limit: z.number().max(50).default(20),
  }),
  output: z.object({
    plugins: z.array(pluginSummarySchema),
    pagination: paginationSchema,
  }),
  handle: async (input, ctx) => {
    const query = ctx.plugins.search.buildQuery(input);
    const results = await ctx.plugins.search.execute(query);
    return results;
  },
}));

// Get plugin details
registryRouter.route("plugins.get").typed(defineRoute({
  input: z.object({ name: z.string() }),
  output: pluginDetailsSchema,
  handle: async (input, ctx) => {
    const plugin = await ctx.plugins.store.getByName(input.name);
    if (!plugin) throw ctx.errors.NotFound("Plugin not found");
    return plugin;
  },
}));

// Download plugin
registryRouter.route("plugins.download").stream({
  input: z.object({
    name: z.string(),
    version: z.string(),
  }),
  handle: async (input, ctx) => {
    const version = await ctx.plugins.store.getVersion(input.name, input.version);
    if (!version) throw ctx.errors.NotFound("Version not found");
    
    // Stream from storage
    const stream = await ctx.plugins.storage.download(version.packageUrl);
    
    return {
      stream,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${input.name}-${input.version}.tar.gz"`,
      },
    };
  },
});

// Publish plugin (authenticated)
registryRouter.route("plugins.publish").typed(defineRoute({
  input: z.object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string(),
    description: z.string(),
    categories: z.array(z.string()),
    tags: z.array(z.string()),
    repository: z.string().url().optional(),
    license: z.string(),
    dependencies: z.object({
      plugins: z.array(z.string()).optional(),
      packages: z.record(z.string()).optional(),
    }).optional(),
    // Package uploaded as multipart form
  }),
  output: z.object({
    success: z.boolean(),
    plugin: pluginSummarySchema,
  }),
  handle: async (input, ctx) => {
    // Verify authentication
    const user = await ctx.plugins.auth.verifyToken(ctx.request);
    
    // Validate package
    const validation = await ctx.plugins.validator.validate(input.package);
    if (!validation.valid) {
      throw ctx.errors.BadRequest(validation.errors.join(", "));
    }
    
    // Store package
    const packageUrl = await ctx.plugins.storage.upload(
      input.name,
      input.version,
      input.package
    );
    
    // Create version record
    const version = await ctx.plugins.store.createVersion({
      pluginName: input.name,
      version: input.version,
      description: input.description,
      dependencies: input.dependencies,
      packageUrl,
      checksum: validation.checksum,
      size: validation.size,
    });
    
    // Update search index
    await ctx.plugins.search.indexPlugin(input.name);
    
    return { success: true, plugin: await ctx.plugins.store.getByName(input.name) };
  },
}));
```

### Search Implementation

```typescript
// Using Algolia for full-text search

class PluginSearchService {
  private client: algoliasearch.Client;
  private index: algoliasearch.Index;

  constructor() {
    this.client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_API_KEY);
    this.index = this.client.initIndex("plugins");
  }

  async buildQuery(params: SearchParams): algoliasearch.SearchOptions {
    const filters = [];
    
    if (params.category) {
      filters.push(`categories:${params.category}`);
    }
    if (params.verified) {
      filters.push("verified:true");
    }
    
    return {
      query: params.q,
      filters: filters.join(" AND "),
      page: params.page - 1,
      hitsPerPage: params.limit,
      attributesToHighlight: ["name", "description"],
      highlightPreTag: "<mark>",
      highlightPostTag: "</mark>",
    };
  }

  async execute(options: algoliasearch.SearchOptions) {
    const { hits, nbHits, nbPages, page } = await this.index.search(options);
    
    return {
      plugins: hits.map(this.transformHit),
      pagination: {
        total: nbHits,
        pages: nbPages,
        current: page + 1,
        hasMore: page + 1 < nbPages,
      },
    };
  }

  async indexPlugin(plugin: Plugin) {
    const doc: PluginSearchDoc = {
      objectID: plugin.name,
      name: plugin.name,
      displayName: plugin.displayName,
      description: plugin.description,
      categories: plugin.categories,
      tags: plugin.tags,
      author: plugin.author.name,
      downloads: plugin.downloads,
      rating: plugin.rating,
      verified: plugin.verified,
    };
    
    await this.index.saveObject(doc);
  }
}
```

---

## CLI Integration

### New CLI Commands

```typescript
// packages/cli/src/commands/registry.ts

export const registryCommands = {
  // Search for plugins
  async search(query: string, options: SearchOptions) {
    const registry = new RegistryClient(REGISTRY_URL);
    const results = await registry.search({
      q: query,
      category: options.category,
      sort: options.sort,
    });
    
    // Display results
    console.log(`\nFound ${results.pagination.total} plugins:\n`);
    results.plugins.forEach((plugin) => {
      console.log(`${pc.cyan(plugin.name)} ${pc.gray(plugin.latestVersion)}`);
      console.log(`  ${plugin.description}`);
      console.log(`  ⭐ ${plugin.rating} | ⬇️  ${plugin.downloads} downloads`);
      console.log(`  ${pc.gray(plugin.categories.join(", "))}\n`);
    });
  },

  // Install a plugin
  async install(name: string, options: InstallOptions) {
    const registry = new RegistryClient(REGISTRY_URL);
    
    // Check if already installed
    const existing = await this.getInstalledPlugin(name);
    if (existing) {
      console.log(pc.yellow(`⚠️  ${name} is already installed (${existing.version})`));
      if (!options.force) return;
    }
    
    // Fetch plugin info
    const plugin = await registry.getPlugin(name);
    const version = options.version || plugin.latestVersion;
    
    console.log(pc.blue(`⬇️  Downloading ${name}@${version}...`));
    
    // Download package
    const packageBuffer = await registry.download(name, version);
    
    // Resolve dependencies
    const deps = await this.resolveDependencies(plugin.versions.find(v => v.version === version)!);
    
    if (deps.length > 0) {
      console.log(pc.blue(`📦 Installing ${deps.length} dependencies...`));
      for (const dep of deps) {
        await this.install(dep.name, { version: dep.version, silent: true });
      }
    }
    
    // Extract and install
    await this.extractPackage(name, version, packageBuffer);
    
    // Run post-install hooks
    await this.runPostInstall(name);
    
    // Update donkeylabs.config.ts
    await this.updateConfig(name);
    
    console.log(pc.green(`✅ ${name}@${version} installed successfully!`));
    
    // Show next steps
    console.log(pc.gray(`\nNext steps:`));
    console.log(pc.gray(`  1. Import the plugin in your server`));
    console.log(pc.gray(`  2. Register it with server.registerPlugin(${name}Plugin)`));
    console.log(pc.gray(`  3. Run bun run gen:types`));
  },

  // Update plugins
  async update(options: UpdateOptions) {
    const installed = await this.getInstalledPlugins();
    
    const updates = [];
    for (const plugin of installed) {
      const latest = await registry.getLatestVersion(plugin.name);
      if (semver.gt(latest, plugin.version)) {
        updates.push({ name: plugin.name, current: plugin.version, latest });
      }
    }
    
    if (updates.length === 0) {
      console.log(pc.green("✅ All plugins are up to date!"));
      return;
    }
    
    console.log(pc.blue(`\n${updates.length} update(s) available:\n`));
    updates.forEach((u) => {
      console.log(`${u.name}: ${pc.gray(u.current)} → ${pc.cyan(u.latest)}`);
    });
    
    if (options.dryRun) return;
    
    // Install updates
    for (const update of updates) {
      await this.install(update.name, { version: update.latest });
    }
  },

  // Publish plugin
  async publish(pluginPath: string, options: PublishOptions) {
    // Validate plugin structure
    const validation = await this.validatePlugin(pluginPath);
    if (!validation.valid) {
      console.error(pc.red("❌ Validation failed:"));
      validation.errors.forEach((e) => console.error(`  - ${e}`));
      return;
    }
    
    // Get version from package.json or prompt
    const version = await this.getVersion(pluginPath, options.version);
    
    // Build package
    console.log(pc.blue("📦 Building package..."));
    const packageBuffer = await this.buildPackage(pluginPath);
    
    // Get auth token
    const token = await this.getAuthToken();
    
    // Publish
    console.log(pc.blue(`🚀 Publishing to registry...`));
    const registry = new RegistryClient(REGISTRY_URL, token);
    
    await registry.publish({
      name: validation.name,
      version,
      description: validation.description,
      categories: validation.categories,
      tags: validation.tags,
      repository: validation.repository,
      license: validation.license,
      dependencies: validation.dependencies,
      package: packageBuffer,
    });
    
    console.log(pc.green(`✅ Published ${validation.name}@${version}!`));
  },

  // Uninstall plugin
  async uninstall(name: string, options: UninstallOptions) {
    // Check for dependent plugins
    const dependents = await this.getDependents(name);
    if (dependents.length > 0 && !options.force) {
      console.error(pc.red(`❌ Cannot uninstall: used by ${dependents.join(", ")}`));
      return;
    }
    
    // Remove from filesystem
    await this.removePlugin(name);
    
    // Update config
    await this.removeFromConfig(name);
    
    console.log(pc.green(`✅ ${name} uninstalled`));
  },
};
```

### Registry Client

```typescript
// packages/cli/src/registry/client.ts

class RegistryClient {
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async search(params: SearchParams): Promise<SearchResults> {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.category) query.set("category", params.category);
    
    const res = await fetch(`${this.baseUrl}/api/plugins?${query}`);
    if (!res.ok) throw new Error(`Search failed: ${res.statusText}`);
    return res.json();
  }

  async getPlugin(name: string): Promise<Plugin> {
    const res = await fetch(`${this.baseUrl}/api/plugins/${name}`);
    if (!res.ok) throw new Error(`Plugin not found: ${name}`);
    return res.json();
  }

  async download(name: string, version: string): Promise<Buffer> {
    const res = await fetch(
      `${this.baseUrl}/api/plugins/${name}/${version}/download`
    );
    if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async publish(data: PublishData): Promise<PublishResult> {
    const form = new FormData();
    form.append("name", data.name);
    form.append("version", data.version);
    form.append("description", data.description);
    form.append("categories", JSON.stringify(data.categories));
    form.append("tags", JSON.stringify(data.tags));
    form.append("package", new Blob([data.package]), "package.tar.gz");
    
    const res = await fetch(`${this.baseUrl}/api/plugins`, {
      method: "POST",
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      body: form,
    });
    
    if (!res.ok) throw new Error(`Publish failed: ${res.statusText}`);
    return res.json();
  }
}
```

---

## Plugin Discovery

### Web Interface

```typescript
// Registry web UI (Next.js)
// app/page.tsx - Plugin discovery homepage

export default async function HomePage() {
  const featured = await getFeaturedPlugins();
  const popular = await getPopularPlugins();
  const recent = await getRecentPlugins();
  
  return (
    <div className="container mx-auto px-4 py-8">
      {/* Hero */}
      <section className="text-center py-16">
        <h1 className="text-4xl font-bold mb-4">
          DonkeyLabs Plugin Registry
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Discover and share plugins for the DonkeyLabs framework
        </p>
        <SearchBox />
      </section>
      
      {/* Categories */}
      <section className="py-8">
        <h2 className="text-2xl font-semibold mb-4">Categories</h2>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <CategoryBadge key={cat} name={cat} />
          ))}
        </div>
      </section>
      
      {/* Featured */}
      <section className="py-8">
        <h2 className="text-2xl font-semibold mb-4">Featured Plugins</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {featured.map((plugin) => (
            <PluginCard key={plugin.name} plugin={plugin} featured />
          ))}
        </div>
      </section>
      
      {/* Popular */}
      <section className="py-8">
        <h2 className="text-2xl font-semibold mb-4">Most Popular</h2>
        <PluginList plugins={popular} />
      </section>
      
      {/* Recent */}
      <section className="py-8">
        <h2 className="text-2xl font-semibold mb-4">Recently Updated</h2>
        <PluginList plugins={recent} />
      </section>
    </div>
  );
}
```

### Plugin Card Component

```typescript
// components/PluginCard.tsx

interface PluginCardProps {
  plugin: PluginSummary;
  featured?: boolean;
}

export function PluginCard({ plugin, featured }: PluginCardProps) {
  return (
    <div className={`border rounded-lg p-4 hover:shadow-lg transition-shadow ${
      featured ? "border-blue-500" : "border-gray-200"
    }`}>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">
            <Link href={`/plugins/${plugin.name}`}>
              {plugin.displayName || plugin.name}
            </Link>
            {plugin.verified && (
              <span className="ml-2 text-blue-500" title="Verified">✓</span>
            )}
          </h3>
          <p className="text-sm text-gray-500">{plugin.author}</p>
        </div>
        <span className="text-sm text-gray-400">{plugin.latestVersion}</span>
      </div>
      
      <p className="mt-2 text-gray-700 line-clamp-2">{plugin.description}</p>
      
      <div className="mt-4 flex items-center gap-4 text-sm text-gray-500">
        <span>⭐ {plugin.rating.toFixed(1)}</span>
        <span>⬇️ {formatNumber(plugin.downloads)}</span>
      </div>
      
      <div className="mt-3 flex flex-wrap gap-1">
        {plugin.categories.map((cat) => (
          <Badge key={cat} variant="secondary">{cat}</Badge>
        ))}
      </div>
      
      <div className="mt-4 pt-4 border-t flex justify-between items-center">
        <code className="text-sm bg-gray-100 px-2 py-1 rounded">
          donkeylabs plugin install {plugin.name}
        </code>
        <Button size="sm">View Details</Button>
      </div>
    </div>
  );
}
```

---

## Versioning & Dependencies

### Semantic Versioning

Plugins follow semver: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes (require migration)
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Dependency Resolution

```typescript
// packages/cli/src/registry/dependencies.ts

class DependencyResolver {
  async resolve(pluginName: string, versionRange: string): Promise<ResolvedDependency[]> {
    const plugin = await this.registry.getPlugin(pluginName);
    const resolved: ResolvedDependency[] = [];
    
    // Find best matching version
    const version = this.findBestVersion(plugin.versions, versionRange);
    if (!version) {
      throw new Error(`No version found for ${pluginName}@${versionRange}`);
    }
    
    resolved.push({ name: pluginName, version: version.version });
    
    // Recursively resolve plugin dependencies
    if (version.dependencies?.plugins) {
      for (const dep of version.dependencies.plugins) {
        const [depName, depRange] = dep.split("@");
        const depResolved = await this.resolve(depName, depRange || "*");
        resolved.push(...depResolved);
      }
    }
    
    // Check for conflicts
    this.checkConflicts(resolved);
    
    return resolved;
  }
  
  private findBestVersion(versions: PluginVersion[], range: string): PluginVersion | null {
    // Sort by version descending
    const sorted = versions
      .filter(v => !v.deprecated)
      .sort((a, b) => semver.rcompare(a.version, b.version));
    
    // Find first matching version
    return sorted.find(v => semver.satisfies(v.version, range)) || null;
  }
  
  private checkConflicts(resolved: ResolvedDependency[]) {
    const versions = new Map<string, string[]>();
    
    for (const dep of resolved) {
      const existing = versions.get(dep.name) || [];
      if (existing.length > 0 && !existing.includes(dep.version)) {
        throw new Error(
          `Version conflict for ${dep.name}: ${existing.join(", ")} vs ${dep.version}`
        );
      }
      versions.set(dep.name, [...existing, dep.version]);
    }
  }
}
```

### Lockfile

Similar to `package-lock.json` or `bun.lockb`:

```json
// donkeylabs-lock.json
{
  "lockfileVersion": 1,
  "plugins": {
    "auth-jwt": {
      "version": "2.1.0",
      "resolved": "https://registry.donkeylabs.io/api/plugins/auth-jwt/2.1.0/download",
      "integrity": "sha256:abc123...",
      "dependencies": {
        "users": "^1.0.0"
      }
    },
    "users": {
      "version": "1.2.0",
      "resolved": "https://registry.donkeylabs.io/api/plugins/users/1.2.0/download",
      "integrity": "sha256:def456...",
      "dependencies": {}
    }
  }
}
```

---

## Security & Validation

### Plugin Validation

```typescript
// packages/cli/src/registry/validation.ts

class PluginValidator {
  async validate(pluginPath: string): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // 1. Check structure
    const requiredFiles = ["index.ts", "package.json"];
    for (const file of requiredFiles) {
      if (!await this.fileExists(join(pluginPath, file))) {
        errors.push(`Missing required file: ${file}`);
      }
    }
    
    // 2. Parse package.json
    const pkg = await this.readPackageJson(pluginPath);
    
    // 3. Validate plugin definition
    const pluginDef = await this.parsePluginDefinition(pluginPath);
    if (!pluginDef.name) errors.push("Plugin name not defined");
    if (!pluginDef.service) errors.push("Plugin service not defined");
    
    // 4. Check for security issues
    const securityScan = await this.scanForSecurityIssues(pluginPath);
    errors.push(...securityScan.errors);
    warnings.push(...securityScan.warnings);
    
    // 5. Check TypeScript compilation
    const compileCheck = await this.checkTypescript(pluginPath);
    if (!compileCheck.success) {
      errors.push(`TypeScript errors: ${compileCheck.errors.join(", ")}`);
    }
    
    // 6. Run tests if available
    if (await this.hasTests(pluginPath)) {
      const testResult = await this.runTests(pluginPath);
      if (!testResult.success) {
        warnings.push("Tests failed (not blocking)");
      }
    }
    
    return {
      valid: errors.length === 0,
      name: pluginDef.name,
      version: pkg.version,
      errors,
      warnings,
    };
  }
  
  private async scanForSecurityIssues(pluginPath: string): Promise<SecurityScan> {
    const issues: string[] = [];
    const warnings: string[] = [];
    
    // Check for dangerous patterns
    const code = await this.readAllSourceFiles(pluginPath);
    
    // SQL injection risks
    if (code.includes("sql`") && code.includes("${")) {
      issues.push("Potential SQL injection: template literal in SQL query");
    }
    
    // Hardcoded secrets
    const secretPatterns = [/password\s*[:=]\s*["'][^"']+["']/i, /secret\s*[:=]\s*["'][^"']+["']/i];
    for (const pattern of secretPatterns) {
      if (pattern.test(code)) {
        warnings.push("Possible hardcoded secrets detected");
        break;
      }
    }
    
    // Unsafe eval
    if (code.includes("eval(") || code.includes("new Function(")) {
      issues.push("Unsafe eval() or new Function() detected");
    }
    
    return { errors: issues, warnings };
  }
}
```

### Package Signing

```typescript
// Sign packages for integrity verification
import { createSign } from "crypto";

class PackageSigner {
  async sign(packageBuffer: Buffer, privateKey: string): Promise<string> {
    const signer = createSign("SHA256");
    signer.update(packageBuffer);
    signer.end();
    return signer.sign(privateKey, "base64");
  }
  
  async verify(packageBuffer: Buffer, signature: string, publicKey: string): Promise<boolean> {
    const verifier = createVerify("SHA256");
    verifier.update(packageBuffer);
    verifier.end();
    return verifier.verify(publicKey, signature, "base64");
  }
}
```

---

## Implementation Roadmap

### Phase 1: MVP (4-6 weeks)

**Week 1-2: Backend**
- [ ] Registry API server setup
- [ ] Database schema
- [ ] Package storage (S3/MinIO)
- [ ] Basic CRUD endpoints

**Week 3: CLI Integration**
- [ ] `donkeylabs plugin search`
- [ ] `donkeylabs plugin install`
- [ ] `donkeylabs plugin uninstall`
- [ ] Local plugin registry cache

**Week 4: Discovery**
- [ ] Web UI (search + browse)
- [ ] Plugin detail pages
- [ ] Basic rating system

**Week 5-6: Polish**
- [ ] Authentication (GitHub OAuth)
- [ ] Plugin validation
- [ ] Documentation

### Phase 2: Enhanced (6-8 weeks)

- [ ] Semantic versioning support
- [ ] Dependency resolution
- [ ] Lockfile management
- [ ] Update notifications
- [ ] Verified plugin badges
- [ ] Plugin statistics dashboard

### Phase 3: Ecosystem (8+ weeks)

- [ ] Plugin templates/scaffolding
- [ ] Automated testing on publish
- [ ] Plugin marketplace (paid plugins)
- [ ] Plugin analytics for authors
- [ ] Community features (comments, forums)

### Directory Structure

```
packages/
├── registry/                    # Registry backend
│   ├── src/
│   │   ├── server.ts           # API server
│   │   ├── routes/             # API routes
│   │   ├── plugins/            # Registry plugins
│   │   │   ├── search.ts
│   │   │   ├── storage.ts
│   │   │   └── auth.ts
│   │   └── services/
│   ├── web/                    # Next.js frontend
│   │   ├── app/
│   │   ├── components/
│   │   └── lib/
│   └── package.json
│
├── cli/src/
│   └── commands/
│       └── registry.ts         # CLI commands
│
└── plugin-sdk/                 # SDK for plugin dev
    ├── src/
    │   ├── validation.ts
    │   ├── testing.ts
    │   └── publishing.ts
    └── package.json
```

### Hosting

**Recommended stack:**
- **API**: Vercel/Netlify Functions or Railway
- **Database**: PostgreSQL (Supabase or Railway)
- **Storage**: AWS S3 or Cloudflare R2
- **Search**: Algolia (free tier sufficient initially)
- **CDN**: Cloudflare
- **Auth**: GitHub OAuth + JWT

---

## Summary

This registry system will:

1. **Enable discovery** - Search and browse 1000s of plugins
2. **Simplify sharing** - One command to publish
3. **Ensure quality** - Validation + testing
4. **Manage versions** - Semantic versioning + lockfiles
5. **Foster community** - Ratings, reviews, contributions

**Next steps:**
1. Set up registry server infrastructure
2. Implement core CLI commands
3. Build web UI
4. Launch beta with curated plugins
5. Open to community submissions
