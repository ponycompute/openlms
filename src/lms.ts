// The Lms service ties the local cache to the Canvas API. Every read is
// cache-first; the API is contacted only when the cache has nothing yet
// (or on an explicit refresh / sync).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CanvasApi, type CanvasAnnouncement, type CanvasAssignment, type CanvasCourse, type CanvasFile } from "./canvas/api.js";
import { CanvasClient, CanvasError, type ClientOptions } from "./canvas/client.js";
import { KeychainCredentialStore, type CredentialStore } from "./auth/credentials.js";
import { LearningX, type LearningXPdf } from "./learningx/learningx.js";
import { extractKind, extractText, htmlToText, isEffectivelyEmpty } from "./extract/extract.js";
import { dbPath, lmsHome, localFilePath } from "./paths.js";
import {
  Store,
  type Announcement,
  type Assignment,
  type AssignmentFilter,
  type Course,
  type FileRow,
  type Link,
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
  /** Also mirror LearningX PDFs (opt-in). */
  learningx?: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface SyncReport {
  courses: number;
  filesTotal: number;
  /** LearningX PDFs found (included in filesTotal). */
  learningx: number;
  downloaded: number;
  skipped: number;
  indexed: number;
  removed: number;
  assignments: number;
  announcements: number;
  errors: string[];
}

export interface ImportReport {
  imported: FileRow[];
  unchanged: string[];
  skipped: { path: string; reason: string }[];
}

/** Colors that make the TUI look like the school's Canvas. */
export interface Theme {
  /** Global navigation background (school brand color). */
  brand: string;
  /** Dashboard card color per course ID, when the student picked one. */
  courseColors: Record<number, string>;
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

/**
 * Imported files get a stable negative ID derived from course + absolute
 * path, so they never collide with Canvas file IDs (always positive) and a
 * re-import of the same path updates the same row.
 */
export function importedFileId(courseId: number, absolutePath: string): number {
  const digest = createHash("sha1").update(`${courseId}\0${absolutePath}`).digest();
  return -(digest.readUInt32BE(0) || 1);
}

/**
 * LearningX files get IDs below every imported-file ID (which stay within
 * -(2^32 - 1)..-1), derived from the LearningX module item ID.
 */
export function learningxFileId(itemId: number): number {
  return -(2 ** 32 + itemId);
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
  private learningxClient?: LearningX;

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

  private async learningx(): Promise<LearningX> {
    this.learningxClient ??= new LearningX((await this.api()).client);
    return this.learningxClient;
  }

  // ---- cache-first reads ----

  /** Theme colors, fetched once and cached; falls back to Canvas defaults. */
  async theme(opts: { refresh?: boolean } = {}): Promise<Theme> {
    const cached = this.store.meta("theme");
    if (cached && !opts.refresh) {
      return JSON.parse(cached) as Theme;
    }
    const theme: Theme = { brand: "#394B58", courseColors: {} };
    try {
      const api = await this.api();
      const [brand, colors] = await Promise.all([api.brandVariables(), api.customColors()]);
      theme.brand = brand["ic-brand-global-nav-bgd"] || theme.brand;
      for (const [key, color] of Object.entries(colors)) {
        const id = /^course_(\d+)$/.exec(key)?.[1];
        if (id) {
          theme.courseColors[Number(id)] = color;
        }
      }
      this.store.setMeta("theme", JSON.stringify(theme));
    } catch {
      // Cosmetic only: keep the defaults and try again next time.
    }
    return theme;
  }



  async courses(opts: { refresh?: boolean } = {}): Promise<Course[]> {
    let courses = this.store.courses();
    if (courses.length === 0 || opts.refresh) {
      courses = await this.refreshCourses();
    }
    return courses;
  }

  async materials(courseId: number, opts: { refresh?: boolean } = {}): Promise<FileRow[]> {
    await this.ensureMaterials(courseId, opts.refresh);
    return this.store.files(courseId);
  }

  /** External-tool (LearningX) items of a course; open them in a browser. */
  async links(courseId: number, opts: { refresh?: boolean } = {}): Promise<Link[]> {
    await this.ensureMaterials(courseId, opts.refresh);
    return this.store.links(courseId);
  }

  private async ensureMaterials(courseId: number, refresh?: boolean): Promise<void> {
    // links_synced is checked too so caches from before links existed refill once.
    if (refresh || !this.store.meta(`files_synced:${courseId}`) || !this.store.meta(`links_synced:${courseId}`)) {
      await this.refreshFileList(courseId);
    }
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
    const needsFetch = !file || file.textStatus === "" || (text === undefined && file.textStatus === "error");
    if (needsFetch && file?.source === "learningx") {
      file = await this.fetchLearningXPdf(file);
      text = this.store.text(fileId);
    } else if (needsFetch && file?.source !== "import") {
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
    const { files, links } = await (await this.api()).courseMaterials(courseId, signal);
    this.store.replaceLinks(courseId, links);
    this.store.setMeta(`links_synced:${courseId}`, new Date().toISOString());
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

  // ---- manual import ----

  /**
   * Adds local files (e.g. materials downloaded from LearningX in a browser)
   * to a course's index. Folders are walked recursively; hidden and
   * unsupported files are skipped. Re-importing an unchanged file is a no-op.
   */
  async importFiles(courseId: number, paths: string[]): Promise<ImportReport> {
    const courses = await this.courses();
    if (!courses.some((c) => c.id === courseId)) {
      throw new Error(`Course ${courseId} is not an active course (see \`openlms courses\`)`);
    }
    const report: ImportReport = { imported: [], unchanged: [], skipped: [] };
    for (const path of await this.collectFiles(paths.map((p) => resolve(p)), report)) {
      await this.importOne(courseId, path, report);
    }
    return report;
  }

  private async collectFiles(paths: string[], report: ImportReport): Promise<string[]> {
    const out: string[] = [];
    for (const path of paths) {
      let info;
      try {
        info = await stat(path);
      } catch {
        report.skipped.push({ path, reason: "not found" });
        continue;
      }
      if (info.isDirectory()) {
        const entries = (await readdir(path)).filter((name) => !name.startsWith(".")).sort();
        out.push(...(await this.collectFiles(entries.map((name) => join(path, name)), report)));
      } else if (info.isFile()) {
        out.push(path);
      }
    }
    return out;
  }

  private async importOne(courseId: number, path: string, report: ImportReport): Promise<void> {
    const name = basename(path);
    const kind = extractKind(name);
    if (!kind) {
      report.skipped.push({ path, reason: "unsupported file type" });
      return;
    }
    const info = await stat(path);
    if (info.size > this.maxFileBytes) {
      report.skipped.push({ path, reason: "too large" });
      return;
    }
    const id = importedFileId(courseId, path);
    const updatedAt = info.mtime.toISOString();
    const existing = this.store.file(id);
    if (existing && existing.size === info.size && existing.updatedAt === updatedAt && existing.textStatus !== "error") {
      report.unchanged.push(path);
      return;
    }
    const localPath = localFilePath(this.home, courseId, id, name);
    await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
    await copyFile(path, localPath);
    let textStatus: TextStatus;
    try {
      const text = await extractText(kind, new Uint8Array(await readFile(localPath)));
      textStatus = isEffectivelyEmpty(text) ? "empty" : "ok";
      this.store.setText(id, courseId, name, text);
    } catch {
      textStatus = "error";
    }
    const row: FileRow = { id, courseId, name, contentType: "", size: info.size, updatedAt, localPath, textStatus, source: "import" };
    this.store.upsertFile(row);
    report.imported.push(row);
  }

  /** Removes an imported file from the index and the local copy. */
  async removeImported(fileId: number): Promise<FileRow> {
    const file = this.store.file(fileId);
    if (!file || file.source !== "import") {
      throw new Error(`File ${fileId} is not an imported file`);
    }
    this.store.deleteFile(fileId);
    if (file.localPath) {
      await rm(file.localPath, { force: true });
    }
    return file;
  }

  /**
   * Mirrors a course's LearningX PDFs: new or changed items are downloaded
   * and indexed, items no longer listed are removed.
   */
  private async syncLearningX(courseId: number, report: SyncReport, opts: SyncOptions, log: (m: string) => void): Promise<void> {
    const pdfs = await (await this.learningx()).pdfs(courseId, opts.signal);
    if (!pdfs) {
      return;
    }
    report.learningx += pdfs.length;
    report.filesTotal += pdfs.length;
    const keep = new Set<number>();
    for (const pdf of pdfs) {
      const id = learningxFileId(pdf.itemId);
      keep.add(id);
      const prev = this.store.file(id);
      const unchanged =
        prev &&
        prev.updatedAt === pdf.updatedAt &&
        prev.textStatus !== "" &&
        prev.textStatus !== "error" &&
        (prev.textStatus === "too_large" || (prev.localPath !== "" && existsSync(prev.localPath)));
      const row = this.learningxRow(courseId, pdf, unchanged ? prev : undefined);
      this.store.upsertFile(row);
      if (unchanged || opts.metadataOnly) {
        report.skipped += unchanged ? 1 : 0;
        continue;
      }
      log(`  ↓ ${pdf.fileName} (LearningX)`);
      try {
        const fetched = await this.fetchLearningXPdf(row, opts.signal);
        if (fetched.localPath) {
          report.downloaded++;
        }
        if (fetched.textStatus === "ok") {
          report.indexed++;
        }
      } catch (err) {
        report.errors.push(`LearningX / ${pdf.fileName}: ${message(err)}`);
      }
    }
    const removed = this.store.pruneFiles(courseId, keep, "learningx");
    report.removed += removed.length;
    for (const path of removed) {
      await rm(path, { force: true });
    }
  }

  private learningxRow(courseId: number, pdf: LearningXPdf, prev?: FileRow): FileRow {
    return {
      id: learningxFileId(pdf.itemId),
      courseId,
      name: pdf.fileName,
      contentType: "application/pdf",
      size: prev?.size ?? 0,
      updatedAt: pdf.updatedAt,
      localPath: prev?.localPath ?? "",
      // Pending until downloaded, so readers fetch it on demand.
      textStatus: prev?.textStatus ?? "",
      source: "learningx",
      remoteUrl: pdf.viewUrl,
      module: pdf.module,
    };
  }

  /** Downloads one LearningX PDF, extracts and indexes its text. */
  private async fetchLearningXPdf(file: FileRow, signal?: AbortSignal): Promise<FileRow> {
    const data = await (await this.learningx()).downloadPdf(file.remoteUrl ?? "", signal);
    const row: FileRow = { ...file, size: data.length, localPath: "", textStatus: "" };
    if (data.length > this.maxFileBytes) {
      row.textStatus = "too_large";
      this.store.upsertFile(row);
      return row;
    }
    row.localPath = localFilePath(this.home, file.courseId, file.id, file.name);
    await mkdir(dirname(row.localPath), { recursive: true, mode: 0o700 });
    await writeFile(row.localPath, data, { mode: 0o600 });
    try {
      const text = await extractText("pdf", data);
      row.textStatus = isEffectivelyEmpty(text) ? "empty" : "ok";
      this.store.setText(file.id, file.courseId, file.name, text);
    } catch {
      row.textStatus = "error";
    }
    this.store.upsertFile(row);
    return row;
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
    const release = this.acquireSyncLock();
    try {
      return await this.syncLocked(opts);
    } finally {
      release();
    }
  }

  /**
   * One sync at a time per data directory: the TUI `s` key and a terminal
   * `openlms sync` may otherwise run together. A lock left by a dead process is taken over.
   */
  private acquireSyncLock(): () => void {
    const path = join(this.home, "sync.lock");
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const owner = Number(readFileSync(path, "utf8"));
      if (owner && owner !== process.pid && processAlive(owner)) {
        throw new Error(`Another sync is already running (pid ${owner})`);
      }
      if (owner === process.pid) {
        throw new Error("A sync is already running");
      }
      writeFileSync(path, String(process.pid));
    }
    return () => {
      try {
        if (Number(readFileSync(path, "utf8")) === process.pid) {
          rmSync(path);
        }
      } catch {
        // Already gone.
      }
    };
  }

  private async syncLocked(opts: SyncOptions): Promise<SyncReport> {
    const log = opts.onProgress ?? (() => {});
    const report: SyncReport = {
      courses: 0,
      filesTotal: 0,
      learningx: 0,
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
        const before = new Set(this.store.files(course.id).filter((f) => f.source === "canvas").map((f) => f.id));
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
        if (opts.learningx) {
          log(`[${course.name}] LearningX…`);
          try {
            await this.syncLearningX(course.id, report, opts, log);
          } catch (err) {
            if (isFatal(err)) {
              throw err;
            }
            report.errors.push(`${course.name} / LearningX: ${message(err)}`);
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

    if (opts.signal?.aborted) {
      return report;
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
