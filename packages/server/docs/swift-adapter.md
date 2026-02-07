# Swift Adapter

`@donkeylabs/adapter-swift` generates a typed Swift Package (SPM) from @donkeylabs/server routes. The generated package includes Codable models, async/await networking, and SSE support.

## Features

- **Typed Models** - Zod schemas become Codable Swift structs and enums
- **Async/Await** - URLSession-based networking with Swift concurrency
- **All Handler Types** - typed, raw, stream, SSE, formData, and html
- **SSE Support** - Real-time streaming with typed events and auto-reconnect
- **API Versioning** - Optional `X-API-Version` header support
- **SPM Ready** - Generates a complete Swift Package with Package.swift

---

## Installation

```bash
bun add @donkeylabs/adapter-swift
```

---

## Generation

### CLI

```bash
donkeylabs generate --adapter swift --output ./swift-client
```

### Configuration

In `donkeylabs.config.ts`:

```ts
export default {
  plugins: ["./src/plugins/*"],
  routes: "./src/routes",
  swift: {
    packageName: "MyApi",        // SPM package name (default: "ApiClient")
    platforms: {                   // Minimum platform versions
      iOS: "15.0",
      macOS: "12.0",
    },
    apiVersion: "2.0",            // Default X-API-Version header
  },
};
```

### Programmatic

```ts
import { generateClient } from "@donkeylabs/adapter-swift";

await generateClient(config, routes, "./output");
```

---

## Generated Structure

```
MyApi/
├── Package.swift
└── Sources/
    └── MyApi/
        ├── ApiClient.swift           # Main client class
        ├── ApiClient+Routes.swift    # Route method extensions
        ├── Routes.swift              # Route name constants
        ├── ApiClientBase.swift       # URLSession networking runtime
        ├── ApiError.swift            # Error types
        ├── SSEConnection.swift       # SSE streaming runtime
        ├── AnyCodable.swift          # Dynamic JSON wrapper
        └── Models/
            ├── UsersModels.swift     # Per-namespace model files
            └── OrdersModels.swift
```

---

## Usage in Swift

### Setup

```swift
import MyApi

let client = ApiClient(
    baseURL: URL(string: "https://api.example.com")!,
    apiVersion: "2.0"
)
```

### Typed Routes

```swift
// Input/output are fully typed Codable structs
let result = try await client.create(CreateInput(name: "Alice", email: "alice@example.com"))
print(result.id)  // String

let users = try await client.list()
for user in users {
    print(user.name)
}
```

### Raw Routes

```swift
let (data, response) = try await client.upload(
    method: "POST",
    body: fileData,
    headers: ["Content-Type": "application/octet-stream"]
)
```

### SSE Routes

```swift
let connection = client.stream()

// Typed event handling
connection.on("notification") { (event: NotificationEvent) in
    print(event.message)
}

// Start listening
Task {
    await connection.connect()
}

// Later: disconnect
connection.close()
```

### Stream Routes

```swift
let (bytes, response) = try await client.download()
for try await chunk in bytes {
    // Process streaming data
}
```

### FormData Routes

```swift
let result = try await client.upload(
    fields: UploadInput(title: "Photo"),
    files: [
        FormFile(name: "file", filename: "photo.jpg", data: imageData, mimeType: "image/jpeg")
    ]
)
```

### HTML Routes

```swift
let html: String = try await client.home()
```

---

## Type Mapping

Zod schemas are converted to Swift types:

| Zod | Swift |
|-----|-------|
| `z.string()` | `String` |
| `z.number()` | `Double` |
| `z.boolean()` | `Bool` |
| `z.date()` | `Date` |
| `z.bigint()` | `Int64` |
| `z.any()` / `z.unknown()` | `AnyCodable` |
| `z.object({...})` | `struct: Codable, Sendable` |
| `z.array(T)` | `[SwiftType]` |
| `z.optional()` / `z.nullable()` | `SwiftType?` |
| `z.enum(["a", "b"])` | `enum: String, Codable, Sendable` |
| `z.union([A, B])` | `enum` with associated values |
| `z.record(K, V)` | `[String: SwiftType]` |
| `z.tuple([A, B])` | `struct` with `_0`, `_1` fields |
| `z.literal("x")` | `String` / `Int` / `Bool` |

### Nested Types

Objects generate named structs. Nested objects use the parent type name as prefix:

```
z.object({ address: z.object({ street: z.string() }) })
```

Generates:
```swift
public struct CreateInput: Codable, Sendable {
    public let address: CreateInputAddress
}

public struct CreateInputAddress: Codable, Sendable {
    public let street: String
}
```

### CodingKeys

When JSON property names differ from valid Swift identifiers, CodingKeys are generated automatically:

```swift
public struct Item: Codable, Sendable {
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case createdAt = "created_at"
    }
}
```

---

## Error Handling

The generated client uses `ApiError` for all error cases:

```swift
do {
    let user = try await client.get(GetInput(id: "123"))
} catch let error as ApiError {
    switch error {
    case .server(let status, let code, let message, let details):
        print("Server error \(status): \(code) - \(message)")
    case .validation(let issues):
        for issue in issues {
            print("Validation: \(issue)")
        }
    case .invalidResponse:
        print("Could not decode response")
    case .networkError(let underlying):
        print("Network: \(underlying.localizedDescription)")
    }
}
```

---

## API Versioning

Set a default API version in the client:

```swift
// All requests include X-API-Version: 2.0
let client = ApiClient(
    baseURL: URL(string: "https://api.example.com")!,
    apiVersion: "2.0"
)
```

The version is sent as the `X-API-Version` header on every request. See [Versioning](versioning.md) for server-side configuration.

---

## Route Constants

All route names are available as static constants:

```swift
// Generated Routes namespace
Routes.Users.list    // "users.list"
Routes.Users.create  // "users.create"
Routes.Auth.login    // "auth.login"
```

---

## Adding to an Xcode Project

1. Generate the Swift package:
   ```bash
   donkeylabs generate --adapter swift --output ./ios/ApiClient
   ```

2. In Xcode: File > Add Package Dependencies > Add Local > select the generated folder

3. Import and use:
   ```swift
   import MyApi
   ```

### Minimum Requirements

- iOS 15.0+ / macOS 12.0+
- Swift 5.9+
- Xcode 15+
