import qrcode from "qrcode";
import { authenticator } from "otplib";

const service = "pitsa-app";

export const generateAuthenticatorQRCode = async (secret: string, username: string): Promise<string> => {
  console.log("secret", secret);
  const otpauth = authenticator.keyuri(username, service, secret);

  try {
    const url = await qrcode.toDataURL(otpauth);
    return url;
  } catch (err) {
    console.error("Error generating QR code:", err);
    throw err;
  }
};
