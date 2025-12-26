import qrcode from "qrcode";
import { authenticator } from "otplib";
import { logger } from "@donkeylabs/audit-logs";

const service = "PitsaApp";

export const generateAuthenticatorQRCode = async (secret: string, username: string): Promise<string> => {
  const otpauth = authenticator.keyuri(username, service, secret);
  try {
    return await qrcode.toDataURL(otpauth);
  } catch (error) {
    logger.auth.error("Error generating QR code:", error);
    throw error;
  }
};

export const generateSecret = (): string => authenticator.generateSecret();

export const generateOTPCode = (secret: string): string => authenticator.generate(secret);

export const verifyCode = (otpCode: string, secret: string): boolean => authenticator.check(otpCode, secret);
