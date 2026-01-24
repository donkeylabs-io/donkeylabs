import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Register Handler - Create a new user account
 */
export class RegisterHandler implements Handler<Routes.Auth.Register> {
  constructor(private ctx: AppContext) {}

  async handle(input: Routes.Auth.Register.Input): Promise<Routes.Auth.Register.Output> {
    const result = await this.ctx.plugins.auth.register({
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
