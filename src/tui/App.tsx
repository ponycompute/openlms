import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, formatDue, truncate } from "../cli/format.js";
import type { Lms } from "../lms.js";
import type { Announcement, Assignment, Course, FileRow, SearchHit } from "../store/store.js";

type Tab = "materials" | "assignments" | "announcements";
const TABS: { key: Tab; label: string }[] = [
  { key: "materials", label: "자료" },
  { key: "assignments", label: "과제" },
  { key: "announcements", label: "공지" },
];

type Screen =
  | { kind: "home" }
  | { kind: "course"; course: Course; tab: Tab }
  | { kind: "search"; query: string; editing: boolean }
  | { kind: "detail"; title: string; body: string; back: Screen };

interface ListItem {
  key: string;
  label: string;
  hint?: string;
  color?: string;
  open?: () => Promise<{ title: string; body: string }>;
  enter?: () => void;
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    fn().then(
      (data) => alive && setState({ data, loading: false }),
      (err: unknown) => alive && setState({ error: err instanceof Error ? err.message : String(err), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function dueColor(iso: string | null): string | undefined {
  if (!iso) {
    return undefined;
  }
  const hours = (new Date(iso).getTime() - Date.now()) / 3_600_000;
  if (hours < 0) {
    return "gray";
  }
  if (hours < 24) {
    return "red";
  }
  if (hours < 72) {
    return "yellow";
  }
  return undefined;
}

function SelectList({ items, height, cursor, width }: { items: ListItem[]; height: number; cursor: number; width: number }) {
  if (items.length === 0) {
    return <Text dimColor>  (비어 있음)</Text>;
  }
  const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), items.length - height));
  const visible = items.slice(start, start + height);
  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const selected = start + i === cursor;
        const hint = item.hint ? `  ${item.hint}` : "";
        return (
          <Text key={item.key} color={selected ? "cyan" : item.color} bold={selected}>
            {selected ? "› " : "  "}
            {truncate(item.label, Math.max(10, width - hint.length - 6))}
            <Text dimColor>{hint}</Text>
          </Text>
        );
      })}
      {items.length > height && <Text dimColor>  {cursor + 1}/{items.length}</Text>}
    </Box>
  );
}

function wrapLines(body: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    let line = "";
    let w = 0;
    for (const ch of raw) {
      const cw = (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
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

export function App({ lms }: { lms: Lms }) {
  const { exit } = useApp();
  const { stdout } = useStdout() as unknown as { stdout: NodeJS.WriteStream };
  const rows = stdout.rows || 30;
  const cols = stdout.columns || 80;
  const listHeight = Math.max(5, rows - 8);

  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [cursor, setCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [status, setStatus] = useState<string>("");

  const courses = useAsync(() => lms.courses(), []);
  const upcoming = useAsync(() => lms.assignments({ upcomingOnly: true, withinDays: 7 }), []);

  const courseData = useAsync<FileRow[] | Assignment[] | Announcement[] | undefined>(async () => {
    if (screen.kind !== "course") {
      return undefined;
    }
    const id = screen.course.id;
    if (screen.tab === "materials") {
      return lms.materials(id);
    }
    if (screen.tab === "assignments") {
      return lms.assignments({ courseId: id });
    }
    return lms.announcements({ courseId: id, limit: 100 });
  }, [screen.kind === "course" ? `${screen.course.id}:${screen.tab}` : "-"]);

  const [hits, setHits] = useState<SearchHit[]>([]);

  const go = (next: Screen) => {
    setScreen(next);
    setCursor(0);
    setScroll(0);
    setStatus("");
  };

  const openMaterial = async (id: number) => {
    const r = await lms.readMaterial(id, { maxChars: 2_000_000 });
    return { title: r.file.name, body: r.text || "(추출된 텍스트 없음)" };
  };

  const items: ListItem[] = useMemo(() => {
    if (screen.kind === "home") {
      return (courses.data ?? []).map((c) => ({
        key: `c${c.id}`,
        label: c.name,
        hint: [c.code, c.term].filter(Boolean).join(" · "),
        enter: () => go({ kind: "course", course: c, tab: "materials" }),
      }));
    }
    if (screen.kind === "search") {
      return hits.map((h) => ({
        key: `h${h.fileId}`,
        label: `${h.name} — ${h.courseName}`,
        hint: truncate(h.snippet, 60),
        open: () => openMaterial(h.fileId),
      }));
    }
    if (screen.kind === "course" && courseData.data) {
      if (screen.tab === "materials") {
        return (courseData.data as FileRow[]).map((f) => ({
          key: `f${f.id}`,
          label: f.name,
          hint: `${formatBytes(f.size)} · ${f.textStatus || "미동기화"}`,
          color: f.textStatus === "ok" ? undefined : "gray",
          open: () => openMaterial(f.id),
        }));
      }
      if (screen.tab === "assignments") {
        return (courseData.data as Assignment[]).map((a) => ({
          key: `a${a.id}`,
          label: a.name,
          hint: formatDue(a.dueAt),
          color: dueColor(a.dueAt),
          open: async () => ({
            title: a.name,
            body: `마감: ${formatDue(a.dueAt)}\n배점: ${a.points}\n${a.htmlUrl}\n\n${a.description || "(설명 없음)"}`,
          }),
        }));
      }
      return (courseData.data as Announcement[]).map((a) => ({
        key: `n${a.id}`,
        label: a.title,
        hint: a.postedAt ? new Date(a.postedAt).toLocaleDateString("ko-KR") : "",
        open: async () => ({
          title: a.title,
          body: `${a.author} · ${a.postedAt ? new Date(a.postedAt).toLocaleString("ko-KR") : ""}\n${a.htmlUrl}\n\n${a.message}`,
        }),
      }));
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, courses.data, courseData.data, hits]);

  const detailLines = useMemo(
    () => (screen.kind === "detail" ? wrapLines(screen.body, Math.max(20, cols - 4)) : []),
    [screen, cols],
  );

  useInput((input, key) => {
    if (screen.kind === "search" && screen.editing) {
      if (key.escape) {
        go({ kind: "home" });
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
      exit();
      return;
    }

    if (screen.kind === "detail") {
      const page = Math.max(1, rows - 6);
      const maxScroll = Math.max(0, detailLines.length - page);
      if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
      else if (key.downArrow || input === "j") setScroll((s) => Math.min(maxScroll, s + 1));
      else if (key.pageUp || input === "b") setScroll((s) => Math.max(0, s - page));
      else if (key.pageDown || input === " ") setScroll((s) => Math.min(maxScroll, s + page));
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
    if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(Math.max(0, items.length - 1), c + 1));
    else if (key.escape || key.backspace) go({ kind: "home" });
    else if (screen.kind === "course" && (key.tab || key.rightArrow || key.leftArrow)) {
      const i = TABS.findIndex((t) => t.key === screen.tab);
      const next = TABS[(i + (key.leftArrow || key.shift ? TABS.length - 1 : 1)) % TABS.length]!;
      go({ ...screen, tab: next.key });
    } else if (key.return) {
      const item = items[cursor];
      if (item?.enter) {
        item.enter();
      } else if (item?.open) {
        setStatus("불러오는 중…");
        item.open().then(
          (d) => {
            setStatus("");
            setScroll(0);
            setScreen({ kind: "detail", title: d.title, body: d.body, back: screen });
          },
          (err: unknown) => setStatus(`✗ ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  });

  const header = (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">LMS</Text>
      <Text dimColor>
        {"  "}
        {screen.kind === "home" && "과목"}
        {screen.kind === "course" && screen.course.name}
        {screen.kind === "search" && "검색"}
        {screen.kind === "detail" && truncate(screen.title, cols - 12)}
      </Text>
    </Box>
  );

  const help =
    screen.kind === "detail"
      ? "↑↓ 스크롤 · space/b 페이지 · esc 뒤로 · q 종료"
      : screen.kind === "search" && screen.editing
        ? "검색어 입력 후 enter · esc 취소"
        : screen.kind === "course"
          ? "↑↓ 이동 · enter 열기 · tab/←→ 탭 · / 검색 · esc 뒤로 · q 종료"
          : "↑↓ 이동 · enter 열기 · / 검색 · q 종료";

  let body: React.ReactNode;
  if (screen.kind === "detail") {
    const page = Math.max(1, rows - 6);
    body = (
      <Box flexDirection="column" paddingX={1}>
        {detailLines.slice(scroll, scroll + page).map((line, i) => (
          <Text key={i}>{line || " "}</Text>
        ))}
      </Box>
    );
  } else if (screen.kind === "home") {
    const soon = upcoming.data ?? [];
    body = (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginBottom={1}>
          <Text bold color="yellow">⏰ 7일 내 마감 과제 {soon.length}개</Text>
          {upcoming.loading && <Text dimColor>불러오는 중…</Text>}
          {upcoming.error && <Text color="red">{upcoming.error}</Text>}
          {soon.slice(0, 6).map((a) => (
            <Text key={a.id} color={dueColor(a.dueAt)}>
              {formatDue(a.dueAt)}  <Text bold>{truncate(a.name, 40)}</Text>  <Text dimColor>{a.courseName}</Text>
            </Text>
          ))}
          {soon.length > 6 && <Text dimColor>…외 {soon.length - 6}개</Text>}
        </Box>
        {courses.loading && <Text dimColor>과목 불러오는 중…</Text>}
        {courses.error && <Text color="red">✗ {courses.error}</Text>}
        <SelectList items={items} height={Math.max(3, listHeight - Math.min(soon.length, 6) - 4)} cursor={cursor} width={cols} />
      </Box>
    );
  } else if (screen.kind === "search") {
    body = (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">/ </Text>
          {screen.query}
          {screen.editing && <Text inverse> </Text>}
        </Text>
        {!screen.editing && <SelectList items={items} height={listHeight - 2} cursor={cursor} width={cols} />}
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          {TABS.map((t) => (
            <Text key={t.key} inverse={t.key === screen.tab} color={t.key === screen.tab ? "cyan" : undefined}>
              {` ${t.label} `}
            </Text>
          ))}
        </Box>
        {courseData.loading && <Text dimColor>불러오는 중…</Text>}
        {courseData.error && <Text color="red">✗ {courseData.error}</Text>}
        {!courseData.loading && <SelectList items={items} height={listHeight - 2} cursor={cursor} width={cols} />}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {header}
      {body}
      {status && <Text color={status.startsWith("✗") ? "red" : "gray"}>{status}</Text>}
      <Text dimColor>{help}</Text>
    </Box>
  );
}
