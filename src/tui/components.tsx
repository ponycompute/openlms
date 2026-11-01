// Building blocks following the "TUI Design System v0.1" patterns: titled
// panels, "[ TAG ]" labels, block progress bars, bracket tabs, an arrow for
// the selected list item and a status bar with "[key] action" hints.
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { displayWidth, pad, truncate } from "../cli/format.js";
import type { Course } from "../store/store.js";
import { I } from "./icons.js";
import { C, progressParts, splitCourseName, type Badge } from "./theme.js";

export const GLOBAL_NAV_WIDTH = 10;

export type NavKey = "dashboard" | "todo" | "search";

const NAV_ITEMS: { key: NavKey; label: string; hotkey: string }[] = [
  { key: "dashboard", label: "대시보드", hotkey: "d" },
  { key: "todo", label: "할 일", hotkey: "t" },
  { key: "search", label: "검색", hotkey: "/" },
];

function center(s: string, width: number): string {
  const left = Math.max(0, Math.floor((width - displayWidth(s)) / 2));
  return pad(" ".repeat(left) + s, width);
}

/** Canvas's global navigation: a brand-colored column on the left. */
export function GlobalNav({ brand, active, height }: { brand: string; active?: NavKey; height: number }) {
  const lines: { text: string; active?: boolean; bold?: boolean; key?: boolean }[] = [{ text: "" }, { text: `${I.brand} OpenLMS`, bold: true }, { text: "" }];
  for (const item of NAV_ITEMS) {
    const on = item.key === active;
    lines.push({ text: "", active: on }, { text: I[item.key], active: on }, { text: item.label, active: on }, { text: `[${item.hotkey}]`, active: on, key: true });
    lines.push({ text: "" });
  }
  while (lines.length < height) {
    lines.push({ text: "" });
  }
  return (
    <Box flexDirection="column" width={GLOBAL_NAV_WIDTH} flexShrink={0}>
      {lines.slice(0, height).map((line, i) => (
        <Text key={i} backgroundColor={line.active ? "#FFFFFF" : brand} color={line.active ? brand : "#FFFFFF"} bold={line.bold || line.active} dimColor={!line.active && line.key}>
          {center(line.text, GLOBAL_NAV_WIDTH)}
        </Text>
      ))}
    </Box>
  );
}

/** "[ OK ]"-style label. */
export function Tag({ text, color }: { text: string; color: string }) {
  return <Text color={color}>{text}</Text>;
}

/** "[█████░░░░░]" block progress bar. */
export function Progress({ ratio, width }: { ratio: number; width: number }) {
  const { filled, empty } = progressParts(ratio, width);
  return (
    <Text>
      <Text color={C.muted}>[</Text>
      <Text color={C.select}>{filled}</Text>
      <Text color={C.panel}>{empty}</Text>
      <Text color={C.muted}>]</Text>
    </Text>
  );
}

/** Title bar: menu icon and "과목 › 페이지" on the left, a status tag on the right, then a rule. */
export function Header({ parts, width, status }: { parts: { text: string; color?: string }[]; width: number; status: { tag: string; color: string; text: string } }) {
  const right = `${status.tag} ${status.text}`;
  const crumbs = parts.map((p) => p.text).join(" › ");
  const room = Math.max(10, width - displayWidth(right) - 6);
  const shown = truncate(crumbs, room);
  // Truncation works on the joined string; colors are only applied when it fits.
  const fits = shown === crumbs;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={C.fgBright}> {I.menu}  </Text>
        {fits
          ? parts.map((p, i) => (
              <Text key={i}>
                {i > 0 && <Text color={C.muted}> › </Text>}
                <Text color={i < parts.length - 1 ? (p.color ?? C.fg) : C.fgBright} bold={i === parts.length - 1}>
                  {p.text}
                </Text>
              </Text>
            ))
          : <Text color={C.fgBright} bold>{shown}</Text>}
        {pad("", Math.max(1, width - 4 - displayWidth(shown) - displayWidth(right)))}
        <Tag text={status.tag} color={status.color} />
        <Text color={C.muted}> {status.text}</Text>
      </Text>
      <Text color={C.border}>{"─".repeat(Math.max(0, width))}</Text>
    </Box>
  );
}

/** "[주차학습]  과제  공지사항" bracket tabs; the active tab sits on a panel-colored chip. */
export function Tabs({ tabs, active }: { tabs: string[]; active: number }) {
  return (
    <Text>
      {tabs.map((t, i) => (
        <Text key={t}>
          {i > 0 && " "}
          {i === active ? (
            <Text backgroundColor={C.panel} color={C.fgBright} bold>
              [{t}]
            </Text>
          ) : (
            <Text color={C.fg}>
              {" "}
              <Text color={C.muted}>{i + 1}</Text> {t}{" "}
            </Text>
          )}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Bordered panel with its title in the top border:
 * "╭─[1]─Title──────── right ─╮". A focused panel gets the focus color.
 */
export function Panel({ title, hotkey, right, focused, width, height, children }: { title: string; hotkey?: string; right?: string; focused?: boolean; width: number; height?: number; children: ReactNode }) {
  const color = focused ? C.focus : C.border;
  const rightPart = right ? ` ${right} ─` : "";
  const label = truncate(`${hotkey ? `[${hotkey}]─` : ""}${title}`, Math.max(4, width - 4 - displayWidth(rightPart)));
  const fill = Math.max(0, width - 3 - displayWidth(label) - displayWidth(rightPart));
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={color}>╭─</Text>
        <Text color={focused ? C.focus : C.fgBright} bold>
          {label}
        </Text>
        <Text color={color}>{"─".repeat(fill)}</Text>
        {right && (
          <>
            <Text color={C.muted}> {right} </Text>
            <Text color={color}>─</Text>
          </>
        )}
        <Text color={color}>╮</Text>
      </Text>
      <Box flexDirection="column" borderStyle="round" borderTop={false} borderColor={color} paddingX={1} width={width} flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

/** Usable content width / height inside a Panel. */
export const panelInner = (width: number, height: number) => ({ width: width - 4, height: height - 2 });

export interface Row {
  key: string;
  /** Rows sharing a section are listed under one header bar (a LearningX week). */
  section?: string;
  badge?: Badge;
  label: string;
  labelColor?: string;
  right?: string;
  rightColor?: string;
  /** Optional "secondary description" line; «text» is highlighted (search matches). */
  sub?: string;
  open?: () => Promise<{ title: string; meta: string; body: string }>;
  enter?: () => void;
}

type Line = { kind: "section"; text: string } | { kind: "gap" } | { kind: "item"; index: number } | { kind: "sub"; index: number };

function layout(rows: Row[]): Line[] {
  const lines: Line[] = [];
  let section: string | undefined;
  rows.forEach((row, index) => {
    if (row.section !== undefined && row.section !== section) {
      if (lines.length) {
        lines.push({ kind: "gap" });
      }
      lines.push({ kind: "section", text: row.section });
      section = row.section;
    }
    lines.push({ kind: "item", index });
    if (row.sub) {
      lines.push({ kind: "sub", index });
    }
  });
  return lines;
}

function Highlighted({ text }: { text: string }) {
  return (
    <Text color={C.muted}>
      {text.split(/«|»/).map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} bold color={C.select}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

/** Badges share one width so labels line up ("[PDF]", "[LX↗]", "[과제]"). */
const BADGE_WIDTH = 4;
const badgeText = (b: Badge) => `[${pad(b.text, BADGE_WIDTH)}]`;

/** Scrolling list: section header bars, "→" on the selected item, right-aligned tags. */
export function RowList({ rows, cursor, height, width, empty }: { rows: Row[]; cursor: number; height: number; width: number; empty: string }) {
  if (rows.length === 0) {
    return (
      <Text color={C.muted} wrap="truncate-end">
        {truncate(empty, width)}
      </Text>
    );
  }
  const lines = layout(rows);
  const cursorLine = lines.findIndex((l) => l.kind === "item" && l.index === cursor);
  // Keep the cursor's section bar in view when possible.
  let start = Math.max(0, cursorLine - Math.floor(height / 3));
  start = Math.min(start, Math.max(0, lines.length - height));
  const visible = lines.slice(start, start + height);

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => {
        if (line.kind === "gap") {
          return <Text key={`g${start + i}`}> </Text>;
        }
        if (line.kind === "section") {
          return (
            <Text key={`s${start + i}`} backgroundColor={C.panel} color={C.fgBright} bold>
              {pad(` ${truncate(line.text, width - 2)}`, width)}
            </Text>
          );
        }
        const row = rows[line.index]!;
        const selected = line.index === cursor;
        const badgeWidth = row.badge ? BADGE_WIDTH + 3 : 0;
        if (line.kind === "sub") {
          const indent = " ".repeat(2 + badgeWidth);
          return (
            <Text key={`u${row.key}`} wrap="truncate-end">
              {indent}
              <Highlighted text={truncate(row.sub!, Math.max(4, width - indent.length))} />
            </Text>
          );
        }
        const right = row.right ? `  ${row.right}` : "";
        const labelMax = Math.max(4, width - 2 - badgeWidth - displayWidth(right));
        const label = truncate(row.label, labelMax);
        const gap = " ".repeat(Math.max(0, labelMax - displayWidth(label)));
        return (
          <Text key={row.key} wrap="truncate-end">
            <Text color={C.select} bold>
              {selected ? "→ " : "  "}
            </Text>
            {row.badge && <Text color={row.badge.color}>{badgeText(row.badge)} </Text>}
            <Text color={selected ? C.select : (row.labelColor ?? C.fg)} bold={selected}>
              {label}
            </Text>
            {gap}
            <Text color={row.rightColor ?? C.muted}>{right}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export const CARD_HEIGHT = 7;

/**
 * A Canvas dashboard card: colored header band (term, section), name in the
 * card color, English name, and a materials progress bar.
 */
export function CourseCard({ course, color, width, selected, materials }: { course: Course; color: string; width: number; selected: boolean; materials: { ok: number; total: number } }) {
  const inner = width - 2;
  const { title, section, english } = splitCourseName(course.name);
  const subtitle = english || (course.code !== course.name ? course.code : "");
  const count = `${materials.ok}/${materials.total}`;
  const barWidth = Math.max(4, Math.min(12, inner - 8 - count.length));
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={selected ? C.focus : C.border} flexShrink={0}>
      <Text backgroundColor={color} color="#FFFFFF">
        {pad(` ${truncate(course.term, inner - 5)}`, inner - 3)} {I.more}{" "}
      </Text>
      <Text backgroundColor={color} color="#FFFFFF" bold>
        {pad(` ${truncate(section || " ", inner - 2)}`, inner)}
      </Text>
      <Text color={selected ? C.select : color} bold wrap="truncate-end">
        {selected ? "→" : " "}
        {truncate(title, inner - 2)}
      </Text>
      <Text color={C.muted} wrap="truncate-end">
        {" "}
        {truncate(subtitle || " ", inner - 2)}
      </Text>
      <Text wrap="truncate-end">
        {" "}
        {materials.total ? (
          <>
            <Text color={C.muted}>자료 </Text>
            <Progress ratio={materials.ok / materials.total} width={barWidth} />
            <Text color={C.fg}> {count}</Text>
          </>
        ) : (
          <Text color={C.muted}>자료 없음 · LearningX 링크만</Text>
        )}
      </Text>
    </Box>
  );
}

/** Status bar: info on the left, "[key] action" hints on the right (fitted to width). */
export function StatusBar({ left, hints, message, width }: { left: string; hints: [string, string][]; message?: string; width: number }) {
  if (message) {
    const isErr = message.startsWith("✗");
    return (
      <Text wrap="truncate-end">
        <Tag text={isErr ? "[ ERR ]" : "[ INFO ]"} color={isErr ? C.err : C.info} />
        <Text color={isErr ? C.err : C.fg}> {truncate(message.replace(/^✗\s*/, ""), width - 10)}</Text>
      </Text>
    );
  }
  const room = width - displayWidth(left) - 3;
  const shown: [string, string][] = [];
  let used = 0;
  for (const h of hints) {
    const w = displayWidth(`[${h[0]}] ${h[1]}  `);
    if (used + w > room) break;
    shown.push(h);
    used += w;
  }
  return (
    <Text wrap="truncate-end">
      <Text color={C.muted}> {left}</Text>
      {pad("", Math.max(1, width - 1 - displayWidth(left) - used))}
      {shown.map(([key, label]) => (
        <Text key={key}>
          <Text color={C.fgBright} bold>
            [{key}]
          </Text>
          <Text color={C.fg}> {label}  </Text>
        </Text>
      ))}
    </Text>
  );
}
