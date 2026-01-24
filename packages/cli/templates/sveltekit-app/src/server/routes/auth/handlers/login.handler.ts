/**
 * Login Handler - Authenticate user and create session/token
 */
export class LoginHandler {
  constructor(private ctx: any) {}

  async handle(input: { email: string; password: string }) {
    const result = await (this.ctx.plugins as any).auth.login({
      email: input.email,
      password: input.password,
    });

    return {
      user: result.user,
      tokens: result.tokens,
    };
  }
}
