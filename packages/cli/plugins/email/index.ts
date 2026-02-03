/**
 * Email Plugin
 *
 * Email sending with template support and queue management.
 * Supports SMTP configuration with retry logic and queuing.
 */

import { createPlugin, type ErrorFactory } from "@donkeylabs/server";
import { createTransport, Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { z } from "zod";
import type { DB } from "./schema";

declare module "@donkeylabs/server" {
  interface ErrorFactories {
    EmailSendFailed: ErrorFactory;
    TemplateNotFound: ErrorFactory;
    InvalidEmail: ErrorFactory;
    SMTPConnectionFailed: ErrorFactory;
  }
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

export interface EmailTemplate {
  name: string;
  subject: string;
  text?: string;
  html?: string;
}

export interface QueuedEmail extends EmailMessage {
  templateName?: string;
  templateData?: Record<string, any>;
  priority?: "high" | "normal" | "low";
  scheduledAt?: string;
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface EmailQueueStatus {
  pending: number;
  failed: number;
  sent: number;
}

export interface EmailService {
  send(message: EmailMessage): Promise<EmailSendResult>;
  sendTemplate(
    templateName: string,
    to: string | string[],
    data: Record<string, any>
  ): Promise<EmailSendResult>;
  queue(message: QueuedEmail): Promise<string>;
  getQueueStatus(): Promise<EmailQueueStatus>;
  processQueue(limit?: number): Promise<number>;
  registerTemplate(template: EmailTemplate): void;
  verifyConnection(): Promise<boolean>;
}

export const emailPlugin = createPlugin
  .withSchema<DB>()
  .define({
    name: "email",
    version: "1.0.0",

    events: {
      "email.sent": z.object({
        messageId: z.string(),
        to: z.string(),
        subject: z.string(),
      }),
      "email.failed": z.object({
        emailId: z.string(),
        error: z.string(),
        attempt: z.number(),
      }),
      "email.queued": z.object({
        emailId: z.string(),
        to: z.string(),
        priority: z.string(),
      }),
    },

    customErrors: {
      EmailSendFailed: {
        status: 500,
        code: "EMAIL_SEND_FAILED",
        message: "Failed to send email",
      },
      TemplateNotFound: {
        status: 404,
        code: "TEMPLATE_NOT_FOUND",
        message: "Email template not found",
      },
      InvalidEmail: {
        status: 400,
        code: "INVALID_EMAIL",
        message: "Invalid email address",
      },
      SMTPConnectionFailed: {
        status: 500,
        code: "SMTP_CONNECTION_FAILED",
        message: "Could not connect to SMTP server",
      },
    },

    service: async (ctx) => {
      const db = ctx.db;
      const logger = ctx.core.logger.child({ plugin: "email" });
      const config = ctx.config.plugins?.email || {};
      const templates = new Map<string, EmailTemplate>();

      // Initialize SMTP transport
      let transporter: Transporter<SMTPTransport.SentMessageInfo> | null = null;

      function getTransporter(): Transporter<SMTPTransport.SentMessageInfo> {
        if (!transporter) {
          const smtpConfig: SMTPTransport.Options = {
            host: config.smtp?.host || process.env.SMTP_HOST || "localhost",
            port: config.smtp?.port || parseInt(process.env.SMTP_PORT || "587"),
            secure: config.smtp?.secure || process.env.SMTP_SECURE === "true",
            auth: {
              user: config.smtp?.user || process.env.SMTP_USER || "",
              pass: config.smtp?.pass || process.env.SMTP_PASS || "",
            },
            from: config.from || process.env.EMAIL_FROM || "noreply@example.com",
          };

          transporter = createTransport(smtpConfig);
          logger.info({ host: smtpConfig.host, port: smtpConfig.port }, "SMTP transport created");
        }
        return transporter;
      }

      function generateEmailId(): string {
        return `eml_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      }

      function validateEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
      }

      function compileTemplate(template: string, data: Record<string, any>): string {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
          return data[key] !== undefined ? String(data[key]) : match;
        });
      }

      return {
        async send(message: EmailMessage): Promise<EmailSendResult> {
          try {
            // Validate email addresses
            const recipients = Array.isArray(message.to) ? message.to : [message.to];
            for (const email of recipients) {
              if (!validateEmail(email)) {
                throw ctx.core.errors.InvalidEmail();
              }
            }

            const transport = getTransporter();
            const from = message.from || config.from || process.env.EMAIL_FROM || "noreply@example.com";

            const result = await transport.sendMail({
              from,
              to: message.to,
              subject: message.subject,
              text: message.text,
              html: message.html,
              cc: message.cc,
              bcc: message.bcc,
              replyTo: message.replyTo,
              attachments: message.attachments,
            });

            ctx.core.events.emit("email.sent", {
              messageId: result.messageId,
              to: Array.isArray(message.to) ? message.to.join(", ") : message.to,
              subject: message.subject,
            });

            logger.info({ messageId: result.messageId, to: message.to }, "Email sent");

            return {
              success: true,
              messageId: result.messageId,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            logger.error({ error: errorMessage, to: message.to }, "Email send failed");
            
            return {
              success: false,
              error: errorMessage,
            };
          }
        },

        async sendTemplate(
          templateName: string,
          to: string | string[],
          data: Record<string, any>
        ): Promise<EmailSendResult> {
          const template = templates.get(templateName);
          if (!template) {
            throw ctx.core.errors.TemplateNotFound();
          }

          const subject = compileTemplate(template.subject, data);
          const text = template.text ? compileTemplate(template.text, data) : undefined;
          const html = template.html ? compileTemplate(template.html, data) : undefined;

          return this.send({
            to,
            subject,
            text,
            html,
          });
        },

        async queue(message: QueuedEmail): Promise<string> {
          const emailId = generateEmailId();
          const now = new Date().toISOString();
          const priority = message.priority === "high" ? 1 : message.priority === "low" ? -1 : 0;
          const scheduledAt = message.scheduledAt || now;

          // Prepare email content
          let text = message.text;
          let html = message.html;
          let subject = message.subject;

          // If using template, compile it now
          if (message.templateName) {
            const template = templates.get(message.templateName);
            if (template) {
              const data = message.templateData || {};
              subject = compileTemplate(template.subject, data);
              text = template.text ? compileTemplate(template.text, data) : undefined;
              html = template.html ? compileTemplate(template.html, data) : undefined;
            }
          }

          await db
            .insertInto("email_queue")
            .values({
              id: emailId,
              to_address: Array.isArray(message.to) ? message.to.join(",") : message.to,
              from_address: message.from,
              subject,
              text_content: text,
              html_content: html,
              cc: message.cc ? (Array.isArray(message.cc) ? message.cc.join(",") : message.cc) : null,
              bcc: message.bcc ? (Array.isArray(message.bcc) ? message.bcc.join(",") : message.bcc) : null,
              priority,
              scheduled_at: scheduledAt,
              status: "pending",
              attempts: 0,
              created_at: now,
            })
            .execute();

          ctx.core.events.emit("email.queued", {
            emailId,
            to: Array.isArray(message.to) ? message.to.join(", ") : message.to,
            priority: message.priority || "normal",
          });

          logger.info({ emailId, to: message.to, priority: message.priority || "normal" }, "Email queued");

          return emailId;
        },

        async getQueueStatus(): Promise<EmailQueueStatus> {
          const results = await db
            .selectFrom("email_queue")
            .select((eb) => [
              eb.fn.count("id").as("total"),
              "status",
            ])
            .groupBy("status")
            .execute();

          let pending = 0;
          let failed = 0;
          let sent = 0;

          for (const row of results) {
            const count = Number(row.total);
            switch (row.status) {
              case "pending":
                pending = count;
                break;
              case "failed":
                failed = count;
                break;
              case "sent":
                sent = count;
                break;
            }
          }

          return { pending, failed, sent };
        },

        async processQueue(limit: number = 10): Promise<number> {
          const now = new Date().toISOString();
          const maxRetries = config.maxRetries || 3;

          // Get pending emails
          const pendingEmails = await db
            .selectFrom("email_queue")
            .selectAll()
            .where("status", "=", "pending")
            .where("scheduled_at", "<=", now)
            .orderBy("priority", "desc")
            .orderBy("scheduled_at", "asc")
            .limit(limit)
            .execute();

          let processed = 0;

          for (const email of pendingEmails) {
            try {
              const to = email.to_address.split(",").filter(Boolean);
              const result = await this.send({
                to,
                from: email.from_address || undefined,
                subject: email.subject,
                text: email.text_content || undefined,
                html: email.html_content || undefined,
                cc: email.cc ? email.cc.split(",").filter(Boolean) : undefined,
                bcc: email.bcc ? email.bcc.split(",").filter(Boolean) : undefined,
              });

              if (result.success) {
                await db
                  .updateTable("email_queue")
                  .set({
                    status: "sent",
                    sent_at: now,
                    attempts: email.attempts + 1,
                  })
                  .where("id", "=", email.id)
                  .execute();
                processed++;
              } else {
                const newStatus = email.attempts + 1 >= maxRetries ? "failed" : "pending";
                await db
                  .updateTable("email_queue")
                  .set({
                    status: newStatus,
                    error_message: result.error,
                    attempts: email.attempts + 1,
                    scheduled_at: newStatus === "pending"
                      ? new Date(Date.now() + 60000 * (email.attempts + 1)).toISOString()
                      : undefined,
                  })
                  .where("id", "=", email.id)
                  .execute();

                ctx.core.events.emit("email.failed", {
                  emailId: email.id,
                  error: result.error || "Unknown error",
                  attempt: email.attempts + 1,
                });
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : "Unknown error";
              const newStatus = email.attempts + 1 >= maxRetries ? "failed" : "pending";
              
              await db
                .updateTable("email_queue")
                .set({
                  status: newStatus,
                  error_message: errorMessage,
                  attempts: email.attempts + 1,
                })
                .where("id", "=", email.id)
                .execute();

              ctx.core.events.emit("email.failed", {
                emailId: email.id,
                error: errorMessage,
                attempt: email.attempts + 1,
              });
            }
          }

          return processed;
        },

        registerTemplate(template: EmailTemplate): void {
          templates.set(template.name, template);
          logger.info({ name: template.name }, "Email template registered");
        },

        async verifyConnection(): Promise<boolean> {
          try {
            const transport = getTransporter();
            await transport.verify();
            return true;
          } catch (error) {
            logger.error({ error }, "SMTP connection verification failed");
            return false;
          }
        },
      };
    },
  });

export type { DB } from "./schema";
