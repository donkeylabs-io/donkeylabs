/**
 * Update Profile Handler - Update current user's profile
 */
export class UpdateProfileHandler {
  constructor(private ctx: any) {}

  async handle(input: { name?: string; email?: string }) {
    const user = this.ctx.user;

    if (!user) {
      throw this.ctx.errors.Unauthorized("Not authenticated");
    }

    const updated = await (this.ctx.plugins as any).auth.updateProfile(user.id, {
      name: input.name,
      email: input.email,
    });

    return updated;
  }
}
