import { jwtDecode, type JwtPayload } from "jwt-decode";
import { type RawSession, type TokenPayload, type UserSession } from "@donkeylabs/core";

const SESSION_KEY = "user_session";

export class Session {
  static getFromLocalStorage(): UserSession | null {
    const session = localStorage.getItem(SESSION_KEY);
    if (session) {
      const sessionData = this.loadSession(JSON.parse(session));
      return sessionData;
    } else {
      return null;
    }
  }

  private static loadSession(session: RawSession) {
    const payload = jwtDecode<JwtPayload & TokenPayload>(session.accessToken);
    const expiration = new Date((payload.exp ?? 0) * 1000);

    const userSession: UserSession = {
      userId: payload.userId,
      username: payload.username,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessTokenExpiration: expiration,
      permissions: payload.permissions,
      employeeId: payload.employeeId,
      employeeName: payload.employeeName,
    };

    this.saveToLocalStorage(userSession);
    return userSession;
  }

  public static saveToLocalStorage(session: UserSession) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session as RawSession));
  }

  public static saveRawSessionToLocalStorage(session: RawSession) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session as RawSession));
  }

  public static clearFromLocalStorage() {
    localStorage.removeItem(SESSION_KEY);
  }
}

export const getTokenData = (rawSession: RawSession) => {
  const payload = jwtDecode<JwtPayload & TokenPayload>(rawSession.accessToken);
  const expiration = new Date(payload.exp! * 1000);

  const userSession: UserSession = {
    userId: payload.userId,
    username: payload.username,
    accessToken: rawSession.accessToken,
    refreshToken: rawSession.refreshToken,
    accessTokenExpiration: expiration,
    permissions: payload.permissions,
    employeeId: payload.employeeId,
    employeeName: payload.employeeName,
  };

  return userSession;
};
