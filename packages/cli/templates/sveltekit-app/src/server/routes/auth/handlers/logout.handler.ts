import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Logout Handler - Invalidate current session/token
 */
export class LogoutHandler implements Handler<Routes.Auth.Logout> {
  constructor(private ctx: AppContext) {}

  async handle(_input: Routes.Auth.Logout.Input): Promise<Routes.Auth.Logout.Output> {
    // Get token from request context (set by auth middleware)
    const token = (this.ctx as any).token;

    if (token) {
      await this.ctx.plugins.auth.logout(token);
    }

    return { success: true };
  }
}
