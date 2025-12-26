declare module "@otplib/preset-browser" {
  export const authenticator: {
    keyuri(user: string, service: string, secret: string): string;
    generate(secret: string): string;
    generateSecret(): string;
    check(token: string, secret: string): boolean;
  };
}
