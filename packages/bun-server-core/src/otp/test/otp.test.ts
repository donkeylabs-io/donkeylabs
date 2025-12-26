import { describe, expect, it } from "bun:test";
import {
  generateAuthenticatorQRCode,
  generateOTPCode,
  generateSecret,
  verifyCode,
} from "../otp";

describe("otp helpers", () => {
  it("generates secrets and verifies codes", () => {
    const secret = generateSecret();
    expect(secret).toBeString();

    const code = generateOTPCode(secret);
    expect(code).toHaveLength(6);
    expect(verifyCode(code, secret)).toBeTrue();
  });

  it("produces a QR code data url", async () => {
    const secret = generateSecret();
    const dataUrl = await generateAuthenticatorQRCode(secret, "tester");
    expect(dataUrl.startsWith("data:image/png;base64,")).toBeTrue();
  });
});
