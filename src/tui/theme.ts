// Canvas/LearningX look for the TUI: course card colors, course-name
// parsing, file-type badges and LearningX-style week grouping.
import type { Theme } from "../lms.js";
import type { Course, FileRow, TextStatus } from "../store/store.js";

/** Canvas's default dashboard card colors, used when the student picked none. */
const CARD_PALETTE = ["#0B874B", "#2573DF", "#BD3C14", "#8F3E97", "#D97900", "#06A3B7", "#65499D", "#E71F63", "#127A1B", "#4554A4"];

/**
 * Semantic colors from the "TUI Design System v0.1" ANSI (Tango) palette:
 * focus/info is bright blue, a selected item is bright yellow, panels and
 * muted text use bright black.
 */
export const C = {
  fg: "#D3D7CF",
  fgBright: "#EEEEEC",
  muted: "#888A85",
  panel: "#555753",
  border: "#555753",
  focus: "#96CBFE",
  select: "#FFFFB6",
  ok: "#8AE234",
  warn: "#FCE94F",
  err: "#EF2929",
  info: "#96CBFE",
  cyan: "#34E2E2",
  magenta: "#AD7FA8",
  brightRed: "#FF6B6B",
} as const;

export function courseColor(theme: Theme, courseId: number, index: number): string {
  return theme.courseColors[courseId] ?? CARD_PALETTE[index % CARD_PALETTE.length]!;
}

/**
 * Splits Korean Canvas course names like
 * "데이타베이스 | 005 분반 (Database Management Systems | 005 Section)".
 */
export function splitCourseName(name: string): { title: string; section: string; english: string } {
  const match = /^(.*?)\s*\|\s*([^()]*?)\s*(?:\((.*)\))?\s*$/.exec(name);
  if (!match) {
    return { title: name, section: "", english: "" };
  }
  return { title: match[1]!, section: match[2]!, english: (match[3] ?? "").replace(/\s*\|.*$/, "") };
}

/** A "[ TAG ]" label; `color` tints the text inside the brackets. */
export interface Badge {
  text: string;
  color: string;
}

export function fileBadge(name: string): Badge {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "pdf") return { text: "PDF", color: C.brightRed };
  if (ext === "ppt" || ext === "pptx") return { text: "PPT", color: C.warn };
  if (ext === "doc" || ext === "docx") return { text: "DOC", color: C.info };
  if (ext === "hwp" || ext === "hwpx") return { text: "HWP", color: C.cyan };
  return { text: "FILE", color: C.fg };
}

export const LINK_BADGE: Badge = { text: "LX↗", color: C.magenta };

export function statusText(status: TextStatus): { text: string; color: string } {
  switch (status) {
    case "ok":
      return { text: "[ OK ]", color: C.ok };
    case "empty":
      return { text: "[ 텍스트 없음 ]", color: C.warn };
    case "unsupported":
      return { text: "[ 미지원 ]", color: C.muted };
    case "too_large":
      return { text: "[ 용량 초과 ]", color: C.muted };
    case "error":
      return { text: "[ ERR ]", color: C.err };
    default:
      return { text: "[ 미동기화 ]", color: C.muted };
  }
}

/** Week number in a module title ("3주차", "Week 3"), for LearningX-style ordering. */
export function weekNumber(title: string): number | undefined {
  const match = /(\d+)\s*주차/.exec(title) ?? /week\s*(\d+)/i.exec(title);
  return match ? Number(match[1]) : undefined;
}

export const CANVAS_FILES_SECTION = "강의 파일";
export const IMPORTED_SECTION = "가져온 파일";

/** Canvas files first, then weeks in order, other modules by name, imports last. */
export function compareSections(a: string, b: string): number {
  const rank = (s: string) => (s === CANVAS_FILES_SECTION ? 0 : s === IMPORTED_SECTION ? 3 : weekNumber(s) !== undefined ? 1 : 2);
  const diff = rank(a) - rank(b);
  if (diff !== 0) {
    return diff;
  }
  const wa = weekNumber(a);
  const wb = weekNumber(b);
  if (wa !== undefined && wb !== undefined && wa !== wb) {
    return wa - wb;
  }
  return a.localeCompare(b, "ko");
}

/** Same item regardless of extension, case or spacing (LearningX link vs. its PDF). */
export function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/\s+/g, "");
  return norm(a) === norm(b);
}

export function fileSection(f: FileRow, moduleHint?: string): string {
  if (f.module) return f.module;
  if (moduleHint) return moduleHint;
  return f.source === "import" ? IMPORTED_SECTION : CANVAS_FILES_SECTION;
}

export function shortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

export function dueLabel(iso: string | null, now = Date.now()): { text: string; color: string; tag: string } {
  if (!iso) {
    return { text: "마감일 없음", color: C.muted, tag: "" };
  }
  const due = new Date(iso);
  const when = due.toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const hours = (due.getTime() - now) / 3_600_000;
  if (hours < 0) return { text: `${when} 마감됨`, color: C.muted, tag: "" };
  if (hours < 24) return { text: `${when} 마감`, color: C.err, tag: `[ ${Math.max(1, Math.round(hours))}h ]` };
  if (hours < 72) return { text: `${when} 마감`, color: C.warn, tag: `[ D-${Math.ceil(hours / 24)} ]` };
  return { text: `${when} 마감`, color: C.fg, tag: `[ D-${Math.ceil(hours / 24)} ]` };
}

/** "[█████░░░░░]" with the filled part in the selection color. */
export function progressParts(ratio: number, width: number): { filled: string; empty: string } {
  const n = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return { filled: "█".repeat(n), empty: "░".repeat(width - n) };
}

/** "오늘", "내일" or "11월 5일 (수)" for grouping the To-Do list by day. */
export function dayHeading(iso: string, now = new Date()): string {
  const due = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(due) - startOf(now)) / 86_400_000);
  const label = due.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  if (days === 0) return `오늘 · ${label}`;
  if (days === 1) return `내일 · ${label}`;
  return label;
}

export function courseTitle(course: Pick<Course, "name">): string {
  return splitCourseName(course.name).title;
}
