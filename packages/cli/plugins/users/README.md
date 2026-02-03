# Users Plugin

A user management plugin for @donkeylabs/server providing CRUD operations and email-based authentication support.

## Features

- **User CRUD**: Create, read, update, delete users
- **Email lookup**: Find users by unique email address
- **Password support**: Optional password_hash field for auth workflows
- **Search & pagination**: List users with search and pagination
- **Event system**: Emits events on user changes
- **Type-safe**: Full TypeScript support with Kysely

## Usage

```typescript
import { usersPlugin } from "./plugins/users";

// Register the plugin
const app = createApp({
  plugins: [usersPlugin],
});

// In routes or other plugins
const user = await ctx.plugins.users.create({
  email: "user@example.com",
  name: "John Doe",
  passwordHash: "hashed_password_here", // optional
});

const existing = await ctx.plugins.users.getByEmail("user@example.com");
const list = await ctx.plugins.users.list({ page: 1, limit: 10 });
```

## Service Methods

| Method | Description |
|--------|-------------|
| `getById(id)` | Get user by ID |
| `getByEmail(email)` | Get user by email (case-insensitive) |
| `create(input)` | Create a new user |
| `list(params)` | List users with optional search/pagination |
| `update(id, input)` | Update user fields |
| `delete(id, permanent?)` | Delete user (hard delete) |

## Events

- `user.created` - Emitted when a user is created
- `user.updated` - Emitted when a user is updated
- `user.deleted` - Emitted when a user is deleted

## Schema

The users table includes:
- `id` - Primary key (text)
- `email` - Unique, indexed (text)
- `name` - Optional display name (text, nullable)
- `password_hash` - Optional hashed password (text, nullable)
- `created_at` - Timestamp (text)
- `updated_at` - Timestamp (text)

## Installation

The plugin is automatically registered with migrations when you start the server. Run migrations to create the users table.
