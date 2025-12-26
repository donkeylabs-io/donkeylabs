import { jwtDecode } from "jwt-decode";
import type { JwtPayload } from "jwt-decode";
import type { TokenPayload } from "../types";
export type UserSession = {
  userId: number;
  username: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiration: Date;
  permissions: string[];
  employeeId: number;
  employeeName: string;
};

export type RawSession = {
  accessToken: string;
  refreshToken: string;
};

export const getTokenData = (rawSession: RawSession) => {
  const payload = jwtDecode<JwtPayload & TokenPayload>(rawSession.accessToken);
  const expiration = new Date(payload.exp! * 1000);

  const userSession: UserSession = {
    userId: payload.userId,
    employeeId: payload.employeeId,
    employeeName: payload.employeeName,
    username: payload.username,
    accessToken: rawSession.accessToken,
    refreshToken: rawSession.refreshToken,
    accessTokenExpiration: expiration,
    permissions: payload.permissions,
  };

  return userSession;
};
