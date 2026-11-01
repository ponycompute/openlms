import { homedir } from "node:os";
import { join } from "node:path";

/** Data directory, ~/.lms by default, overridable with $LMS_HOME. */
export function lmsHome(): string {
  return process.env.LMS_HOME || join(homedir(), ".lms");
}

export function dbPath(home: string): string {
  return join(home, "lms.db");
}

export function localFilePath(home: string, courseId: number, fileId: number, name: string): string {
  let clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const chars = [...clean];
  if (chars.length > 100) {
    clean = chars.slice(-100).join("");
  }
  return join(home, "files", String(courseId), `${fileId}_${clean}`);
}
