import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Update Profile Handler - Update current user's profile
 */
export class UpdateProfileHandler implements Handler<Routes.Auth.UpdateProfile> {
  constructor(private ctx: AppContext) {}

  async handle(input: Routes.Auth.UpdateProfile.Input): Promise<Routes.Auth.UpdateProfile.Output> {
    // Get user from request context (set by auth middleware)
    const user = (this.ctx as any).user;

    if (!user) {
      throw this.ctx.errors.Unauthorized("Not authenticated");
    }

    const updated = await this.ctx.plugins.auth.updateProfile(user.id, {
      name: input.name,
      email: input.email,
    });

    return updated;
  }
}
