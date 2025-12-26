import { jwtDecode } from "jwt-decode";
import type { JwtPayload } from "jsonwebtoken";
import type { RawSession, UserSession } from "../../jwt";
import type { TokenPayload } from "../../types";

export interface APIClientPersistance {
  setSession(session: UserSession): void;
  getSession(): UserSession | null;
  clearSession(): void;
}

export class SessionUtil {
  static getTokenData(rawSession: RawSession): UserSession {
    const payload = jwtDecode<JwtPayload & TokenPayload>(rawSession.accessToken);
    const expiration = new Date(payload.exp! * 1000);

    const userSession: UserSession = {
      userId: payload.userId,
      username: payload.username,
      accessToken: rawSession.accessToken,
      refreshToken: rawSession.refreshToken,
      accessTokenExpiration: expiration,
      employeeId: payload.employeeId,
      employeeName: payload.employeeName,
      permissions: payload.permissions,
    };

    return userSession;
  }
}
