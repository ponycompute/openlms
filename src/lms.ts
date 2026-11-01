// The Lms service ties the local cache to the Canvas API. Every read is
// cache-first; the API is contacted only when the cache has nothing yet
// (or on an explicit refresh / sync).
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CanvasApi, type CanvasAnnouncement, type CanvasAssignment, type CanvasCourse, type CanvasFile } from "./canvas/api.js";
import { CanvasClient, CanvasError, type ClientOptions } from "./canvas/client.js";
import { KeychainCredentialStore, type CredentialStore } from "./auth/credentials.js";
import { extractKind, extractText, htmlToText, isEffectivelyEmpty } from "./extract/extract.js";
import { dbPath, lmsHome, localFilePath } from "./paths.js";
import {
  Store,
  type Announcement,
  type Assignment,
  type AssignmentFilter,
  type Course,
  type FileRow,
  type TextStatus,
} from "./store/store.js";

export interface LmsOptions {
  home?: string;
  credentials?: CredentialStore;
  client?: Partial<ClientOptions>;
  /** Skip downloading files larger than this (bytes). */
  maxFileBytes?: number;
  /** How far back to fetch announcements on sync. */
  announcementDays?: number;
}

export interface SyncOptions {
  courseId?: number;
  /** Fetch file metadata only, no downloads. */
  metadataOnly?: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface SyncReport {
  courses: number;
  filesTotal: number;
  downloaded: number;
  skipped: number;
  indexed: number;
  removed: number;
  assignments: number;
  announcements: number;
  errors: string[];
}

export interface MaterialText {
  file: FileRow;
  text: string;
  totalChars: number;
  offset: number;
  truncated: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

function toCourse(c: CanvasCourse): Course {
  return { id: c.id, name: c.name ?? `Course ${c.id}`, code: c.course_code ?? "", term: c.term?.name ?? "" };
}

function toAssignment(a: CanvasAssignment): Assignment {
  return {
    id: a.id,
    courseId: a.course_id,
    name: a.name,
    description: htmlToText(a.description),
    dueAt: a.due_at,
    points: a.points_possible ?? 0,
    htmlUrl: a.html_url,
  };
}

function toAnnouncement(a: CanvasAnnouncement): Announcement {
  return {
    id: a.id,
    courseId: Number(a.context_code.replace(/^course_/, "")),
    title: a.title,
    message: htmlToText(a.message),
    postedAt: a.posted_at,
    htmlUrl: a.html_url,
    author: a.author?.display_name ?? a.user_name ?? "",
  };
}

/** A fatal error stops the whole sync instead of moving to the next course. */
function isFatal(err: unknown): boolean {
  return err instanceof CanvasError && (err.code === "unauthorized" || err.code === "rate_limit_low");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Lms {
  readonly home: string;
  readonly store: Store;
  private readonly credentials: CredentialStore;
  private readonly clientOptions: Partial<ClientOptions>;
  private readonly maxFileBytes: number;
  private readonly announcementDays: number;
  private apiPromise?: Promise<CanvasApi>;

  constructor(opts: LmsOptions = {}) {
    this.home = opts.home ?? lmsHome();
    this.store = new Store(dbPath(this.home));
    this.credentials = opts.credentials ?? new KeychainCredentialStore();
    this.clientOptions = opts.client ?? {};
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.announcementDays = opts.announcementDays ?? 180;
  }

  close(): void {
    this.store.close();
  }

  /** Lazily builds the API client so cache-only reads never need credentials. */
  api(): Promise<CanvasApi> {
    this.apiPromise ??= this.credentials.load().then(
      ({ baseUrl, token }) => new CanvasApi(new CanvasClient(baseUrl, token, this.clientOptions)),
    );
    this.apiPromise.catch(() => {
      this.apiPromise = undefined;
    });
    return this.apiPromise;
  }

  // ---- cache-first reads ----

  async courses(opts: { refresh?: boolean } = {}): Promise<Course[]> {
    let courses = this.store.courses();
    if (courses.length === 0 || opts.refresh) {
      courses = await this.refreshCourses();
    }
    return courses;
  }

  async materials(courseId: number, opts: { refresh?: boolean } = {}): Promise<FileRow[]> {
    if (opts.refresh || !this.store.meta(`files_synced:${courseId}`)) {
      await this.refreshFileList(courseId);
    }
    return this.store.files(courseId);
  }

  async assignments(filter: AssignmentFilter = {}, opts: { refresh?: boolean } = {}): Promise<Assignment[]> {
    const courseIds = filter.courseId ? [filter.courseId] : (await this.courses()).map((c) => c.id);
    const api = () => this.api();
    for (const id of courseIds) {
      if (opts.refresh || !this.store.meta(`assignments_synced:${id}`)) {
        const list = await (await api()).assignments(id);
        this.store.replaceAssignments(id, list.map(toAssignment));
        this.store.setMeta(`assignments_synced:${id}`, new Date().toISOString());
      }
    }
    return this.store.assignments(filter);
  }

  async announcements(opts: { courseId?: number; limit?: number; refresh?: boolean } = {}): Promise<Announcement[]> {
    if (opts.refresh || !this.store.meta("announcements_synced")) {
      await this.refreshAnnouncements((await this.courses()).map((c) => c.id));
    }
    return this.store.announcements(opts);
  }

  /**
   * Returns extracted text for a file, downloading and extracting on demand
   * when it is not cached yet. `offset`/`maxChars` page through long texts.
   */
  async readMaterial(fileId: number, opts: { offset?: number; maxChars?: number } = {}): Promise<MaterialText> {
    let file = this.store.file(fileId);
    let text = this.store.text(fileId);
    if (!file || file.textStatus === "" || (text === undefined && file.textStatus === "error")) {
      const api = await this.api();
      const meta = await api.file(fileId);
      const courseId = file?.courseId ?? 0;
      file = await this.fetchAndIndex(meta, courseId);
      text = this.store.text(fileId);
    }
    if (!file) {
      throw new Error(`File ${fileId} not found`);
    }
    if (text === undefined) {
      throw new Error(`No text available for "${file.name}" (status: ${file.textStatus || "pending"})`);
    }
    const offset = Math.max(0, opts.offset ?? 0);
    const maxChars = opts.maxChars ?? 20_000;
    const slice = text.slice(offset, offset + maxChars);
    return { file, text: slice, totalChars: text.length, offset, truncated: offset + slice.length < text.length };
  }

  search(query: string, opts: { courseId?: number; limit?: number } = {}) {
    return this.store.search(query, opts);
  }

  // ---- API refreshes ----

  async refreshCourses(): Promise<Course[]> {
    const courses = (await (await this.api()).activeCourses()).map(toCourse);
    this.store.replaceCourses(courses);
    return this.store.courses();
  }

  private async refreshFileList(courseId: number, signal?: AbortSignal): Promise<CanvasFile[]> {
    const files = await (await this.api()).courseFiles(courseId, signal);
    for (const f of files) {
      const existing = this.store.file(f.id);
      const changed = !existing || existing.updatedAt !== (f.updated_at ?? "") || existing.size !== f.size;
      this.store.upsertFile({
        id: f.id,
        courseId,
        name: f.display_name,
        contentType: f["content-type"],
        size: f.size,
        updatedAt: f.updated_at ?? "",
        localPath: existing?.localPath ?? "",
        // A changed file goes back to pending so readers fetch the new version.
        textStatus: changed ? "" : existing.textStatus,
      });
    }
    for (const path of this.store.pruneFiles(courseId, new Set(files.map((f) => f.id)))) {
      await rm(path, { force: true });
    }
    this.store.setMeta(`files_synced:${courseId}`, new Date().toISOString());
    return files;
  }

  private async refreshAnnouncements(courseIds: number[], signal?: AbortSignal): Promise<number> {
    const since = new Date(Date.now() - this.announcementDays * 86_400_000);
    const list = await (await this.api()).announcements(courseIds, since, signal);
    this.store.upsertAnnouncements(list.map(toAnnouncement));
    this.store.setMeta("announcements_synced", new Date().toISOString());
    return list.length;
  }

  /** Downloads one file, extracts and indexes its text, and records it. */
  private async fetchAndIndex(f: CanvasFile, courseIdHint: number, signal?: AbortSignal): Promise<FileRow> {
    const api = await this.api();
    const courseId = courseIdHint || this.store.file(f.id)?.courseId || 0;
    const row: FileRow = {
      id: f.id,
      courseId,
      name: f.display_name,
      contentType: f["content-type"],
      size: f.size,
      updatedAt: f.updated_at ?? "",
      localPath: "",
      textStatus: "",
    };
    if (f.size > this.maxFileBytes) {
      row.textStatus = "too_large";
      this.store.upsertFile(row);
      return row;
    }
    const data = await api.client.download(f.url, signal);
    row.localPath = localFilePath(this.home, courseId, f.id, f.display_name);
    await mkdir(dirname(row.localPath), { recursive: true, mode: 0o700 });
    await writeFile(row.localPath, data, { mode: 0o600 });

    const kind = extractKind(f.display_name, f["content-type"]);
    let status: TextStatus = "unsupported";
    if (kind) {
      try {
        const text = await extractText(kind, data);
        status = isEffectivelyEmpty(text) ? "empty" : "ok";
        this.store.setText(f.id, courseId, f.display_name, text);
      } catch {
        status = "error";
      }
    } else {
      // Still index the name so the file is findable by title.
      this.store.setText(f.id, courseId, f.display_name, "");
    }
    row.textStatus = status;
    this.store.upsertFile(row);
    return row;
  }

  /** Full incremental sync of active courses into ~/.lms. */
  async sync(opts: SyncOptions = {}): Promise<SyncReport> {
    const log = opts.onProgress ?? (() => {});
    const report: SyncReport = {
      courses: 0,
      filesTotal: 0,
      downloaded: 0,
      skipped: 0,
      indexed: 0,
      removed: 0,
      assignments: 0,
      announcements: 0,
      errors: [],
    };
    log("Fetching active courses…");
    let courses = await this.refreshCourses();
    if (opts.courseId) {
      courses = courses.filter((c) => c.id === opts.courseId);
      if (courses.length === 0) {
        throw new Error(`Course ${opts.courseId} is not an active course`);
      }
    }
    report.courses = courses.length;

    for (const course of courses) {
      if (opts.signal?.aborted) {
        break;
      }
      log(`[${course.name}] listing files…`);
      try {
        const before = new Set(this.store.files(course.id).map((f) => f.id));
        const previous = new Map(this.store.files(course.id).map((f) => [f.id, f]));
        const files = await this.refreshFileList(course.id, opts.signal);
        report.removed += [...before].filter((id) => !files.some((f) => f.id === id)).length;
        report.filesTotal += files.length;
        if (!opts.metadataOnly) {
          for (const f of files) {
            const prev = previous.get(f.id);
            const unchanged =
              prev &&
              prev.updatedAt === (f.updated_at ?? "") &&
              prev.size === f.size &&
              prev.textStatus !== "" &&
              prev.textStatus !== "error" &&
              (prev.textStatus === "too_large" || (prev.localPath !== "" && existsSync(prev.localPath)));
            if (unchanged) {
              report.skipped++;
              continue;
            }
            log(`[${course.name}] ↓ ${f.display_name}`);
            try {
              const row = await this.fetchAndIndex(f, course.id, opts.signal);
              if (row.localPath) {
                report.downloaded++;
              }
              if (row.textStatus === "ok") {
                report.indexed++;
              }
            } catch (err) {
              if (isFatal(err)) {
                throw err;
              }
              report.errors.push(`${course.name} / ${f.display_name}: ${message(err)}`);
            }
          }
        }
        log(`[${course.name}] assignments…`);
        const assignments = (await (await this.api()).assignments(course.id, opts.signal)).map(toAssignment);
        this.store.replaceAssignments(course.id, assignments);
        this.store.setMeta(`assignments_synced:${course.id}`, new Date().toISOString());
        report.assignments += assignments.length;
      } catch (err) {
        if (isFatal(err)) {
          report.errors.push(message(err));
          return report;
        }
        report.errors.push(`${course.name}: ${message(err)}`);
      }
    }

    log("Fetching announcements…");
    try {
      report.announcements = await this.refreshAnnouncements(courses.map((c) => c.id), opts.signal);
    } catch (err) {
      report.errors.push(`announcements: ${message(err)}`);
    }
    this.store.setMeta("last_sync", new Date().toISOString());
    return report;
  }
}
