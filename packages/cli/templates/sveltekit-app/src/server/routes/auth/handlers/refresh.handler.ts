import type { Handler, Routes, AppContext } from "$server/api";

/**
 * Refresh Handler - Get new access token using refresh token
 * Only available with refresh-token strategy
 */
export class RefreshHandler implements Handler<Routes.Auth.Refresh> {
  constructor(private ctx: AppContext) {}

  async handle(input: Routes.Auth.Refresh.Input): Promise<Routes.Auth.Refresh.Output> {
    const tokens = await this.ctx.plugins.auth.refresh(input.refreshToken);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    };
  }
}
