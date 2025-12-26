import { afterEach, describe, expect, it } from "bun:test";
import nodemailer from "nodemailer";
import { ErrorMailer, MessageMailer } from "../index";

const originalTransport = nodemailer.createTransport;

function setMailEnv() {
  Bun.env.SMTP_HOST = "smtp.local";
  Bun.env.SMTP_PORT = 587 as any;
  Bun.env.SMTP_USERNAME = "user";
  Bun.env.SMTP_PASSWORD = "pass";
  Bun.env.SMTP_FROM_EMAIL = "from@example.com";
  Bun.env.SMTP_REPLY_EMAIL = "reply@example.com";
  Bun.env.SMTP_TLS_CIPHERS = "TLS_AES_256_GCM_SHA384";
  Bun.env.SMTP_SECURE = false as any;
}

afterEach(() => {
  nodemailer.createTransport = originalTransport;
});

describe("mailers", () => {
  it("sends critical error email", async () => {
    setMailEnv();
    let sendOptions: any;
    nodemailer.createTransport = () =>
      ({
        async sendMail(options: any) {
          sendOptions = options;
          return { messageId: "error-1" };
        },
      }) as any;

    await ErrorMailer.notify("failure message");
    expect(sendOptions.subject).toBe("CRITICAL SERVER ERROR");
    expect(sendOptions.text).toBe("failure message");
  });

  it("sends generic message email", async () => {
    setMailEnv();
    let sendOptions: any;
    nodemailer.createTransport = () =>
      ({
        async sendMail(options: any) {
          sendOptions = options;
          return { messageId: "msg-1" };
        },
      }) as any;

    await MessageMailer.notify({
      message: "hello",
      to: "to@example.com",
      cc: ["cc@example.com"],
      subject: "subject",
    });

    expect(sendOptions.to).toBe("to@example.com");
    expect(sendOptions.cc).toEqual(["cc@example.com"]);
    expect(sendOptions.subject).toBe("subject");
    expect(sendOptions.text).toBe("hello");
  });
});
