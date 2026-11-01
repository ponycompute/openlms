import { Command, InvalidArgumentError } from "commander";
import { KeychainCredentialStore, NotLoggedInError } from "./auth/credentials.js";
import { CanvasApi } from "./canvas/api.js";
import { CanvasClient, CanvasError, normalizeBaseUrl } from "./canvas/client.js";
import { formatBytes, formatDue, table } from "./cli/format.js";
import { ask, askSecret } from "./cli/prompt.js";
import { Lms, type LmsOptions } from "./lms.js";
import { VERSION } from "./version.js";

const program = new Command();

function intArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
}

function lmsOptions(): LmsOptions {
  const opts = program.opts<{ delay?: number; allowGrades?: boolean }>();
  return { client: { delayMs: opts.delay, allowGrades: opts.allowGrades } };
}

async function withLms<T>(fn: (lms: Lms) => Promise<T>, opts: LmsOptions = lmsOptions()): Promise<T> {
  const lms = new Lms(opts);
  try {
    return await fn(lms);
  } finally {
    lms.close();
  }
}

function print(json: boolean | undefined, data: unknown, render: () => string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${render()}\n`);
  }
}

program
  .name("lms")
  .description("OpenLMS — Canvas/LearningX LMS: local sync, search, TUI and MCP server")
  .version(VERSION)
  .option("--delay <ms>", "minimum delay between API requests", (v) => Number(v))
  .option("--allow-grades", "allow grade/submission endpoints (disabled by default)");

program
  .command("login")
  .description("store LMS base URL and personal access token in the OS keychain")
  .option("--url <baseUrl>", "LMS base URL, e.g. https://canvas.school.ac.kr")
  .action(async (opts: { url?: string }) => {
    const rawUrl = opts.url ?? (await ask("LMS base URL (예: https://canvas.ssu.ac.kr): "));
    const baseUrl = normalizeBaseUrl(rawUrl).toString().replace(/\/$/, "");
    process.stderr.write("Canvas → 계정 → 설정 → '새 액세스 토큰'에서 발급한 토큰을 붙여넣으세요.\n");
    const token = await askSecret("Access token: ");
    const api = new CanvasApi(new CanvasClient(baseUrl, token, { maxRetries: 1 }));
    const me = await api.self();
    await new KeychainCredentialStore().save({ baseUrl, token });
    process.stderr.write(`✓ ${me.name} (${me.login_id ?? me.id}) 로그인 완료. 자격 증명은 OS 키체인에 저장되었습니다.\n`);
  });

program
  .command("logout")
  .description("remove stored credentials from the OS keychain")
  .action(async () => {
    await new KeychainCredentialStore().clear();
    process.stderr.write("✓ 자격 증명을 삭제했습니다.\n");
  });

program
  .command("status")
  .description("show login state and local cache summary")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) =>
    withLms(async (lms) => {
      let baseUrl: string | undefined;
      try {
        baseUrl = (await new KeychainCredentialStore().load()).baseUrl;
      } catch (err) {
        if (!(err instanceof NotLoggedInError)) {
          throw err;
        }
      }
      const files = lms.store.files();
      const data = {
        loggedIn: Boolean(baseUrl),
        baseUrl,
        home: lms.home,
        lastSync: lms.store.meta("last_sync") ?? null,
        courses: lms.store.courses().length,
        files: files.length,
        indexed: files.filter((f) => f.textStatus === "ok").length,
      };
      print(opts.json, data, () =>
        [
          `로그인:      ${data.loggedIn ? `예 (${baseUrl})` : "아니오 — lms login"}`,
          `데이터 위치: ${data.home}`,
          `마지막 동기화: ${data.lastSync ?? "없음"}`,
          `과목 ${data.courses}개 · 파일 ${data.files}개 · 텍스트 인덱싱 ${data.indexed}개`,
        ].join("\n"),
      );
    }),
  );

program
  .command("sync")
  .description("incrementally download files of active courses, extract text and index it")
  .option("--course <id>", "only sync this course", intArg)
  .option("--metadata-only", "fetch file lists without downloading")
  .option("--max-size <MB>", "skip files larger than this", (v) => Number(v), 100)
  .option("--json", "output JSON report")
  .action((opts: { course?: number; metadataOnly?: boolean; maxSize: number; json?: boolean }) =>
    withLms(
      async (lms) => {
        const started = Date.now();
        const report = await lms.sync({
          courseId: opts.course,
          metadataOnly: opts.metadataOnly,
          onProgress: opts.json ? undefined : (m) => process.stderr.write(`${m}\n`),
        });
        print(opts.json, report, () => {
          const lines = [
            "",
            `✓ 동기화 완료 (${((Date.now() - started) / 1000).toFixed(1)}s)`,
            `  과목 ${report.courses} · 파일 ${report.filesTotal} (다운로드 ${report.downloaded}, 변경 없음 ${report.skipped}, 삭제 ${report.removed})`,
            `  텍스트 인덱싱 ${report.indexed} · 과제 ${report.assignments} · 공지 ${report.announcements}`,
          ];
          if (report.errors.length) {
            lines.push(`  ⚠ 오류 ${report.errors.length}건:`, ...report.errors.map((e) => `    - ${e}`));
          }
          return lines.join("\n");
        });
      },
      { ...lmsOptions(), maxFileBytes: opts.maxSize * 1024 * 1024 },
    ),
  );

program
  .command("courses")
  .description("list active courses")
  .option("--refresh", "refresh from the LMS")
  .option("--json", "output JSON")
  .action((opts: { refresh?: boolean; json?: boolean }) =>
    withLms(async (lms) => {
      const courses = await lms.courses({ refresh: opts.refresh });
      print(opts.json, courses, () => table(["ID", "과목", "코드", "학기"], courses.map((c) => [String(c.id), c.name, c.code, c.term])));
    }),
  );

program
  .command("files")
  .description("list course materials")
  .option("--course <id>", "course ID", intArg)
  .option("--refresh", "refresh the file list from the LMS")
  .option("--json", "output JSON")
  .action((opts: { course?: number; refresh?: boolean; json?: boolean }) =>
    withLms(async (lms) => {
      const files = opts.course ? await lms.materials(opts.course, { refresh: opts.refresh }) : lms.store.files();
      print(opts.json, files, () =>
        files.length === 0
          ? "파일이 없습니다. `lms sync`를 먼저 실행하세요."
          : table(
              ["ID", "과목", "파일", "크기", "텍스트"],
              files.map((f) => [String(f.id), f.courseName ?? "", f.name, formatBytes(f.size), f.textStatus || "pending"]),
            ),
      );
    }),
  );

program
  .command("assignments")
  .description("list assignments sorted by due date")
  .option("--course <id>", "course ID", intArg)
  .option("--upcoming", "only assignments not yet due")
  .option("--days <n>", "with --upcoming: due within n days", intArg)
  .option("--refresh", "refresh from the LMS")
  .option("--json", "output JSON")
  .action((opts: { course?: number; upcoming?: boolean; days?: number; refresh?: boolean; json?: boolean }) =>
    withLms(async (lms) => {
      const list = await lms.assignments(
        { courseId: opts.course, upcomingOnly: opts.upcoming || Boolean(opts.days), withinDays: opts.days },
        { refresh: opts.refresh },
      );
      print(opts.json, list, () =>
        table(
          ["마감", "과목", "과제", "배점"],
          list.map((a) => [formatDue(a.dueAt), a.courseName ?? "", a.name, String(a.points)]),
        ),
      );
    }),
  );

program
  .command("announcements")
  .description("list recent announcements")
  .option("--course <id>", "course ID", intArg)
  .option("--limit <n>", "max items", intArg, 20)
  .option("--refresh", "refresh from the LMS")
  .option("--json", "output JSON")
  .action((opts: { course?: number; limit: number; refresh?: boolean; json?: boolean }) =>
    withLms(async (lms) => {
      const list = await lms.announcements({ courseId: opts.course, limit: opts.limit, refresh: opts.refresh });
      print(opts.json, list, () =>
        list
          .map((a) => `■ ${a.title}\n  ${a.courseName} · ${a.postedAt ? new Date(a.postedAt).toLocaleString("ko-KR") : "-"} · ${a.author}\n  ${a.message.slice(0, 200).replace(/\n+/g, " ")}`)
          .join("\n\n") || "공지가 없습니다.",
      );
    }),
  );

program
  .command("search")
  .description("full-text search over the local material index")
  .argument("<query...>", "search terms")
  .option("--course <id>", "restrict to a course", intArg)
  .option("--limit <n>", "max results", intArg, 20)
  .option("--json", "output JSON")
  .action((terms: string[], opts: { course?: number; limit: number; json?: boolean }) =>
    withLms(async (lms) => {
      const hits = lms.search(terms.join(" "), { courseId: opts.course, limit: opts.limit });
      print(opts.json, hits, () =>
        hits.map((h) => `[${h.fileId}] ${h.name}  — ${h.courseName}\n    ${h.snippet}`).join("\n\n") || "결과가 없습니다.",
      );
    }),
  );

program
  .command("read")
  .description("print extracted text of a material (downloads on demand)")
  .argument("<fileId>", "file ID", intArg)
  .option("--offset <n>", "character offset", (v) => Number(v), 0)
  .option("--max-chars <n>", "max characters", (v) => Number(v), 1_000_000)
  .action((fileId: number, opts: { offset: number; maxChars: number }) =>
    withLms(async (lms) => {
      const result = await lms.readMaterial(fileId, { offset: opts.offset, maxChars: opts.maxChars });
      process.stdout.write(`${result.text}\n`);
    }),
  );

program
  .command("tui")
  .description("interactive terminal UI")
  .action(async () => {
    const { runTui } = await import("./tui/run.js");
    await runTui(lmsOptions());
  });

program
  .command("mcp")
  .description("run the MCP server over stdio")
  .action(async () => {
    const { runMcpServer } = await import("./mcp/server.js");
    await runMcpServer(lmsOptions());
  });

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`✗ ${msg}\n`);
  process.exitCode = err instanceof CanvasError && err.code === "unauthorized" ? 2 : 1;
});
