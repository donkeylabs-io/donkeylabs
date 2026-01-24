import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Login Handler - Authenticate user and create session/token
 */
export class LoginHandler implements Handler<Routes.Auth.Login> {
  constructor(private ctx: AppContext) {}

  async handle(input: Routes.Auth.Login.Input): Promise<Routes.Auth.Login.Output> {
    const result = await this.ctx.plugins.auth.login({
      email: input.email,
      password: input.password,
    });

    return {
      user: result.user,
      tokens: result.tokens,
    };
  }
}
