/**
 * Email Plugin - Transactional email with multiple providers
 *
 * Providers:
 * - resend: Resend.com API
 * - console: Log emails to console (development)
 *
 * Features:
 * - Magic link generation and validation
 * - Password reset tokens
 * - Email verification
 * - Template support
 */

import { createPlugin } from "@donkeylabs/server";
import type { ColumnType } from "kysely";

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

export type EmailProvider = "resend" | "console";

export interface EmailConfig {
  /**
   * Email provider
   * @default "console"
   */
  provider?: EmailProvider;

  /**
   * Provider-specific configuration
   */
  resend?: {
    apiKey: string;
  };

  /**
   * Default from address
   */
  from: string;

  /**
   * Base URL for links (e.g., "https://myapp.com")
   */
  baseUrl: string;

  /**
   * Token expiry times
   */
  expiry?: {
    /** Magic link expiry @default "15m" */
    magicLink?: string;
    /** Password reset expiry @default "1h" */
    passwordReset?: string;
    /** Email verification expiry @default "24h" */
    emailVerification?: string;
  };
}

// =============================================================================
// DATABASE SCHEMA
// =============================================================================

interface EmailTokensTable {
  id: string;
  type: "magic_link" | "password_reset" | "email_verification";
  email: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: ColumnType<string, string | undefined, never>;
}

interface EmailSchema {
  email_tokens: EmailTokensTable;
}

// =============================================================================
// TYPES
// =============================================================================

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 15 * 60 * 1000; // Default 15 minutes

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 15 * 60 * 1000;
  }
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const emailPlugin = createPlugin
  .withSchema<EmailSchema>()
  .withConfig<EmailConfig>()
  .define({
    name: "email",

    customErrors: {
      InvalidToken: {
        status: 400,
        code: "INVALID_TOKEN",
        message: "Invalid or expired token",
      },
      TokenAlreadyUsed: {
        status: 400,
        code: "TOKEN_USED",
        message: "This token has already been used",
      },
      SendFailed: {
        status: 500,
        code: "EMAIL_SEND_FAILED",
        message: "Failed to send email",
      },
    },

    service: async (ctx) => {
      const config = ctx.config!;
      const provider = config.provider || "console";
      const from = config.from;
      const baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash

      const magicLinkExpiry = parseExpiry(config.expiry?.magicLink || "15m");
      const passwordResetExpiry = parseExpiry(config.expiry?.passwordReset || "1h");
      const emailVerificationExpiry = parseExpiry(config.expiry?.emailVerification || "24h");

      /**
       * Send email using configured provider
       */
      async function sendEmail(options: SendEmailOptions): Promise<EmailResult> {
        const emailFrom = options.from || from;
        const recipients = Array.isArray(options.to) ? options.to : [options.to];

        if (provider === "console") {
          ctx.core.logger.info("Email sent (console provider)", {
            to: recipients,
            subject: options.subject,
            from: emailFrom,
          });
          console.log("\n" + "=".repeat(60));
          console.log(`📧 EMAIL TO: ${recipients.join(", ")}`);
          console.log(`   FROM: ${emailFrom}`);
          console.log(`   SUBJECT: ${options.subject}`);
          console.log("-".repeat(60));
          console.log(options.text || options.html);
          console.log("=".repeat(60) + "\n");
          return { success: true, messageId: `console-${Date.now()}` };
        }

        if (provider === "resend") {
          if (!config.resend?.apiKey) {
            throw new Error("Resend API key not configured");
          }

          try {
            const response = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${config.resend.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: emailFrom,
                to: recipients,
                subject: options.subject,
                html: options.html,
                text: options.text,
                reply_to: options.replyTo,
              }),
            });

            if (!response.ok) {
              const error = await response.text();
              ctx.core.logger.error("Resend API error", { error, status: response.status });
              return { success: false, error };
            }

            const data = await response.json() as { id: string };
            return { success: true, messageId: data.id };
          } catch (error) {
            ctx.core.logger.error("Failed to send email via Resend", { error });
            return { success: false, error: String(error) };
          }
        }

        return { success: false, error: `Unknown provider: ${provider}` };
      }

      /**
       * Create a token and store hash
       */
      async function createToken(
        type: "magic_link" | "password_reset" | "email_verification",
        email: string,
        expiryMs: number
      ): Promise<string> {
        const token = generateToken();
        const tokenHash = await Bun.password.hash(token, {
          algorithm: "bcrypt",
          cost: 4, // Low cost for tokens
        });

        await ctx.db
          .insertInto("email_tokens")
          .values({
            id: crypto.randomUUID(),
            type,
            email: email.toLowerCase(),
            token_hash: tokenHash,
            expires_at: new Date(Date.now() + expiryMs).toISOString(),
            used_at: null,
            created_at: new Date().toISOString(),
          })
          .execute();

        return token;
      }

      /**
       * Validate and consume a token
       */
      async function validateToken(
        type: "magic_link" | "password_reset" | "email_verification",
        email: string,
        token: string
      ): Promise<boolean> {
        const tokens = await ctx.db
          .selectFrom("email_tokens")
          .where("type", "=", type)
          .where("email", "=", email.toLowerCase())
          .where("used_at", "is", null)
          .where("expires_at", ">", new Date().toISOString())
          .selectAll()
          .execute();

        for (const stored of tokens) {
          const valid = await Bun.password.verify(token, stored.token_hash);
          if (valid) {
            // Mark as used
            await ctx.db
              .updateTable("email_tokens")
              .set({ used_at: new Date().toISOString() })
              .where("id", "=", stored.id)
              .execute();
            return true;
          }
        }

        return false;
      }

      return {
        /**
         * Send a raw email
         */
        send: sendEmail,

        /**
         * Send magic link for passwordless login
         */
        sendMagicLink: async (email: string, redirectPath: string = "/"): Promise<EmailResult> => {
          const token = await createToken("magic_link", email, magicLinkExpiry);
          const magicLink = `${baseUrl}/auth/magic?token=${token}&email=${encodeURIComponent(email)}&redirect=${encodeURIComponent(redirectPath)}`;

          return sendEmail({
            to: email,
            subject: "Sign in to your account",
            html: `
              <h2>Sign in to your account</h2>
              <p>Click the link below to sign in. This link expires in 15 minutes.</p>
              <p><a href="${magicLink}" style="display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 4px;">Sign In</a></p>
              <p style="color: #666; font-size: 14px;">Or copy this link: ${magicLink}</p>
              <p style="color: #999; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
            `,
            text: `Sign in to your account\n\nClick here to sign in: ${magicLink}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
          });
        },

        /**
         * Validate magic link token and return email if valid
         */
        validateMagicLink: async (email: string, token: string): Promise<boolean> => {
          return validateToken("magic_link", email, token);
        },

        /**
         * Send password reset email
         */
        sendPasswordReset: async (email: string): Promise<EmailResult> => {
          const token = await createToken("password_reset", email, passwordResetExpiry);
          const resetLink = `${baseUrl}/auth/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

          return sendEmail({
            to: email,
            subject: "Reset your password",
            html: `
              <h2>Reset your password</h2>
              <p>Click the link below to reset your password. This link expires in 1 hour.</p>
              <p><a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 4px;">Reset Password</a></p>
              <p style="color: #666; font-size: 14px;">Or copy this link: ${resetLink}</p>
              <p style="color: #999; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
            `,
            text: `Reset your password\n\nClick here to reset: ${resetLink}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore this email.`,
          });
        },

        /**
         * Validate password reset token
         */
        validatePasswordReset: async (email: string, token: string): Promise<boolean> => {
          return validateToken("password_reset", email, token);
        },

        /**
         * Send email verification
         */
        sendVerification: async (email: string): Promise<EmailResult> => {
          const token = await createToken("email_verification", email, emailVerificationExpiry);
          const verifyLink = `${baseUrl}/auth/verify-email?token=${token}&email=${encodeURIComponent(email)}`;

          return sendEmail({
            to: email,
            subject: "Verify your email address",
            html: `
              <h2>Verify your email address</h2>
              <p>Click the link below to verify your email. This link expires in 24 hours.</p>
              <p><a href="${verifyLink}" style="display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 4px;">Verify Email</a></p>
              <p style="color: #666; font-size: 14px;">Or copy this link: ${verifyLink}</p>
              <p style="color: #999; font-size: 12px;">If you didn't create an account, you can safely ignore this email.</p>
            `,
            text: `Verify your email address\n\nClick here to verify: ${verifyLink}\n\nThis link expires in 24 hours.\n\nIf you didn't create an account, you can safely ignore this email.`,
          });
        },

        /**
         * Validate email verification token
         */
        validateVerification: async (email: string, token: string): Promise<boolean> => {
          return validateToken("email_verification", email, token);
        },

        /**
         * Cleanup expired tokens
         */
        cleanup: async (): Promise<number> => {
          const result = await ctx.db
            .deleteFrom("email_tokens")
            .where("expires_at", "<", new Date().toISOString())
            .executeTakeFirst();

          const count = Number(result.numDeletedRows);
          if (count > 0) {
            ctx.core.logger.info("Cleaned up expired email tokens", { count });
          }
          return count;
        },
      };
    },

    init: async (ctx, service) => {
      // Cleanup expired tokens daily
      ctx.core.cron.schedule(
        "0 4 * * *", // Daily at 4am
        async () => {
          await service.cleanup();
        },
        { name: "email-token-cleanup" }
      );

      ctx.core.logger.info("Email plugin initialized", {
        provider: ctx.config?.provider || "console",
      });
    },
  });
