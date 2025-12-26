import type { UserSession } from "../../../jwt";
import { SessionUtil, type APIClientPersistance } from "../index";
import { FakeLocalStorage } from "./fake-storage";

export class APIStorage implements APIClientPersistance {
  private SESSION_KEY = "user_session";
  private session: UserSession | null = null;

  private storage: Storage;

  constructor(storage: "local-storage" | "in-memory" = "local-storage") {
    this.storage =
      storage === "local-storage" && typeof window !== "undefined"
        ? window.localStorage
        : new FakeLocalStorage();
    this.session = this.getFromLocalStorage();
  }

  setSession(session: UserSession): void {
    this.storage.setItem(this.SESSION_KEY, JSON.stringify(session));
    this.session = session;
  }

  getSession(): UserSession | null {
    if (this.session) {
      return this.session;
    } else {
      return this.getFromLocalStorage();
    }
  }

  clearSession(): void {
    this.storage.removeItem(this.SESSION_KEY);
    this.session = null;
  }

  getFromLocalStorage(): UserSession | null {
    const session = this.storage.getItem(this.SESSION_KEY);
    if (session) {
      const sessionData = SessionUtil.getTokenData(JSON.parse(session));
      return sessionData;
    } else {
      return null;
    }
  }
}
