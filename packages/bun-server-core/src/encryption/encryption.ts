import * as crypto from "crypto";
import { logger } from "@donkeylabs/audit-logs";

const IV_LENGTH = 16;

export const encryptData = (encryptionKey: string, text: string): string => {
  const key = Buffer.from(encryptionKey, "hex");

  if (key.length !== 32) {
    throw new Error("Invalid key length. Key must be 32 bytes for AES-256-CBC.");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

  let encrypted = cipher.update(text, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
};

export const decryptData = (encryptionKey: string, text: string): string => {
  try {
    const [ivHex, encryptedHex] = text.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const encryptedText = Buffer.from(encryptedHex, "hex");

    const key = Buffer.from(encryptionKey, "hex");
    if (key.length !== 32) {
      throw new Error("Invalid key length. Key must be 32 bytes for AES-256-CBC.");
    }

    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  } catch (error) {
    logger.auth.error("Error decrypting data", error);
    return "";
  }
};
