import { expect, test } from "bun:test";

import { describe } from "bun:test";
import type { UserSession } from "../../../jwt";
import { APIStorage } from "./api-storage";

const fakeUserSession = (expiration: Date = new Date()): UserSession => ({
  userId: 1,
  username: "test",
  accessToken: "accessToken",
  refreshToken: "refreshToken",
  accessTokenExpiration: expiration,
  permissions: [],
  employeeId: 1,
  employeeName: "Test Employee",
});

describe("InMemoryAPIClientPersistance", () => {
  test("should be able to set and get a session", () => {
    const persistance = new APIStorage();
    const session = fakeUserSession();
    persistance.setSession(session);
    expect(persistance.getSession()).toEqual(session);
  });

  test("should be able to set a session with an expiration date", () => {
    const persistance = new APIStorage();
    const session = fakeUserSession();
    persistance.setSession(session);
    expect(persistance.getSession()).toEqual(session);
  });

  test("session null", () => {
    const persistance = new APIStorage();
    expect(persistance.getSession()).toBeNull();
  });

  test("should be able to clear a session", () => {
    const persistance = new APIStorage();
    const session = fakeUserSession();
    persistance.setSession(session);
    persistance.clearSession();
    expect(persistance.getSession()).toBeNull();
  });
});
