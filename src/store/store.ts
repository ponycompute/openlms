// Local SQLite cache (node:sqlite, no native addon) with an FTS5 trigram
// index over extracted material text. Trigrams give substring matching,
// which works far better for Korean than whitespace tokenizing.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  code      TEXT NOT NULL DEFAULT '',
  term      TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY,
  course_id    INTEGER NOT NULL,
  name         TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT '',
  local_path   TEXT NOT NULL DEFAULT '',
  text_status  TEXT NOT NULL DEFAULT '',
  synced_at    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS files_course ON files(course_id);
CREATE TABLE IF NOT EXISTS file_text (
  file_id INTEGER PRIMARY KEY,
  text    TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS materials_fts USING fts5(
  name, body, file_id UNINDEXED, course_id UNINDEXED, tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY,
  course_id   INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at      TEXT,
  points      REAL NOT NULL DEFAULT 0,
  html_url    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS assignments_course ON assignments(course_id);
CREATE TABLE IF NOT EXISTS announcements (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL,
  title     TEXT NOT NULL,
  message   TEXT NOT NULL DEFAULT '',
  posted_at TEXT,
  html_url  TEXT NOT NULL DEFAULT '',
  author    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS announcements_course ON announcements(course_id);
CREATE TABLE IF NOT EXISTS links (
  id        INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL,
  module    TEXT NOT NULL DEFAULT '',
  title     TEXT NOT NULL,
  html_url  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_course ON links(course_id);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Columns added after 0.1.0; applied to existing databases on open. */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "files", column: "source", ddl: "ALTER TABLE files ADD COLUMN source TEXT NOT NULL DEFAULT 'canvas'" },
];

export type TextStatus = "" | "ok" | "empty" | "unsupported" | "too_large" | "error";

/** "canvas" files mirror the LMS; "import" files were added by `openlms import`. */
export type FileSource = "canvas" | "import";

export interface Course {
  id: number;
  name: string;
  code: string;
  term: string;
  syncedAt?: string;
}

export interface FileRow {
  id: number;
  courseId: number;
  courseName?: string;
  name: string;
  contentType: string;
  size: number;
  updatedAt: string;
  localPath: string;
  textStatus: TextStatus;
  source?: FileSource;
}

/** An external-tool module item (LearningX content) that can only be opened in a browser. */
export interface Link {
  id: number;
  courseId: number;
  module: string;
  title: string;
  htmlUrl: string;
}

export interface Assignment {
  id: number;
  courseId: number;
  courseName?: string;
  name: string;
  description: string;
  dueAt: string | null;
  points: number;
  htmlUrl: string;
}

export interface Announcement {
  id: number;
  courseId: number;
  courseName?: string;
  title: string;
  message: string;
  postedAt: string | null;
  htmlUrl: string;
  author: string;
}

export interface SearchHit {
  fileId: number;
  courseId: number;
  courseName: string;
  name: string;
  snippet: string;
}

export interface AssignmentFilter {
  courseId?: number;
  upcomingOnly?: boolean;
  /** With upcomingOnly: only items due within this many days. */
  withinDays?: number;
}

type Row = Record<string, unknown>;

const nowIso = () => new Date().toISOString();

const FILE_SELECT = `SELECT f.id, f.course_id, COALESCE(c.name, '') AS course_name, f.name, f.content_type,
  f.size, f.updated_at, f.local_path, f.text_status, f.source
  FROM files f LEFT JOIN courses c ON c.id = f.course_id`;

function toFile(r: Row): FileRow {
  return {
    id: Number(r.id),
    courseId: Number(r.course_id),
    courseName: String(r.course_name ?? ""),
    name: String(r.name),
    contentType: String(r.content_type),
    size: Number(r.size),
    updatedAt: String(r.updated_at),
    localPath: String(r.local_path),
    textStatus: String(r.text_status) as TextStatus,
    source: String(r.source) as FileSource,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Text around the first occurrence of term, with the match marked «». */
export function snippet(body: string, term: string, radius = 60): string {
  const index = body.toLowerCase().indexOf(term.toLowerCase());
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  if (index < 0) {
    const chars = [...body];
    return squash(chars.length > radius * 2 ? `${chars.slice(0, radius * 2).join("")}…` : body);
  }
  const before = [...body.slice(0, index)];
  const after = [...body.slice(index + term.length)];
  const start = Math.max(0, before.length - radius);
  const end = Math.min(after.length, radius);
  let out = `${before.slice(start).join("")}«${body.slice(index, index + term.length)}»${after.slice(0, end).join("")}`;
  if (start > 0) {
    out = `…${out}`;
  }
  if (end < after.length) {
    out += "…";
  }
  return squash(out);
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    for (const m of MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as Row[];
      if (!columns.some((c) => c.name === m.column)) {
        this.db.exec(m.ddl);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- courses ----

  replaceCourses(courses: Course[]): void {
    const insert = this.db.prepare("INSERT INTO courses (id, name, code, term, synced_at) VALUES (?, ?, ?, ?, ?)");
    this.tx(() => {
      this.db.exec("DELETE FROM courses");
      for (const c of courses) {
        insert.run(c.id, c.name, c.code, c.term, nowIso());
      }
    });
  }

  courses(): Course[] {
    const rows = this.db.prepare("SELECT id, name, code, term, synced_at FROM courses ORDER BY name").all() as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      code: String(r.code),
      term: String(r.term),
      syncedAt: String(r.synced_at),
    }));
  }

  // ---- files ----

  file(id: number): FileRow | undefined {
    const row = this.db.prepare(`${FILE_SELECT} WHERE f.id = ?`).get(id) as Row | undefined;
    return row ? toFile(row) : undefined;
  }

  files(courseId?: number): FileRow[] {
    const rows = courseId
      ? this.db.prepare(`${FILE_SELECT} WHERE f.course_id = ? ORDER BY f.name`).all(courseId)
      : this.db.prepare(`${FILE_SELECT} ORDER BY f.course_id, f.name`).all();
    return (rows as Row[]).map(toFile);
  }

  upsertFile(f: FileRow): void {
    this.db
      .prepare(
        `INSERT INTO files (id, course_id, name, content_type, size, updated_at, local_path, text_status, source, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET course_id = excluded.course_id, name = excluded.name,
           content_type = excluded.content_type, size = excluded.size, updated_at = excluded.updated_at,
           local_path = excluded.local_path, text_status = excluded.text_status, source = excluded.source,
           synced_at = excluded.synced_at`,
      )
      .run(f.id, f.courseId, f.name, f.contentType, f.size, f.updatedAt, f.localPath, f.textStatus, f.source ?? "canvas", nowIso());
  }

  /**
   * Removes cached Canvas files of a course not in `keep`; returns their
   * local paths. Imported files are never pruned by a Canvas refresh.
   */
  pruneFiles(courseId: number, keep: Set<number>): string[] {
    const removed: string[] = [];
    for (const f of this.files(courseId)) {
      if (keep.has(f.id) || f.source === "import") {
        continue;
      }
      this.deleteFile(f.id);
      if (f.localPath) {
        removed.push(f.localPath);
      }
    }
    return removed;
  }

  deleteFile(id: number): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM files WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM file_text WHERE file_id = ?").run(id);
      this.db.prepare("DELETE FROM materials_fts WHERE file_id = ?").run(id);
    });
  }

  setText(fileId: number, courseId: number, name: string, text: string): void {
    this.tx(() => {
      this.db
        .prepare("INSERT INTO file_text (file_id, text) VALUES (?, ?) ON CONFLICT(file_id) DO UPDATE SET text = excluded.text")
        .run(fileId, text);
      this.db.prepare("DELETE FROM materials_fts WHERE file_id = ?").run(fileId);
      this.db.prepare("INSERT INTO materials_fts (name, body, file_id, course_id) VALUES (?, ?, ?, ?)").run(name, text, fileId, courseId);
    });
  }

  text(fileId: number): string | undefined {
    const row = this.db.prepare("SELECT text FROM file_text WHERE file_id = ?").get(fileId) as Row | undefined;
    return row ? String(row.text) : undefined;
  }

  search(query: string, opts: { courseId?: number; limit?: number } = {}): SearchHit[] {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      throw new Error("Empty search query");
    }
    const limit = opts.limit ?? 20;
    // Trigram FTS needs >= 3 characters per term; fall back to LIKE otherwise.
    if (terms.some((t) => [...t].length < 3)) {
      return this.searchLike(terms, opts.courseId, limit);
    }
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
    const args: (string | number)[] = [match];
    let sql = `SELECT m.file_id, m.course_id, COALESCE(c.name, '') AS course_name, m.name,
      snippet(materials_fts, 1, '«', '»', '…', 24) AS snip
      FROM materials_fts m LEFT JOIN courses c ON c.id = m.course_id
      WHERE materials_fts MATCH ?`;
    if (opts.courseId) {
      sql += " AND m.course_id = ?";
      args.push(opts.courseId);
    }
    sql += " ORDER BY bm25(materials_fts, 5.0, 1.0) LIMIT ?";
    args.push(limit);
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map((r) => ({
      fileId: Number(r.file_id),
      courseId: Number(r.course_id),
      courseName: String(r.course_name),
      name: String(r.name),
      snippet: String(r.snip).replace(/\s+/g, " ").trim(),
    }));
  }

  private searchLike(terms: string[], courseId: number | undefined, limit: number): SearchHit[] {
    let sql = `SELECT m.file_id, m.course_id, COALESCE(c.name, '') AS course_name, m.name, m.body
      FROM materials_fts m LEFT JOIN courses c ON c.id = m.course_id WHERE 1 = 1`;
    const args: (string | number)[] = [];
    for (const t of terms) {
      sql += " AND (m.body LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\')";
      const pattern = `%${escapeLike(t)}%`;
      args.push(pattern, pattern);
    }
    if (courseId) {
      sql += " AND m.course_id = ?";
      args.push(courseId);
    }
    sql += " LIMIT ?";
    args.push(limit);
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map((r) => ({
      fileId: Number(r.file_id),
      courseId: Number(r.course_id),
      courseName: String(r.course_name),
      name: String(r.name),
      snippet: snippet(String(r.body), terms[0] ?? ""),
    }));
  }

  // ---- assignments ----

  replaceAssignments(courseId: number, assignments: Assignment[]): void {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO assignments (id, course_id, name, description, due_at, points, html_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.tx(() => {
      this.db.prepare("DELETE FROM assignments WHERE course_id = ?").run(courseId);
      for (const a of assignments) {
        insert.run(a.id, courseId, a.name, a.description, a.dueAt, a.points, a.htmlUrl);
      }
    });
  }

  assignments(filter: AssignmentFilter = {}): Assignment[] {
    let sql = `SELECT a.id, a.course_id, COALESCE(c.name, '') AS course_name, a.name, a.description, a.due_at, a.points, a.html_url
      FROM assignments a LEFT JOIN courses c ON c.id = a.course_id WHERE 1 = 1`;
    const args: (string | number)[] = [];
    if (filter.courseId) {
      sql += " AND a.course_id = ?";
      args.push(filter.courseId);
    }
    if (filter.upcomingOnly) {
      sql += " AND a.due_at IS NOT NULL AND a.due_at >= ?";
      args.push(nowIso());
      if (filter.withinDays) {
        sql += " AND a.due_at <= ?";
        args.push(new Date(Date.now() + filter.withinDays * 86_400_000).toISOString());
      }
    }
    sql += " ORDER BY a.due_at IS NULL, a.due_at, a.name";
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      courseId: Number(r.course_id),
      courseName: String(r.course_name),
      name: String(r.name),
      description: String(r.description),
      dueAt: r.due_at == null ? null : String(r.due_at),
      points: Number(r.points),
      htmlUrl: String(r.html_url),
    }));
  }

  // ---- announcements ----

  upsertAnnouncements(announcements: Announcement[]): void {
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO announcements (id, course_id, title, message, posted_at, html_url, author) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.tx(() => {
      for (const a of announcements) {
        insert.run(a.id, a.courseId, a.title, a.message, a.postedAt, a.htmlUrl, a.author);
      }
    });
  }

  announcements(opts: { courseId?: number; limit?: number } = {}): Announcement[] {
    let sql = `SELECT a.id, a.course_id, COALESCE(c.name, '') AS course_name, a.title, a.message, a.posted_at, a.html_url, a.author
      FROM announcements a LEFT JOIN courses c ON c.id = a.course_id`;
    const args: number[] = [];
    if (opts.courseId) {
      sql += " WHERE a.course_id = ?";
      args.push(opts.courseId);
    }
    sql += " ORDER BY a.posted_at DESC";
    if (opts.limit) {
      sql += " LIMIT ?";
      args.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      courseId: Number(r.course_id),
      courseName: String(r.course_name),
      title: String(r.title),
      message: String(r.message),
      postedAt: r.posted_at == null ? null : String(r.posted_at),
      htmlUrl: String(r.html_url),
      author: String(r.author),
    }));
  }

  // ---- links ----

  replaceLinks(courseId: number, links: Omit<Link, "courseId">[]): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO links (id, course_id, module, title, html_url) VALUES (?, ?, ?, ?, ?)");
    this.tx(() => {
      this.db.prepare("DELETE FROM links WHERE course_id = ?").run(courseId);
      for (const l of links) {
        insert.run(l.id, courseId, l.module, l.title, l.htmlUrl);
      }
    });
  }

  links(courseId: number): Link[] {
    const rows = this.db.prepare("SELECT id, course_id, module, title, html_url FROM links WHERE course_id = ? ORDER BY rowid").all(courseId) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      courseId: Number(r.course_id),
      module: String(r.module),
      title: String(r.title),
      htmlUrl: String(r.html_url),
    }));
  }

  // ---- meta ----

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }
}
