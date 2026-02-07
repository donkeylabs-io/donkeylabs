import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateClient } from "../src/generator/index";
import {
  generatePackageSwift,
  generateRoutesNamespace,
  generateApiClient,
  generateApiClientExtensions,
  generateModelFile,
} from "../src/generator/swift-codegen";
import type { RouteInfo } from "@donkeylabs/server/generator";

const TMP_DIR = join(import.meta.dir, "..", ".test-output");

function cleanup() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

describe("generatePackageSwift", () => {
  it("generates valid Package.swift", () => {
    const result = generatePackageSwift("MyApi", { iOS: "15.0", macOS: "12.0" });
    expect(result).toContain("swift-tools-version: 5.9");
    expect(result).toContain('name: "MyApi"');
    expect(result).toContain(".iOS(.v15)");
    expect(result).toContain(".macOS(.v12)");
  });

  it("handles minor versions in platforms", () => {
    const result = generatePackageSwift("Api", { iOS: "16.4" });
    expect(result).toContain(".iOS(.v16_4)");
  });
});

describe("generateRoutesNamespace", () => {
  it("generates route constants grouped by prefix", () => {
    const routes: RouteInfo[] = [
      { name: "users.list", prefix: "users", routeName: "list", handler: "typed" },
      { name: "users.get", prefix: "users", routeName: "get", handler: "typed" },
      { name: "auth.login", prefix: "auth", routeName: "login", handler: "typed" },
    ];

    const result = generateRoutesNamespace(routes);
    expect(result).toContain("public enum Routes {");
    expect(result).toContain("public enum Users {");
    expect(result).toContain('public static let list = "users.list"');
    expect(result).toContain('public static let get = "users.get"');
    expect(result).toContain("public enum Auth {");
    expect(result).toContain('public static let login = "auth.login"');
  });
});

describe("generateApiClient", () => {
  it("generates ApiClient class", () => {
    const result = generateApiClient("TestApi");
    expect(result).toContain("public final class ApiClient: ApiClientBase");
    expect(result).toContain("public let apiVersion: String?");
    expect(result).toContain("apiVersion: String? = nil");
  });

  it("supports default apiVersion", () => {
    const result = generateApiClient("TestApi", "2.0");
    expect(result).toContain('apiVersion: String? = "2.0"');
  });
});

describe("generateApiClientExtensions", () => {
  it("generates typed route methods", () => {
    const routes: RouteInfo[] = [
      {
        name: "users.create",
        prefix: "users",
        routeName: "create",
        handler: "typed",
        inputSource: 'z.object({ name: z.string() })',
        outputSource: 'z.object({ id: z.string() })',
      },
    ];

    const result = generateApiClientExtensions(routes);
    expect(result).toContain("extension ApiClient {");
    expect(result).toContain("public func create(_ input: CreateInput) async throws -> CreateOutput");
    expect(result).toContain("try await request(route: Routes.Users.create, input: input)");
  });

  it("generates raw route methods", () => {
    const routes: RouteInfo[] = [
      { name: "files.upload", prefix: "files", routeName: "upload", handler: "raw" },
    ];

    const result = generateApiClientExtensions(routes);
    expect(result).toContain('public func upload(method: String = "POST"');
    expect(result).toContain("try await rawRequest(route: Routes.Files.upload");
  });

  it("generates sse route methods", () => {
    const routes: RouteInfo[] = [
      { name: "events.stream", prefix: "events", routeName: "stream", handler: "sse" },
    ];

    const result = generateApiClientExtensions(routes);
    expect(result).toContain("public func stream() -> SSEConnection");
    expect(result).toContain("sseConnect(route: Routes.Events.stream");
  });

  it("generates stream route methods", () => {
    const routes: RouteInfo[] = [
      { name: "data.download", prefix: "data", routeName: "download", handler: "stream" },
    ];

    const result = generateApiClientExtensions(routes);
    expect(result).toContain("public func download() async throws -> (URLSession.AsyncBytes, HTTPURLResponse)");
  });

  it("generates html route methods", () => {
    const routes: RouteInfo[] = [
      { name: "pages.home", prefix: "pages", routeName: "home", handler: "html" },
    ];

    const result = generateApiClientExtensions(routes);
    expect(result).toContain("public func home() async throws -> String");
    expect(result).toContain("try await htmlRequest(route: Routes.Pages.home");
  });

  it("generates formData route methods", () => {
    const routes: RouteInfo[] = [
      {
        name: "media.upload",
        prefix: "media",
        routeName: "upload",
        handler: "formData",
        inputSource: 'z.object({ title: z.string() })',
      },
    ];

    const result = generateApiClientExtensions(routes);
    expect(result).toContain("public func upload(fields: UploadInput, files:");
    expect(result).toContain("try await formDataRequest(route: Routes.Media.upload");
  });

  it("handles routes with no input", () => {
    const routes: RouteInfo[] = [
      {
        name: "health.check",
        prefix: "health",
        routeName: "check",
        handler: "typed",
        outputSource: 'z.object({ ok: z.boolean() })',
      },
    ];

    const result = generateApiClientExtensions(routes);
    expect(result).toContain("public func check() async throws -> CheckOutput");
    expect(result).toContain("try await request(route: Routes.Health.check, input: EmptyInput())");
  });
});

describe("generateModelFile", () => {
  it("generates models for typed routes with schemas", () => {
    const routes: RouteInfo[] = [
      {
        name: "users.create",
        prefix: "users",
        routeName: "create",
        handler: "typed",
        inputSource: 'z.object({ name: z.string(), email: z.string() })',
        outputSource: 'z.object({ id: z.string() })',
      },
    ];

    const result = generateModelFile("users", routes);
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("UsersModels.swift");
    expect(result!.content).toContain("public struct CreateInput: Codable, Sendable");
    expect(result!.content).toContain("public let name: String");
    expect(result!.content).toContain("public struct CreateOutput: Codable, Sendable");
    expect(result!.content).toContain("public let id: String");
  });

  it("returns null for routes with no schemas", () => {
    const routes: RouteInfo[] = [
      { name: "health.ping", prefix: "health", routeName: "ping", handler: "raw" },
    ];

    const result = generateModelFile("health", routes);
    expect(result).toBeNull();
  });

  it("skips output models for stream/html/sse handlers", () => {
    const routes: RouteInfo[] = [
      {
        name: "data.stream",
        prefix: "data",
        routeName: "stream",
        handler: "stream",
        inputSource: 'z.object({ query: z.string() })',
        outputSource: 'z.object({ data: z.string() })', // should be skipped
      },
    ];

    const result = generateModelFile("data", routes);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("StreamInput");
    expect(result!.content).not.toContain("StreamOutput");
  });
});

describe("generateClient (full integration)", () => {
  it("generates a complete Swift package structure", async () => {
    cleanup();

    const routes: RouteInfo[] = [
      {
        name: "users.list",
        prefix: "users",
        routeName: "list",
        handler: "typed",
        outputSource: 'z.array(z.object({ id: z.string(), name: z.string() }))',
      },
      {
        name: "users.create",
        prefix: "users",
        routeName: "create",
        handler: "typed",
        inputSource: 'z.object({ name: z.string(), email: z.string() })',
        outputSource: 'z.object({ id: z.string() })',
      },
      {
        name: "auth.login",
        prefix: "auth",
        routeName: "login",
        handler: "typed",
        inputSource: 'z.object({ username: z.string(), password: z.string() })',
        outputSource: 'z.object({ token: z.string() })',
      },
    ];

    await generateClient(
      { swift: { packageName: "TestApi" } },
      routes,
      TMP_DIR
    );

    const packageDir = join(TMP_DIR, "TestApi");
    const sourcesDir = join(packageDir, "Sources", "TestApi");
    const modelsDir = join(sourcesDir, "Models");

    // Verify directory structure
    expect(existsSync(join(packageDir, "Package.swift"))).toBe(true);
    expect(existsSync(join(sourcesDir, "ApiClient.swift"))).toBe(true);
    expect(existsSync(join(sourcesDir, "ApiClient+Routes.swift"))).toBe(true);
    expect(existsSync(join(sourcesDir, "Routes.swift"))).toBe(true);

    // Verify runtime files
    expect(existsSync(join(sourcesDir, "ApiClientBase.swift"))).toBe(true);
    expect(existsSync(join(sourcesDir, "ApiError.swift"))).toBe(true);
    expect(existsSync(join(sourcesDir, "SSEConnection.swift"))).toBe(true);
    expect(existsSync(join(sourcesDir, "AnyCodable.swift"))).toBe(true);

    // Verify model files
    expect(existsSync(join(modelsDir, "UsersModels.swift"))).toBe(true);
    expect(existsSync(join(modelsDir, "AuthModels.swift"))).toBe(true);

    // Verify Package.swift content
    const packageSwift = readFileSync(join(packageDir, "Package.swift"), "utf-8");
    expect(packageSwift).toContain('name: "TestApi"');
    expect(packageSwift).toContain(".iOS(.v15)");

    // Verify Routes.swift content
    const routesSwift = readFileSync(join(sourcesDir, "Routes.swift"), "utf-8");
    expect(routesSwift).toContain("public enum Users {");
    expect(routesSwift).toContain("public enum Auth {");

    // Verify ApiClient content
    const clientSwift = readFileSync(join(sourcesDir, "ApiClient.swift"), "utf-8");
    expect(clientSwift).toContain("public final class ApiClient: ApiClientBase");

    // Verify extensions
    const extensionsSwift = readFileSync(join(sourcesDir, "ApiClient+Routes.swift"), "utf-8");
    expect(extensionsSwift).toContain("extension ApiClient {");
    expect(extensionsSwift).toContain("func list(");
    expect(extensionsSwift).toContain("func create(");
    expect(extensionsSwift).toContain("func login(");

    // Verify models
    const usersModels = readFileSync(join(modelsDir, "UsersModels.swift"), "utf-8");
    expect(usersModels).toContain("CreateInput");
    expect(usersModels).toContain("CreateOutput");

    cleanup();
  });
});
