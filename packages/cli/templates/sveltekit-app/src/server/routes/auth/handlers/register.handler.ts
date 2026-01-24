/**
 * Register Handler - Create a new user account
 */
export class RegisterHandler {
  constructor(private ctx: any) {}

  async handle(input: { email: string; password: string; name: string }) {
    const result = await (this.ctx.plugins as any).auth.register({
      email: input.email,
      password: input.password,
      name: input.name,
    });

    return {
      user: result.user,
      tokens: result.tokens,
    };
  }
}
