/**
 * Logout Handler - Invalidate current session/token
 */
export class LogoutHandler {
  constructor(private ctx: any) {}

  async handle(_input: Record<string, never>) {
    const token = this.ctx.token;

    if (token) {
      await (this.ctx.plugins as any).auth.logout(token);
    }

    return { success: true };
  }
}
