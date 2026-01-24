import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Logout Handler - Invalidate current session
 */
export class LogoutHandler implements Handler<Routes.Auth.Logout> {
  constructor(private ctx: AppContext) {}

  async handle(_input: Routes.Auth.Logout.Input): Promise<Routes.Auth.Logout.Output> {
    // Get session ID from request context (set by auth middleware)
    const sessionId = (this.ctx as any).sessionId;

    if (sessionId) {
      await this.ctx.plugins.auth.logout(sessionId);
    }

    return { success: true };
  }
}
