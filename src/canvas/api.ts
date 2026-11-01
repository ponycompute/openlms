import { CanvasClient, CanvasError } from "./client.js";

export interface CanvasUser {
  id: number;
  name: string;
  short_name?: string;
  login_id?: string;
}

export interface CanvasCourse {
  id: number;
  name?: string;
  course_code?: string;
  term?: { id: number; name: string } | null;
  access_restricted_by_date?: boolean;
}

export interface CanvasFile {
  id: number;
  display_name: string;
  filename: string;
  "content-type": string;
  size: number;
  url: string;
  updated_at: string | null;
  modified_at?: string | null;
  locked_for_user?: boolean;
  hidden_for_user?: boolean;
}

export interface CanvasAssignment {
  id: number;
  course_id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  points_possible: number | null;
  html_url: string;
}

export interface CanvasAnnouncement {
  id: number;
  title: string;
  message: string | null;
  posted_at: string | null;
  html_url: string;
  context_code: string;
  user_name?: string;
  author?: { display_name?: string };
}

interface CanvasModule {
  id: number;
  name: string;
  items?: { id: number; title: string; type: string; content_id?: number; html_url?: string }[];
}

/** A module item that opens an external tool (LearningX content at most Korean schools). */
export interface CanvasToolLink {
  id: number;
  module: string;
  title: string;
  htmlUrl: string;
}

export interface CourseMaterials {
  files: CanvasFile[];
  links: CanvasToolLink[];
}

function isHiddenError(err: unknown): boolean {
  return err instanceof CanvasError && (err.code === "forbidden" || err.code === "not_found");
}

/**
 * Keeps files the student can download. `hidden_for_user` only means "not
 * listed in the Files browser" (link-only access) and still comes with a
 * working URL, so it is not a reason to skip a file.
 */
function visible(files: CanvasFile[]): CanvasFile[] {
  return files.filter((f) => !f.locked_for_user && Boolean(f.url));
}

export class CanvasApi {
  constructor(readonly client: CanvasClient) {}

  self(signal?: AbortSignal): Promise<CanvasUser> {
    return this.client.getJson<CanvasUser>("/api/v1/users/self", undefined, signal);
  }

  /** The school's theme colors (public brand config). */
  brandVariables(signal?: AbortSignal): Promise<Record<string, string>> {
    return this.client.getJson<Record<string, string>>("/api/v1/brand_variables", undefined, signal);
  }

  /** Dashboard card colors the student picked, keyed like "course_123". */
  async customColors(signal?: AbortSignal): Promise<Record<string, string>> {
    const res = await this.client.getJson<{ custom_colors?: Record<string, string> }>("/api/v1/users/self/colors", undefined, signal);
    return res.custom_colors ?? {};
  }

  async activeCourses(signal?: AbortSignal): Promise<CanvasCourse[]> {
    const courses = await this.client.getAll<CanvasCourse>(
      "/api/v1/courses",
      { enrollment_state: "active", "include[]": "term" },
      signal,
    );
    // Date-restricted courses come back as stubs without a name.
    return courses.filter((c) => !c.access_restricted_by_date && Boolean(c.name));
  }

  /**
   * Lists course files plus external-tool module items. Many LearningX
   * courses hide the Files tab from students; then File items are collected
   * from modules instead. External-tool items (LearningX content) cannot be
   * downloaded with a Canvas token, so they are returned as links.
   */
  async courseMaterials(courseId: number, signal?: AbortSignal): Promise<CourseMaterials> {
    const modules = await this.modules(courseId, signal);
    const links = modules.flatMap((m) =>
      (m.items ?? [])
        .filter((it) => it.type === "ExternalTool" && it.html_url)
        .map((it) => ({ id: it.id, module: m.name, title: it.title, htmlUrl: it.html_url! })),
    );
    try {
      const files = await this.client.getAll<CanvasFile>(`/api/v1/courses/${courseId}/files`, { sort: "updated_at" }, signal);
      return { files: visible(files), links };
    } catch (err) {
      if (!isHiddenError(err)) {
        throw err;
      }
    }
    return { files: await this.moduleFiles(courseId, modules, signal), links };
  }

  private async modules(courseId: number, signal?: AbortSignal): Promise<CanvasModule[]> {
    try {
      return await this.client.getAll<CanvasModule>(`/api/v1/courses/${courseId}/modules`, { "include[]": "items" }, signal);
    } catch (err) {
      if (isHiddenError(err)) {
        return [];
      }
      throw err;
    }
  }

  private async moduleFiles(courseId: number, modules: CanvasModule[], signal?: AbortSignal): Promise<CanvasFile[]> {
    const seen = new Set<number>();
    const files: CanvasFile[] = [];
    for (const module of modules) {
      for (const item of module.items ?? []) {
        if (item.type !== "File" || !item.content_id || seen.has(item.content_id)) {
          continue;
        }
        seen.add(item.content_id);
        try {
          files.push(await this.client.getJson<CanvasFile>(`/api/v1/courses/${courseId}/files/${item.content_id}`, undefined, signal));
        } catch (err) {
          if (!isHiddenError(err)) {
            throw err;
          }
        }
      }
    }
    return visible(files);
  }

  async assignments(courseId: number, signal?: AbortSignal): Promise<CanvasAssignment[]> {
    try {
      return await this.client.getAll<CanvasAssignment>(`/api/v1/courses/${courseId}/assignments`, { order_by: "due_at" }, signal);
    } catch (err) {
      if (isHiddenError(err)) {
        return [];
      }
      throw err;
    }
  }

  async announcements(courseIds: number[], since: Date, signal?: AbortSignal): Promise<CanvasAnnouncement[]> {
    if (courseIds.length === 0) {
      return [];
    }
    const tomorrow = new Date(Date.now() + 86_400_000);
    return this.client.getAll<CanvasAnnouncement>(
      "/api/v1/announcements",
      {
        "context_codes[]": courseIds.map((id) => `course_${id}`),
        start_date: since.toISOString().slice(0, 10),
        end_date: tomorrow.toISOString().slice(0, 10),
      },
      signal,
    );
  }

  /** Fresh metadata, including a fresh download URL. */
  file(fileId: number, signal?: AbortSignal): Promise<CanvasFile> {
    return this.client.getJson<CanvasFile>(`/api/v1/files/${fileId}`, undefined, signal);
  }
}
