import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { logger } from "@donkeylabs/audit-logs";

declare module "bun" {
  interface Env {
    SMTP_HOST: string;
    SMTP_PORT: number;
    SMTP_USERNAME: string;
    SMTP_PASSWORD: string;
    SMTP_FROM_EMAIL: string;
    SMTP_REPLY_EMAIL: string;
    SMTP_TLS_CIPHERS: string;
    SMTP_SECURE: boolean;
  }
}

const transporter = () =>
  nodemailer.createTransport({
    host: Bun.env.SMTP_HOST,
    port: Bun.env.SMTP_PORT,
    secure: false,
    auth: {
      user: Bun.env.SMTP_USERNAME,
      pass: Bun.env.SMTP_PASSWORD,
    },
    debug: false,
    logger: false,
  });

export class ErrorMailer {
  static async notify(message: string) {
    const mailer = await transporter().sendMail({
      from: Bun.env.SMTP_FROM_EMAIL,
      to: "pacosw@pitsafrp.com",
      subject: "CRITICAL SERVER ERROR",
      text: message,
    });
    logger.server.debug("Email sent:", mailer.messageId);
  }
}

export class MessageMailer {
  static async notify({
    message,
    to,
    cc,
    subject,
  }: {
    message: string;
    to: string;
    cc: string[];
    subject: string;
  }) {
    const mailer = await transporter().sendMail({
      from: Bun.env.SMTP_FROM_EMAIL,
      to,
      cc,
      subject,
      text: message,
    } satisfies SMTPTransport.Options);
    logger.server.debug("Email sent:", mailer.messageId);
  }
}
