// LearningX (XiNICS LTI tool) access, opt-in via `openlms sync --learningx`.
//
// The session starts from documented Canvas APIs only: the course tabs list
// names the LearningX tool, and `sessionless_launch` returns a one-time
// launch URL. Posting that LTI launch form to LearningX (with no Canvas
// token or cookies) yields an `xn_api_token`, which then reads the course's
// LearningX modules. PDF originals live on the school's content server and
// are fetched without any credentials.
import type { CanvasClient } from "../canvas/client.js";

export class LearningXError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningXError";
  }
}

/** A PDF item from a course's LearningX modules. */
export interface LearningXPdf {
  itemId: number;
  module: string;
  title: string;
  fileName: string;
  viewUrl: string;
  updatedAt: string;
}

interface CanvasTab {
  id: string;
  label: string;
  hidden?: boolean;
}

interface LxMedia {
  content_type?: string;
  view_url?: string;
  file_name?: string;
  title?: string;
  updated_at?: string;
}

interface LxItem {
  module_item_id: number;
  title?: string;
  published?: boolean | null;
  content_data?: {
    published?: boolean;
    opened?: boolean;
    locked_for_user?: boolean;
    updated_at?: string;
    item_content_data?: LxMedia;
  };
}

interface LxModule {
  title?: string;
  module_items?: LxItem[];
}

interface Session {
  origin: string;
  cookies: Map<string, string>;
}

/** Tabs most likely to be the weekly-content tool are tried first. */
const PREFERRED_TAB = /주차학습|강의\s*콘텐츠|강의실|Weekly/i;
const MAX_TOOLS_TRIED = 3;
const MAX_REDIRECTS = 6;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : undefined;
}

/** Extracts the auto-submitting LTI 1.1 form from a Canvas launch page. */
export function parseLaunchForm(html: string): { action: string; fields: URLSearchParams } {
  for (const match of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const action = attr(match[0].slice(0, match[0].indexOf(">") + 1), "action");
    const fields = new URLSearchParams();
    for (const input of match[1]!.match(/<input\b[^>]*>/gi) ?? []) {
      const name = attr(input, "name");
      if (name) {
        fields.set(name, attr(input, "value") ?? "");
      }
    }
    if (action && fields.has("oauth_signature")) {
      return { action, fields };
    }
  }
  throw new LearningXError("LearningX launch form not found");
}

function isAllowedOrigin(url: URL): boolean {
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (url.protocol === "http:" && isLocal);
}

function isLocked(item: LxItem): boolean {
  const data = item.content_data ?? {};
  return item.published === false || data.published === false || data.opened === false || data.locked_for_user === true;
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

export class LearningX {
  private readonly sessions = new Map<number, Promise<Session | undefined>>();
  private lastRequestAt = 0;

  constructor(private readonly canvas: CanvasClient) {}

  /** Throttled fetch that never carries the Canvas token. */
  private async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const wait = this.lastRequestAt + this.canvas.opts.delayMs - Date.now();
    if (wait > 0) {
      await this.canvas.opts.sleep(wait);
    }
    this.lastRequestAt = Date.now();
    return this.canvas.opts.fetch(url, init);
  }

  /**
   * GETs (or POSTs) within one origin, following redirects by hand and
   * collecting cookies. Returns the final response body.
   */
  private async follow(start: string, cookies: Map<string, string>, init: RequestInit = {}, signal?: AbortSignal): Promise<string> {
    let url = new URL(start);
    const origin = url.origin;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      if (url.origin !== origin) {
        throw new LearningXError(`LearningX launch redirected to another host (${url.host})`);
      }
      const headers = new Headers(init.headers);
      if (cookies.size) {
        headers.set("cookie", cookieHeader(cookies));
      }
      const response = await this.fetch(url, { ...init, headers, redirect: "manual", signal });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        const at = pair.indexOf("=");
        if (at > 0) {
          cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
        }
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url);
        if (response.status !== 307 && response.status !== 308) {
          init = {};
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new LearningXError(`LearningX launch failed (${response.status} ${url.pathname})`);
      }
      return response.text();
    }
    throw new LearningXError("Too many redirects during LearningX launch");
  }

  private async launch(courseId: number, toolId: string, signal?: AbortSignal): Promise<Session | undefined> {
    const { url } = await this.canvas.getJson<{ url: string }>(
      `/api/v1/courses/${courseId}/external_tools/sessionless_launch`,
      { id: toolId, launch_type: "course_navigation" },
      signal,
    );
    if (new URL(url).origin !== this.canvas.base.origin) {
      throw new LearningXError("Unexpected launch URL host");
    }
    // The launch URL carries its own one-time verifier; no token is sent.
    const form = parseLaunchForm(await this.follow(url, new Map(), {}, signal));
    const action = new URL(form.action);
    if (!isAllowedOrigin(action) || !action.pathname.startsWith("/learningx/")) {
      return undefined; // Another LTI tool, not LearningX.
    }
    const cookies = new Map<string, string>();
    await this.follow(
      action.href,
      cookies,
      { method: "POST", body: form.fields.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } },
      signal,
    );
    return cookies.has("xn_api_token") ? { origin: action.origin, cookies } : undefined;
  }

  private session(courseId: number, signal?: AbortSignal): Promise<Session | undefined> {
    let pending = this.sessions.get(courseId);
    if (!pending) {
      pending = (async () => {
        const tabs = await this.canvas.getJson<CanvasTab[]>(`/api/v1/courses/${courseId}/tabs`, undefined, signal);
        const tools = tabs
          .filter((t) => t.id.startsWith("context_external_tool_") && !t.hidden)
          .sort((a, b) => Number(PREFERRED_TAB.test(b.label)) - Number(PREFERRED_TAB.test(a.label)))
          .slice(0, MAX_TOOLS_TRIED);
        for (const tool of tools) {
          const session = await this.launch(courseId, tool.id.replace("context_external_tool_", ""), signal);
          if (session) {
            return session;
          }
        }
        return undefined;
      })();
      pending.catch(() => this.sessions.delete(courseId));
      this.sessions.set(courseId, pending);
    }
    return pending;
  }

  /**
   * Lists the openable PDF items of a course's LearningX modules, or
   * `undefined` when the course has no LearningX tool.
   */
  async pdfs(courseId: number, signal?: AbortSignal): Promise<LearningXPdf[] | undefined> {
    const session = await this.session(courseId, signal);
    if (!session) {
      return undefined;
    }
    const response = await this.fetch(`${session.origin}/learningx/api/v1/courses/${courseId}/modules?include_detail=true`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${decodeURIComponent(session.cookies.get("xn_api_token")!)}`,
        cookie: cookieHeader(session.cookies),
      },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      this.sessions.delete(courseId);
      throw new LearningXError(`LearningX modules: ${response.status}`);
    }
    const modules = (await response.json()) as LxModule[];
    const out: LearningXPdf[] = [];
    for (const module of Array.isArray(modules) ? modules : []) {
      for (const item of module.module_items ?? []) {
        const media = item.content_data?.item_content_data;
        if (media?.content_type !== "pdf" || !media.view_url || isLocked(item)) {
          continue;
        }
        const title = item.title || media.title || media.file_name || `item ${item.module_item_id}`;
        out.push({
          itemId: item.module_item_id,
          module: module.title ?? "",
          title,
          fileName: media.file_name || `${title}.pdf`,
          viewUrl: media.view_url,
          updatedAt: media.updated_at ?? item.content_data?.updated_at ?? "",
        });
      }
    }
    return out;
  }

  /** Downloads a PDF original from the content server named by its viewer URL. */
  async downloadPdf(viewUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
    const viewer = new URL(viewUrl);
    const contentId = /^\/em\/([A-Za-z0-9]+)\/?$/.exec(viewer.pathname)?.[1];
    if (!isAllowedOrigin(viewer) || !contentId) {
      throw new LearningXError(`Unsupported LearningX viewer URL: ${viewUrl}`);
    }
    const meta = await this.fetch(`${viewer.origin}/viewer/ssplayer/uniplayer_support/content.php?content_id=${contentId}`, { signal });
    if (!meta.ok) {
      await meta.body?.cancel();
      throw new LearningXError(`LearningX content info: ${meta.status}`);
    }
    const uri = /<content_uri>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/.exec(await meta.text())?.[1];
    const source = uri ? new URL(uri, viewer) : undefined;
    if (!source || source.origin !== viewer.origin || source.search || !source.pathname.includes(`/${contentId}/`)) {
      throw new LearningXError("LearningX PDF location not found");
    }
    const pdf = await this.fetch(`${source.href.replace(/\/+$/, "")}/original.pdf`, { signal });
    if (!pdf.ok) {
      await pdf.body?.cancel();
      throw new LearningXError(`LearningX PDF download: ${pdf.status}`);
    }
    return new Uint8Array(await pdf.arrayBuffer());
  }
}
