/**
 * Refresh Handler - Get new access token using refresh token
 * Only available with refresh-token strategy
 */
export class RefreshHandler {
  constructor(private ctx: any) {}

  async handle(input: { refreshToken: string }) {
    const tokens = await (this.ctx.plugins as any).auth.refresh(input.refreshToken);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    };
  }
}
