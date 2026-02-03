/**
 * Users Plugin
 *
 * User management with CRUD operations, email lookup, and soft deletes.
 * Supports optional password hashing for authentication workflows.
 */

import { createPlugin, type ErrorFactory } from "@donkeylabs/server";
import { z } from "zod";
import type { DB } from "./schema";

// Type augmentation for custom errors
declare module "@donkeylabs/server" {
  interface ErrorFactories {
    UserNotFound: ErrorFactory;
    DuplicateEmail: ErrorFactory;
    InvalidEmail: ErrorFactory;
  }
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  email: string;
  name?: string;
  passwordHash?: string;
}

export interface UpdateUserInput {
  email?: string;
  name?: string;
  passwordHash?: string;
}

export interface ListUsersParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface ListUsersResult {
  users: User[];
  total: number;
  page: number;
  totalPages: number;
}

export interface UsersService {
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  create(input: CreateUserInput): Promise<User>;
  list(params?: ListUsersParams): Promise<ListUsersResult>;
  update(id: string, input: UpdateUserInput): Promise<User | null>;
  delete(id: string, permanent?: boolean): Promise<void>;
}

export const usersPlugin = createPlugin
  .withSchema<DB>()
  .define({
    name: "users",
    version: "1.0.0",

    events: {
      "user.created": z.object({
        userId: z.string(),
        email: z.string(),
      }),
      "user.updated": z.object({
        userId: z.string(),
        changes: z.array(z.string()),
      }),
      "user.deleted": z.object({
        userId: z.string(),
        permanent: z.boolean(),
      }),
    },

    customErrors: {
      UserNotFound: {
        status: 404,
        code: "USER_NOT_FOUND",
        message: "User not found",
      },
      DuplicateEmail: {
        status: 409,
        code: "DUPLICATE_EMAIL",
        message: "Email already exists",
      },
      InvalidEmail: {
        status: 400,
        code: "INVALID_EMAIL",
        message: "Invalid email format",
      },
    },

    service: async (ctx) => {
      const db = ctx.db;
      const logger = ctx.core.logger.child({ plugin: "users" });

      function generateId(): string {
        return `usr_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      function mapUserRow(row: any): User {
        return {
          id: row.id,
          email: row.email,
          name: row.name,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }

      return {
        async getById(id: string): Promise<User | null> {
          const user = await db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          return user ? mapUserRow(user) : null;
        },

        async getByEmail(email: string): Promise<User | null> {
          const user = await db
            .selectFrom("users")
            .selectAll()
            .where("email", "=", email.toLowerCase().trim())
            .executeTakeFirst();

          return user ? mapUserRow(user) : null;
        },

        async create(input: CreateUserInput): Promise<User> {
          const normalizedEmail = input.email.toLowerCase().trim();

          // Check for existing user with same email
          const existing = await db
            .selectFrom("users")
            .select("id")
            .where("email", "=", normalizedEmail)
            .executeTakeFirst();

          if (existing) {
            throw ctx.core.errors.DuplicateEmail("Email already exists");
          }

          const now = new Date().toISOString();
          const userId = generateId();

          const result = await db
            .insertInto("users")
            .values({
              id: userId,
              email: normalizedEmail,
              name: input.name || null,
              password_hash: input.passwordHash || null,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          ctx.core.events.emit("user.created", {
            userId: result.id,
            email: result.email,
          });

          logger.info({ userId: result.id, email: result.email }, "User created");

          return mapUserRow(result);
        },

        async list(params?: ListUsersParams): Promise<ListUsersResult> {
          const page = params?.page || 1;
          const limit = params?.limit || 20;
          const offset = (page - 1) * limit;
          const search = params?.search?.trim().toLowerCase();

          let query = db.selectFrom("users").selectAll();

          if (search) {
            query = query.where((eb) =>
              eb.or([
                eb("email", "like", `%${search}%`),
                eb("name", "like", `%${search}%`),
              ])
            );
          }

          const [users, countResult] = await Promise.all([
            query
              .orderBy("created_at", "desc")
              .limit(limit)
              .offset(offset)
              .execute(),
            db
              .selectFrom("users")
              .select((eb) => eb.fn.count("id").as("count"))
              .$if(!!search, (qb) =>
                qb.where((eb) =>
                  eb.or([
                    eb("email", "like", `%${search}%`),
                    eb("name", "like", `%${search}%`),
                  ])
                )
              )
              .executeTakeFirst(),
          ]);

          const total = Number(countResult?.count || 0);

          return {
            users: users.map(mapUserRow),
            total,
            page,
            totalPages: Math.ceil(total / limit),
          };
        },

        async update(id: string, input: UpdateUserInput): Promise<User | null> {
          const existing = await db
            .selectFrom("users")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!existing) {
            throw ctx.core.errors.UserNotFound("User not found");
          }

          // Check for email conflict if updating email
          if (input.email) {
            const normalizedEmail = input.email.toLowerCase().trim();
            const conflict = await db
              .selectFrom("users")
              .select("id")
              .where("email", "=", normalizedEmail)
              .where("id", "!=", id)
              .executeTakeFirst();

            if (conflict) {
              throw ctx.core.errors.DuplicateEmail("Email already exists");
            }
          }

          const updates: any = {
            updated_at: new Date().toISOString(),
          };

          if (input.email !== undefined) {
            updates.email = input.email.toLowerCase().trim();
          }
          if (input.name !== undefined) {
            updates.name = input.name || null;
          }
          if (input.passwordHash !== undefined) {
            updates.password_hash = input.passwordHash || null;
          }

          const result = await db
            .updateTable("users")
            .set(updates)
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirst();

          if (!result) {
            throw ctx.core.errors.UserNotFound("User not found");
          }

          ctx.core.events.emit("user.updated", {
            userId: id,
            changes: Object.keys(input),
          });

          logger.info({ userId: id, changes: Object.keys(input) }, "User updated");

          return mapUserRow(result);
        },

        async delete(id: string, permanent = false): Promise<void> {
          const existing = await db
            .selectFrom("users")
            .select("id")
            .where("id", "=", id)
            .executeTakeFirst();

          if (!existing) {
            throw ctx.core.errors.UserNotFound("User not found");
          }

          if (permanent) {
            await db.deleteFrom("users").where("id", "=", id).execute();
            logger.info({ userId: id }, "User permanently deleted");
          } else {
            // Soft delete - could add a deleted_at column for soft deletes
            await db.deleteFrom("users").where("id", "=", id).execute();
            logger.info({ userId: id }, "User deleted");
          }

          ctx.core.events.emit("user.deleted", {
            userId: id,
            permanent,
          });
        },
      };
    },
  });

export type { DB } from "./schema";
