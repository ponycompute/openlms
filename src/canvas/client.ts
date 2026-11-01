// Minimal read-only Canvas LMS REST client: polite request spacing,
// Link-header pagination, exponential backoff, and a token that never
// leaves the LMS host.

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly code: "unauthorized" | "forbidden" | "not_found" | "rate_limit_low" | "blocked" | "http",
    readonly status?: number,
  ) {
    super(message);
    this.name = "CanvasError";
  }
}

export interface ClientOptions {
  /** Minimum spacing between consecutive requests (ms). */
  delayMs: number;
  /** Abort when X-Rate-Limit-Remaining drops below this. */
  minRemaining: number;
  /** Retries for 429 / 5xx / rate-limited 403 / network errors. */
  maxRetries: number;
  /** Enable grade/submission endpoints (off by default). */
  allowGrades: boolean;
  /** Injected fetch (tests). */
  fetch: typeof fetch;
  /** Injected sleep (tests). */
  sleep: (ms: number) => Promise<void>;
}

export const defaultClientOptions: ClientOptions = {
  delayMs: 300,
  minRemaining: 100,
  maxRetries: 4,
  allowGrades: false,
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const BLOCKED_PATH = /\/(submissions|grades|gradebook|outcome_results|enrollments\/[^/]+\/grades)(\/|$|\?)/i;
const USER_AGENT = "OpenLMS/0.1 (+local student tool)";

export function normalizeBaseUrl(raw: string): URL {
  let value = raw.trim();
  if (!value) {
    throw new Error("Base URL is empty");
  }
  if (!value.includes("://")) {
    value = `https://${value}`;
  }
  const url = new URL(value);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocal) {
    throw new Error("Base URL must use https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

export function nextLink(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (match && match[2] === "next") {
      return match[1];
    }
  }
  return undefined;
}

export class CanvasClient {
  readonly base: URL;
  private readonly opts: ClientOptions;
  private lastRequestAt = 0;

  constructor(
    baseUrl: string,
    private readonly token: string,
    opts: Partial<ClientOptions> = {},
  ) {
    if (!token.trim()) {
      throw new Error("Token is empty");
    }
    this.base = normalizeBaseUrl(baseUrl);
    this.opts = { ...defaultClientOptions, ...opts };
  }

  private isLmsHost(url: URL): boolean {
    return url.host.toLowerCase() === this.base.host.toLowerCase();
  }

  resolve(pathOrUrl: string, query?: Record<string, string | string[] | undefined>): URL {
    let url: URL;
    if (/^https?:\/\//.test(pathOrUrl)) {
      url = new URL(pathOrUrl);
      if (!this.isLmsHost(url)) {
        throw new CanvasError(`Refusing to send token to foreign host ${url.host}`, "blocked");
      }
    } else {
      url = new URL(this.base.toString());
      url.pathname = this.base.pathname.replace(/\/+$/, "") + pathOrUrl;
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) {
        continue;
      }
      for (const v of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, v);
      }
    }
    return url;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.opts.delayMs - Date.now();
    if (wait > 0) {
      await this.opts.sleep(wait);
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * GET with retries. Redirects are followed manually so the Authorization
   * header is only ever attached to requests on the LMS host (file downloads
   * typically redirect to a signed CDN/S3 URL).
   */
  async get(url: URL, signal?: AbortSignal): Promise<Response> {
    if (!this.opts.allowGrades && BLOCKED_PATH.test(url.pathname)) {
      throw new CanvasError("Grades/submissions endpoints are disabled by policy", "blocked");
    }
    let backoff = 1000;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let response: Response | undefined;
      let retryable = false;
      let failure: unknown;
      try {
        response = await this.fetchFollowingRedirects(url, signal);
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        failure = err;
        retryable = true;
      }

      if (response) {
        const remaining = response.headers.get("x-rate-limit-remaining");
        if (remaining !== null && Number(remaining) < this.opts.minRemaining) {
          await response.body?.cancel();
          throw new CanvasError(
            `Rate-limit budget nearly exhausted (remaining=${remaining}); stopping to protect the LMS. Try again later.`,
            "rate_limit_low",
          );
        }
        const status = response.status;
        if (status >= 200 && status < 300) {
          return response;
        }
        if (status === 401) {
          await response.body?.cancel();
          throw new CanvasError("Unauthorized (401): token invalid or expired. Run `lms login`.", "unauthorized", 401);
        }
        if (status === 404) {
          await response.body?.cancel();
          throw new CanvasError(`Not found (404): ${url.pathname}`, "not_found", 404);
        }
        if (status === 403) {
          const body = (await response.text()).slice(0, 4096);
          if (!/rate limit/i.test(body)) {
            throw new CanvasError(`Forbidden (403): ${url.pathname}`, "forbidden", 403);
          }
          retryable = true;
        } else if (status === 429 || status >= 500) {
          await response.body?.cancel();
          retryable = true;
        } else {
          const body = (await response.text()).slice(0, 2048);
          throw new CanvasError(`GET ${url.pathname}: ${status} ${body.trim()}`, "http", status);
        }
      }

      if (!retryable || attempt >= this.opts.maxRetries) {
        const reason = failure instanceof Error ? failure.message : `status ${response?.status}`;
        throw new CanvasError(`GET ${url.pathname}: giving up after ${attempt} retries (${reason})`, "http");
      }
      await this.opts.sleep(backoff);
      backoff *= 2;
    }
  }

  private async fetchFollowingRedirects(start: URL, signal?: AbortSignal): Promise<Response> {
    let url = start;
    for (let hop = 0; hop < 10; hop++) {
      const headers: Record<string, string> = {
        accept: "application/json",
        "user-agent": USER_AGENT,
      };
      if (this.isLmsHost(url) && url.protocol === this.base.protocol) {
        headers.authorization = `Bearer ${this.token}`;
      }
      const response = await this.opts.fetch(url, { headers, redirect: "manual", signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      return response;
    }
    throw new Error("Too many redirects");
  }

  async getJson<T>(path: string, query?: Record<string, string | string[] | undefined>, signal?: AbortSignal): Promise<T> {
    const response = await this.get(this.resolve(path, query), signal);
    return (await response.json()) as T;
  }

  /** Follows Link rel="next" until exhausted, with per_page=100. */
  async getAll<T>(path: string, query: Record<string, string | string[] | undefined> = {}, signal?: AbortSignal): Promise<T[]> {
    let url: URL | undefined = this.resolve(path, { per_page: "100", ...query });
    const all: T[] = [];
    for (let page = 0; url; page++) {
      if (page > 500) {
        throw new Error("Pagination runaway (>500 pages)");
      }
      const response = await this.get(url, signal);
      const batch = (await response.json()) as T[];
      all.push(...batch);
      const next = nextLink(response.headers.get("link"));
      url = next ? this.resolve(next) : undefined;
    }
    return all;
  }

  async download(fileUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.get(this.resolve(fileUrl), signal);
    return new Uint8Array(await response.arrayBuffer());
  }
}
