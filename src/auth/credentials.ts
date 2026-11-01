// Credentials live only in the OS keychain (macOS Keychain, Windows
// Credential Manager, Linux Secret Service). Nothing is written to disk.
import { Entry } from "@napi-rs/keyring";

const SERVICE = "lms-mcp";
const BASE_URL_KEY = "base_url";
const TOKEN_KEY = "token";

export interface Credentials {
  baseUrl: string;
  token: string;
}

export class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in. Run `lms login` first.");
    this.name = "NotLoggedInError";
  }
}

export interface CredentialStore {
  save(credentials: Credentials): Promise<void>;
  load(): Promise<Credentials>;
  clear(): Promise<void>;
}

export class KeychainCredentialStore implements CredentialStore {
  async save(credentials: Credentials): Promise<void> {
    await new Entry(SERVICE, BASE_URL_KEY).setPassword(credentials.baseUrl);
    await new Entry(SERVICE, TOKEN_KEY).setPassword(credentials.token);
  }

  /**
   * LMS_BASE_URL + LMS_TOKEN environment variables take precedence, for
   * headless machines without a keychain daemon.
   */
  async load(): Promise<Credentials> {
    const envBase = process.env.LMS_BASE_URL;
    const envToken = process.env.LMS_TOKEN;
    if (envBase && envToken) {
      return { baseUrl: envBase, token: envToken };
    }
    const baseUrl = await new Entry(SERVICE, BASE_URL_KEY).getPassword();
    const token = await new Entry(SERVICE, TOKEN_KEY).getPassword();
    if (!baseUrl || !token) {
      throw new NotLoggedInError();
    }
    return { baseUrl, token };
  }

  async clear(): Promise<void> {
    await new Entry(SERVICE, BASE_URL_KEY).deletePassword();
    await new Entry(SERVICE, TOKEN_KEY).deletePassword();
  }
}
