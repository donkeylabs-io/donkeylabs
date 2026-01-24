import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Me Handler - Get current authenticated user
 */
export class MeHandler implements Handler<Routes.Auth.Me> {
  constructor(private ctx: AppContext) {}

  async handle(_input: Routes.Auth.Me.Input): Promise<Routes.Auth.Me.Output> {
    // Get user from request context (set by auth middleware)
    const user = (this.ctx as any).user;

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
    };
  }
}
