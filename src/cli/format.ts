// Terminal formatting helpers that account for double-width CJK glyphs.

export function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    width += charWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

export function truncate(s: string, max: number): string {
  if (displayWidth(s) <= max) {
    return s;
  }
  let out = "";
  let width = 0;
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (width + w > max - 1) {
      break;
    }
    out += ch;
    width += w;
  }
  return `${out}…`;
}

export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

export function table(headers: string[], rows: string[][], maxColumn = 48): string {
  const cells = [headers, ...rows].map((r) => r.map((c) => truncate(c.replace(/\s+/g, " "), maxColumn)));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => displayWidth(r[i] ?? ""))));
  return cells
    .map((r, rowIndex) => {
      const line = r.map((c, i) => pad(c, widths[i] ?? 0)).join("  ").trimEnd();
      return rowIndex === 0 ? `${line}\n${widths.map((w) => "─".repeat(w)).join("  ")}` : line;
    })
    .join("\n");
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDue(iso: string | null, now = Date.now()): string {
  if (!iso) {
    return "-";
  }
  const due = new Date(iso);
  const local = due.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const hours = (due.getTime() - now) / 3_600_000;
  if (hours < 0) {
    return `${local} (마감)`;
  }
  if (hours < 24) {
    return `${local} (D-${Math.max(0, Math.round(hours))}h)`;
  }
  return `${local} (D-${Math.ceil(hours / 24)})`;
}

/** File name with a marker for files that did not come from Canvas Files. */
export function fileLabel(f: { name: string; source?: string }): string {
  if (f.source === "import") {
    return `${f.name} (가져옴)`;
  }
  return f.source === "learningx" ? `${f.name} (LearningX)` : f.name;
}
