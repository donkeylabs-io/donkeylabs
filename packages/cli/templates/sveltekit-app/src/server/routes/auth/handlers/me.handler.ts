/**
 * Me Handler - Get current authenticated user
 */
export class MeHandler {
  constructor(private ctx: any) {}

  async handle(_input: Record<string, never>) {
    const user = this.ctx.user;

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
