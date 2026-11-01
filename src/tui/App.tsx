import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { displayWidth, formatBytes, truncate } from "../cli/format.js";
import type { Lms, Theme } from "../lms.js";
import type { Announcement, Assignment, Course, FileRow, Link, SearchHit } from "../store/store.js";
import {
  CARD_HEIGHT,
  CourseCard,
  GLOBAL_NAV_WIDTH,
  GlobalNav,
  Header,
  Panel,
  panelInner,
  RowList,
  StatusBar,
  Tabs,
  Tag,
  type NavKey,
  type Row,
} from "./components.js";
import { I } from "./icons.js";
import { openUrl } from "./open-url.js";
import {
  C,
  compareSections,
  courseColor,
  courseTitle,
  dayHeading,
  dueLabel,
  fileBadge,
  fileSection,
  LINK_BADGE,
  sameTitle,
  shortDate,
  splitCourseName,
  statusText,
} from "./theme.js";

interface Materials {
  files: FileRow[];
  links: Link[];
}

type Tab = "materials" | "assignments" | "announcements";
const TABS: { key: Tab; label: string }[] = [
  { key: "materials", label: "주차학습" },
  { key: "assignments", label: "과제" },
  { key: "announcements", label: "공지사항" },
];
const tabTitle = (key: Tab) => `${I[key]} ${TABS.find((t) => t.key === key)!.label}`;

type Screen =
  | { kind: "dashboard" }
  | { kind: "course"; course: Course; tab: Tab }
  | { kind: "todo" }
  | { kind: "search"; query: string; editing: boolean }
  | { kind: "detail"; title: string; meta: string; body: string; crumbs: { text: string; color?: string }[]; back: Screen };

const DEFAULT_THEME: Theme = { brand: "#394B58", courseColors: {} };
const SIDEBAR_WIDTH = 38;
const MIN_CARD_WIDTH = 28;

/**
 * Loads data for `key`. Results are tagged with the key they were loaded
 * for, so a render after the key changes never sees the previous key's data.
 */
function useAsync<T>(fn: () => Promise<T>, key: string): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ key?: string; data?: T; error?: string }>({});
  useEffect(() => {
    let alive = true;
    fn().then(
      (data) => alive && setState({ key, data }),
      (err: unknown) => alive && setState({ key, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? { data: state.data, error: state.error, loading: false } : { loading: true };
}

function wrapLines(body: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    let line = "";
    let w = 0;
    for (const ch of raw) {
      const cw = displayWidth(ch);
      if (w + cw > width) {
        out.push(line);
        line = "";
        w = 0;
      }
      line += ch;
      w += cw;
    }
    out.push(line);
  }
  return out;
}

/** Dashboard grid geometry, shared by rendering and arrow-key movement. */
function dashboardLayout(mainWidth: number) {
  const sidebar = mainWidth >= 100 ? SIDEBAR_WIDTH : 0;
  const gridWidth = mainWidth - (sidebar ? sidebar + 1 : 0);
  const perRow = Math.max(1, Math.floor((gridWidth + 1) / (MIN_CARD_WIDTH + 1)));
  const cardWidth = Math.min(40, Math.floor((gridWidth - (perRow - 1)) / perRow));
  return { sidebar, perRow, cardWidth };
}

function syncStatus(lastSync: string | undefined): { tag: string; color: string; text: string } {
  if (!lastSync) {
    return { tag: "[ WARN ]", color: C.warn, text: "동기화 안 됨 · [s] 동기화" };
  }
  const when = new Date(lastSync).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const stale = Date.now() - new Date(lastSync).getTime() > 3 * 86_400_000;
  return stale ? { tag: "[ WARN ]", color: C.warn, text: `마지막 동기화 ${when}` } : { tag: "[ OK ]", color: C.ok, text: `동기화 ${when}` };
}

function materialRows(data: Materials, openMaterial: (f: FileRow) => Promise<{ title: string; meta: string; body: string }>, setStatus: (s: string) => void): Row[] {
  const learningxFiles = data.files.filter((f) => f.source === "learningx");
  const rows: (Row & { section: string })[] = [];
  for (const f of data.files) {
    const status = statusText(f.textStatus);
    const link = f.module ? undefined : data.links.find((l) => sameTitle(l.title, f.name));
    rows.push({
      key: `f${f.id}`,
      section: fileSection(f, link?.module),
      badge: fileBadge(f.name),
      label: f.name.replace(/\.pdf$/i, ""),
      right: `${f.size ? formatBytes(f.size).padStart(7) : ""}  ${status.text}`,
      rightColor: status.color,
      open: () => openMaterial(f),
    });
  }
  for (const l of data.links) {
    // A LearningX item already mirrored as a PDF is listed once, as the PDF.
    if (learningxFiles.some((f) => sameTitle(l.title, f.name))) {
      continue;
    }
    rows.push({
      key: `l${l.id}`,
      section: l.module || "LearningX",
      badge: LINK_BADGE,
      label: l.title,
      right: "브라우저에서 열기",
      rightColor: C.info,
      enter: () => {
        try {
          openUrl(l.htmlUrl);
          setStatus(`브라우저에서 열었습니다: ${l.title}`);
        } catch (err) {
          setStatus(`✗ ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
  }
  const order = [...new Set(rows.map((r) => r.section))].sort(compareSections);
  return order.flatMap((section) => rows.filter((r) => r.section === section));
}

function assignmentRows(list: Assignment[], color: string): Row[] {
  const now = Date.now();
  const upcoming = list.filter((a) => a.dueAt && new Date(a.dueAt).getTime() >= now);
  const undated = list.filter((a) => !a.dueAt);
  const past = list.filter((a) => a.dueAt && new Date(a.dueAt).getTime() < now).reverse();
  const row = (a: Assignment, section: string): Row => {
    const due = dueLabel(a.dueAt);
    return {
      key: `a${a.id}`,
      section,
      badge: { text: "과제", color },
      label: a.name,
      right: `${due.text} · ${a.points}점${due.tag ? `  ${due.tag}` : ""}`,
      rightColor: due.color,
      open: async () => ({
        title: a.name,
        meta: `${due.text} · ${a.points}점 · ${a.htmlUrl}`,
        body: a.description || "(설명 없음)",
      }),
    };
  };
  return [
    ...upcoming.map((a) => row(a, `다가오는 과제 (${upcoming.length})`)),
    ...undated.map((a) => row(a, `마감일 없는 과제 (${undated.length})`)),
    ...past.map((a) => row(a, `지난 과제 (${past.length})`)),
  ];
}

function announcementRows(list: Announcement[]): Row[] {
  return list.map((a) => ({
    key: `n${a.id}`,
    badge: { text: "공지", color: C.cyan },
    label: a.title,
    right: shortDate(a.postedAt),
    sub: [a.author, a.message.replace(/\s+/g, " ").trim()].filter(Boolean).join(" · "),
    open: async () => ({
      title: a.title,
      meta: `${a.author} · ${a.postedAt ? new Date(a.postedAt).toLocaleString("ko-KR") : ""} · ${a.htmlUrl}`,
      body: a.message,
    }),
  }));
}

export function App({ lms }: { lms: Lms }) {
  const { exit } = useApp();
  // Re-renders on every resize, so all widths below follow the window.
  const size = useWindowSize();
  const rows = size.rows || 30;
  const cols = size.columns || 80;
  // One line short of the screen so the terminal never scrolls.
  const totalHeight = Math.max(12, rows - 1);
  const mainWidth = Math.max(40, cols - GLOBAL_NAV_WIDTH - 2);
  const bodyHeight = totalHeight - 3;

  const [screen, setScreen] = useState<Screen>({ kind: "dashboard" });
  const [cursor, setCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [status, setStatus] = useState<string>("");
  // `r` bumps `reload` and marks which loaders should bypass the cache once.
  const [reload, setReload] = useState(0);
  const pendingRefresh = useRef(new Set<string>());
  const takeRefresh = (name: string) => pendingRefresh.current.delete(name);
  // `s` runs a full sync in the background; this holds its latest progress line.
  const [syncing, setSyncing] = useState<string | undefined>();
  const syncAbort = useRef<AbortController | undefined>(undefined);

  const theme = useAsync(() => lms.theme({ refresh: takeRefresh("theme") }), `theme:${reload}`).data ?? DEFAULT_THEME;
  const courses = useAsync(() => lms.courses({ refresh: takeRefresh("courses") }), `courses:${reload}`);
  const upcoming = useAsync(
    () => lms.assignments({ upcomingOnly: true, withinDays: 14 }, { refresh: takeRefresh("upcoming") }),
    `upcoming:${reload}`,
  );
  const courseList = courses.data ?? [];
  const colorOf = (courseId: number) => courseColor(theme, courseId, Math.max(0, courseList.findIndex((c) => c.id === courseId)));

  // Per-course material counts for the dashboard cards (local cache only).
  const materialStats = useMemo(() => {
    const stats = new Map<number, { ok: number; total: number }>();
    for (const f of lms.store.files()) {
      const s = stats.get(f.courseId) ?? { ok: 0, total: 0 };
      s.total++;
      s.ok += f.textStatus === "ok" ? 1 : 0;
      stats.set(f.courseId, s);
    }
    return stats;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses.data, reload]);
  const lastSync = lms.store.meta("last_sync");

  const courseKey = screen.kind === "course" ? `${screen.course.id}:${screen.tab}` : "-";
  const courseData = useAsync<Materials | Assignment[] | Announcement[] | undefined>(async () => {
    if (screen.kind !== "course") {
      return undefined;
    }
    const id = screen.course.id;
    const refresh = takeRefresh(courseKey);
    if (screen.tab === "materials") {
      const files = await lms.materials(id, { refresh });
      return { files, links: await lms.links(id) };
    }
    if (screen.tab === "assignments") {
      return lms.assignments({ courseId: id }, { refresh });
    }
    return lms.announcements({ courseId: id, limit: 100, refresh });
  }, `${courseKey}:${reload}`);

  const [hits, setHits] = useState<SearchHit[]>([]);

  const go = (next: Screen) => {
    setScreen(next);
    setCursor(0);
    setScroll(0);
    setStatus("");
  };

  const openMaterial = async (f: Pick<FileRow, "id" | "name">) => {
    const r = await lms.readMaterial(f.id, { maxChars: 2_000_000 });
    return {
      title: r.file.name,
      meta: [r.file.courseName ? courseTitle({ name: r.file.courseName }) : "", r.file.size ? formatBytes(r.file.size) : "", `${r.totalChars.toLocaleString()}자`]
        .filter(Boolean)
        .join(" · "),
      body: r.text || "(추출된 텍스트 없음)",
    };
  };

  const items: Row[] = useMemo(() => {
    if (screen.kind === "search") {
      return hits.map((h) => ({
        key: `h${h.fileId}`,
        section: courseTitle({ name: h.courseName }),
        badge: fileBadge(h.name),
        label: h.name,
        sub: h.snippet,
        open: () => openMaterial({ id: h.fileId, name: h.name }),
      }));
    }
    if (screen.kind === "todo") {
      return (upcoming.data ?? []).map((a) => {
        const due = dueLabel(a.dueAt);
        return {
          key: `t${a.id}`,
          section: a.dueAt ? dayHeading(a.dueAt) : "마감일 없음",
          badge: { text: "과제", color: colorOf(a.courseId) },
          label: a.name,
          right: `${a.dueAt ? new Date(a.dueAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) : ""} · ${a.points}점${due.tag ? `  ${due.tag}` : ""}`,
          rightColor: due.color,
          sub: a.courseName ? splitCourseName(a.courseName).title : undefined,
          open: async () => ({ title: a.name, meta: `${due.text} · ${a.points}점 · ${a.htmlUrl}`, body: a.description || "(설명 없음)" }),
        };
      });
    }
    if (screen.kind === "course" && courseData.data) {
      if (screen.tab === "materials") {
        return materialRows(courseData.data as Materials, openMaterial, setStatus);
      }
      if (screen.tab === "assignments") {
        return assignmentRows(courseData.data as Assignment[], colorOf(screen.course.id));
      }
      return announcementRows(courseData.data as Announcement[]);
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, courseData.data, upcoming.data, hits, theme]);

  const detailPanel = panelInner(mainWidth, bodyHeight);
  const detailPage = Math.max(1, detailPanel.height - 2);
  const detailLines = useMemo(() => (screen.kind === "detail" ? wrapLines(screen.body, detailPanel.width) : []), [screen, detailPanel.width]);
  const grid = dashboardLayout(mainWidth);

  const startSync = () => {
    if (syncAbort.current) {
      setStatus("이미 동기화 중입니다");
      return;
    }
    const controller = new AbortController();
    syncAbort.current = controller;
    // LearningX is opt-in: include it once the user has synced it before.
    const learningx = lms.store.files().some((f) => f.source === "learningx");
    setStatus("");
    setSyncing("동기화 시작…");
    lms
      .sync({ learningx, signal: controller.signal, onProgress: setSyncing })
      .then(
        (report) => {
          const errors = report.errors.length ? ` · ⚠ 오류 ${report.errors.length}건` : "";
          setStatus(`동기화 완료 · 파일 ${report.filesTotal} · 새로 받음 ${report.downloaded}${errors}`);
          setReload((n) => n + 1);
        },
        (err: unknown) => {
          if (!controller.signal.aborted) {
            setStatus(`✗ 동기화 실패: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      )
      .finally(() => {
        syncAbort.current = undefined;
        setSyncing(undefined);
      });
  };

  const openRow = (row: Row | undefined) => {
    if (row?.enter) {
      row.enter();
    } else if (row?.open) {
      setStatus("불러오는 중…");
      row.open().then(
        (d) => {
          setStatus("");
          setScroll(0);
          setScreen({ kind: "detail", ...d, crumbs: crumbs(screen), back: screen });
        },
        (err: unknown) => setStatus(`✗ ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  };

  useInput((input, key) => {
    if (screen.kind === "search" && screen.editing) {
      if (key.escape) {
        go({ kind: "dashboard" });
      } else if (key.return) {
        try {
          setHits(screen.query.trim() ? lms.search(screen.query, { limit: 50 }) : []);
          setScreen({ ...screen, editing: false });
          setCursor(0);
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        }
      } else if (key.backspace || key.delete) {
        setScreen({ ...screen, query: screen.query.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setScreen({ ...screen, query: screen.query + input });
      }
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      syncAbort.current?.abort();
      exit();
      return;
    }

    if (screen.kind === "detail") {
      const maxScroll = Math.max(0, detailLines.length - detailPage);
      if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === "j") setScroll((s) => Math.min(maxScroll, s + 1));
      else if (key.pageUp || input === "b") setScroll((s) => Math.max(0, s - detailPage));
      else if (key.pageDown || input === " ") setScroll((s) => Math.min(maxScroll, s + detailPage));
      else if (key.escape || key.backspace || key.leftArrow) {
        setScreen(screen.back);
        setScroll(0);
      }
      return;
    }

    if (input === "/") {
      go({ kind: "search", query: "", editing: true });
      return;
    }
    if (input === "t") {
      go({ kind: "todo" });
      return;
    }
    if (input === "d") {
      go({ kind: "dashboard" });
      return;
    }
    if (input === "s") {
      startSync();
      return;
    }
    if (input === "r") {
      const names = screen.kind === "course" ? [courseKey] : screen.kind === "todo" ? ["upcoming"] : ["courses", "upcoming", "theme"];
      for (const name of names) {
        pendingRefresh.current.add(name);
      }
      setReload((n) => n + 1);
      return;
    }

    if (screen.kind === "dashboard") {
      const last = Math.max(0, courseList.length - 1);
      if (key.leftArrow || input === "h") setCursor((c) => Math.max(0, c - 1));
      else if (key.rightArrow || input === "l") setCursor((c) => Math.min(last, c + 1));
      else if (key.upArrow || input === "k") setCursor((c) => (c - grid.perRow >= 0 ? c - grid.perRow : c));
      else if (key.downArrow || input === "j") setCursor((c) => Math.min(last, c + grid.perRow));
      else if (key.return && courseList[cursor]) go({ kind: "course", course: courseList[cursor]!, tab: "materials" });
      return;
    }

    if (key.escape || key.backspace) {
      go({ kind: "dashboard" });
      return;
    }
    if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(Math.max(0, items.length - 1), c + 1));
    else if (screen.kind === "course" && (key.tab || key.rightArrow || key.leftArrow || ["1", "2", "3"].includes(input))) {
      const i = TABS.findIndex((t) => t.key === screen.tab);
      const next = ["1", "2", "3"].includes(input)
        ? TABS[Number(input) - 1]!
        : TABS[(i + (key.leftArrow || key.shift ? TABS.length - 1 : 1)) % TABS.length]!;
      go({ ...screen, tab: next.key });
    } else if (key.return) {
      openRow(items[cursor]);
    }
  });

  function crumbs(s: Screen): { text: string; color?: string }[] {
    switch (s.kind) {
      case "dashboard":
        return [{ text: "대시보드" }];
      case "todo":
        return [{ text: "할 일" }];
      case "search":
        return [{ text: "검색" }];
      case "course":
        return [{ text: courseTitle(s.course), color: colorOf(s.course.id) }, { text: TABS.find((t) => t.key === s.tab)!.label }];
      case "detail":
        return [...s.crumbs, { text: s.title }];
    }
  }

  const navActive: NavKey | undefined =
    screen.kind === "dashboard" || screen.kind === "course" ? "dashboard" : screen.kind === "todo" ? "todo" : screen.kind === "search" ? "search" : undefined;

  let body: React.ReactNode;
  let hints: [string, string][];
  let left = "";

  if (screen.kind === "detail") {
    hints = [["↑↓", "스크롤"], ["space", "다음"], ["b", "이전"], ["esc", "뒤로"], ["q", "종료"]];
    const end = Math.min(detailLines.length, scroll + detailPage);
    const percent = detailLines.length ? Math.round((end / detailLines.length) * 100) : 100;
    left = `${end}/${detailLines.length}줄`;
    body = (
      <Panel title={screen.title} right={`${percent}%`} focused width={mainWidth} height={bodyHeight}>
        <Text color={C.muted} wrap="truncate-end">
          {truncate(screen.meta, detailPanel.width)}
        </Text>
        <Text color={C.border}>{"─".repeat(detailPanel.width)}</Text>
        {detailLines.slice(scroll, scroll + detailPage).map((line, i) =>
          /^## /.test(line) ? (
            <Text key={i} color={C.focus} bold>
              {line.replace(/^## /, "▍")}
            </Text>
          ) : (
            <Text key={i} color={C.fg}>
              {line || " "}
            </Text>
          ),
        )}
      </Panel>
    );
  } else if (screen.kind === "dashboard") {
    hints = [["←↑↓→", "이동"], ["enter", "열기"], ["s", "동기화"], ["t", "할 일"], ["/", "검색"], ["r", "새로고침"], ["q", "종료"]];
    left = `과목 ${courseList.length}개`;
    const visibleRows = Math.max(1, Math.floor((bodyHeight - 1) / CARD_HEIGHT));
    const cursorRow = Math.floor(cursor / grid.perRow);
    const firstRow = Math.max(0, cursorRow - visibleRows + 1);
    const cardRows: Course[][] = [];
    for (let i = 0; i < courseList.length; i += grid.perRow) {
      cardRows.push(courseList.slice(i, i + grid.perRow));
    }
    const soon = upcoming.data ?? [];
    const sidebarInner = panelInner(grid.sidebar, bodyHeight);
    const todoFit = Math.max(1, Math.floor((sidebarInner.height + 1) / 4));
    body = (
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          {courses.loading && <Text color={C.muted}>과목 불러오는 중…</Text>}
          {courses.error && <Tag text={`[ ERR ] ${courses.error}`} color={C.err} />}
          {cardRows.slice(firstRow, firstRow + visibleRows).map((row, r) => (
            <Box key={firstRow + r} flexDirection="row">
              {row.map((c, i) => {
                const index = (firstRow + r) * grid.perRow + i;
                return (
                  <Box key={c.id} marginRight={i < row.length - 1 ? 1 : 0}>
                    <CourseCard course={c} color={colorOf(c.id)} width={grid.cardWidth} selected={index === cursor} materials={materialStats.get(c.id) ?? { ok: 0, total: 0 }} />
                  </Box>
                );
              })}
            </Box>
          ))}
          {cardRows.length > visibleRows && (
            <Text color={C.muted}>
              {"  "}
              {firstRow + 1}–{Math.min(cardRows.length, firstRow + visibleRows)}/{cardRows.length}줄 · ↑↓로 더 보기
            </Text>
          )}
        </Box>
        {grid.sidebar > 0 && (
          <Box marginLeft={1}>
            <Panel title={`${I.todo} 할 일`} hotkey="t" right={`${soon.length}개`} width={grid.sidebar} height={bodyHeight}>
              {upcoming.loading && <Text color={C.muted}>불러오는 중…</Text>}
              {upcoming.error && <Text color={C.err}>{truncate(upcoming.error, sidebarInner.width)}</Text>}
              {!upcoming.loading && soon.length === 0 && <Text color={C.muted}>2주 안에 마감되는 과제가 없습니다.</Text>}
              {soon.slice(0, todoFit).map((a) => {
                const due = dueLabel(a.dueAt);
                const tagWidth = due.tag ? displayWidth(due.tag) + 1 : 0;
                return (
                  <Box key={a.id} flexDirection="column" marginBottom={1}>
                    <Text wrap="truncate-end">
                      <Text color={colorOf(a.courseId)}>{I.bullet} </Text>
                      <Text color={C.fgBright} bold>
                        {truncate(a.name, sidebarInner.width - 2)}
                      </Text>
                    </Text>
                    <Text color={C.muted} wrap="truncate-end">
                      {"  "}
                      {truncate(`${a.courseName ? splitCourseName(a.courseName).title : ""} · ${a.points}점`, sidebarInner.width - 2)}
                    </Text>
                    <Text wrap="truncate-end">
                      {"  "}
                      <Text color={due.color}>{truncate(due.text, sidebarInner.width - 2 - tagWidth)}</Text>
                      {due.tag && <Tag text={` ${due.tag}`} color={due.color} />}
                    </Text>
                  </Box>
                );
              })}
              {soon.length > todoFit && <Text color={C.muted}>…외 {soon.length - todoFit}개 · [t] 전체 보기</Text>}
            </Panel>
          </Box>
        )}
      </Box>
    );
  } else if (screen.kind === "course") {
    hints = [["↑↓", "이동"], ["enter", "열기"], ["tab", "메뉴"], ["s", "동기화"], ["r", "새로고침"], ["/", "검색"], ["esc", "대시보드"], ["q", "종료"]];
    const tabIndex = TABS.findIndex((t) => t.key === screen.tab);
    const panelHeight = bodyHeight - 2;
    const inner = panelInner(mainWidth, panelHeight);
    let summary = items.length ? `${items.length}개` : "";
    if (screen.tab === "materials" && courseData.data) {
      const m = courseData.data as Materials;
      summary = `파일 ${m.files.length} · OK ${m.files.filter((f) => f.textStatus === "ok").length} · LX ${m.links.length}`;
    }
    left = `${splitCourseName(screen.course.name).section || screen.course.term} · ${items.length}개 항목`;
    body = (
      <Box flexDirection="column">
        <Tabs tabs={TABS.map((t) => tabTitle(t.key))} active={tabIndex} />
        <Text> </Text>
        <Panel title={tabTitle(screen.tab)} hotkey={String(tabIndex + 1)} right={summary} focused width={mainWidth} height={panelHeight}>
          {courseData.loading && <Text color={C.muted}>불러오는 중…</Text>}
          {courseData.error && <Text color={C.err}>[ ERR ] {truncate(courseData.error, inner.width - 8)}</Text>}
          {!courseData.loading && !courseData.error && (
            <RowList
              rows={items}
              cursor={cursor}
              height={inner.height}
              width={inner.width}
              empty={screen.tab === "materials" ? "등록된 강의자료가 없습니다. `openlms sync --learningx`로 LearningX 자료를 받을 수 있습니다." : "항목이 없습니다."}
            />
          )}
        </Panel>
      </Box>
    );
  } else if (screen.kind === "todo") {
    hints = [["↑↓", "이동"], ["enter", "열기"], ["s", "동기화"], ["r", "새로고침"], ["d", "대시보드"], ["/", "검색"], ["q", "종료"]];
    left = `2주 안에 마감 ${items.length}개`;
    const inner = panelInner(mainWidth, bodyHeight);
    body = (
      <Panel title={`${I.todo} 할 일`} hotkey="t" right={`${items.length}개`} focused width={mainWidth} height={bodyHeight}>
        {upcoming.loading && <Text color={C.muted}>불러오는 중…</Text>}
        {upcoming.error && <Text color={C.err}>[ ERR ] {upcoming.error}</Text>}
        {!upcoming.loading && <RowList rows={items} cursor={cursor} height={inner.height} width={inner.width} empty="2주 안에 마감되는 과제가 없습니다." />}
      </Panel>
    );
  } else {
    hints = screen.editing ? [["enter", "검색"], ["esc", "취소"]] : [["↑↓", "이동"], ["enter", "열기"], ["/", "새 검색"], ["esc", "대시보드"], ["q", "종료"]];
    left = screen.editing ? "검색어 입력" : `검색 결과 ${items.length}건`;
    const resultsHeight = bodyHeight - 3;
    const inner = panelInner(mainWidth, resultsHeight);
    body = (
      <Box flexDirection="column">
        <Panel title={`${I.search} 검색`} hotkey="/" focused={screen.editing} width={mainWidth} height={3}>
          <Text>
            <Text color={C.focus} bold>
              {">"}{" "}
            </Text>
            <Text color={C.fgBright}>{screen.query}</Text>
            {screen.editing && <Text color={C.select}>█</Text>}
            {screen.editing && !screen.query && <Text color={C.muted}> 강의자료 내용 검색 (예: 정규화, 페이지 교체)</Text>}
          </Text>
        </Panel>
        {!screen.editing && (
          <Panel title="결과" right={`${items.length}건`} focused width={mainWidth} height={resultsHeight}>
            <RowList rows={items} cursor={cursor} height={inner.height} width={inner.width} empty="검색 결과가 없습니다." />
          </Panel>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" height={totalHeight}>
      <GlobalNav brand={theme.brand} active={navActive} height={totalHeight} />
      <Box flexDirection="column" marginLeft={1} width={mainWidth + 1}>
        <Header parts={crumbs(screen)} width={mainWidth} status={syncing ? { tag: "[ .. ]", color: C.info, text: "동기화 중" } : syncStatus(lastSync)} />
        <Box flexDirection="column" height={bodyHeight} overflow="hidden">
          {body}
        </Box>
        <StatusBar left={left} hints={hints} message={status || (syncing ? `동기화 중 · ${syncing}` : "")} width={mainWidth} />
      </Box>
    </Box>
  );
}
