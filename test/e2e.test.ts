import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CredentialStore } from "../src/auth/credentials.js";
import { CanvasClient, CanvasError, nextLink } from "../src/canvas/client.js";
import { parseLaunchForm } from "../src/learningx/learningx.js";
import { learningxFileId, Lms } from "../src/lms.js";
import { createMcpServer } from "../src/mcp/server.js";
import { snippet, Store } from "../src/store/store.js";
import { makeDocx, startFakeCanvas, TOKEN, type FakeCanvas } from "./fake-canvas.js";

const noSleep = { delayMs: 0, sleep: async () => {} };

function memoryCredentials(baseUrl: string): CredentialStore {
  return {
    save: async () => {},
    load: async () => ({ baseUrl, token: TOKEN }),
    clear: async () => {},
  };
}

describe("canvas client", () => {
  let canvas: FakeCanvas;
  before(async () => {
    canvas = await startFakeCanvas();
  });
  after(() => canvas.close());

  it("parses Link headers", () => {
    assert.equal(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=1>; rel="first"'), "https://x/a?page=2");
    assert.equal(nextLink('<https://x/a?page=1>; rel="first"'), undefined);
  });

  it("does not retry 401", async () => {
    const client = new CanvasClient(canvas.baseUrl, "wrong", noSleep);
    const before = canvas.requests.length;
    await assert.rejects(client.getJson("/api/v1/users/self"), (e: unknown) => e instanceof CanvasError && e.code === "unauthorized");
    assert.equal(canvas.requests.length - before, 1);
  });

  it("blocks grade/submission endpoints by default", async () => {
    const client = new CanvasClient(canvas.baseUrl, TOKEN, noSleep);
    await assert.rejects(client.getJson("/api/v1/courses/1/assignments/11/submissions/self"), (e: unknown) => e instanceof CanvasError && e.code === "blocked");
  });

  it("refuses to send the token to foreign hosts", () => {
    const client = new CanvasClient(canvas.baseUrl, TOKEN, noSleep);
    assert.throws(() => client.resolve("https://evil.example.com/api/v1/users/self"), /foreign host/);
  });

  it("stops when the rate-limit budget is low", async () => {
    canvas.setRateRemaining(5);
    try {
      const client = new CanvasClient(canvas.baseUrl, TOKEN, noSleep);
      await assert.rejects(client.getJson("/api/v1/users/self"), (e: unknown) => e instanceof CanvasError && e.code === "rate_limit_low");
    } finally {
      canvas.setRateRemaining(700);
    }
  });

  it("requires https for non-local hosts", () => {
    assert.throws(() => new CanvasClient("http://canvas.school.ac.kr", TOKEN), /https/);
  });
});

describe("sync, cache and MCP", () => {
  let canvas: FakeCanvas;
  let home: string;
  let lms: Lms;

  before(async () => {
    canvas = await startFakeCanvas();
    home = mkdtempSync(join(tmpdir(), "lms-test-"));
    lms = new Lms({ home, credentials: memoryCredentials(canvas.baseUrl), client: noSleep });
  });
  after(async () => {
    lms.close();
    await canvas.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("syncs files across pages and via the modules fallback", async () => {
    const report = await lms.sync();
    assert.deepEqual(report.errors, []);
    assert.equal(report.courses, 2);
    assert.equal(report.filesTotal, 4);
    assert.equal(report.downloaded, 4);
    assert.equal(report.indexed, 4);
    assert.equal(report.assignments, 4);
    assert.equal(report.announcements, 1);
    assert.deepEqual(lms.store.files(2).map((f) => f.name), ["자료구조_해시.docx"]);
  });

  it("runs one sync at a time and takes over a stale lock", async () => {
    const [first, second] = await Promise.allSettled([lms.sync({ metadataOnly: true }), lms.sync({ metadataOnly: true })]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    // A lock left by a process that no longer exists.
    writeFileSync(join(home, "sync.lock"), "999999");
    const report = await lms.sync({ metadataOnly: true });
    assert.deepEqual(report.errors, []);
    assert.equal(existsSync(join(home, "sync.lock")), false);
  });

  it("never forwards the token to the redirect host", () => {
    const cdn = canvas.requests.filter((r) => r.path.startsWith("/cdn/"));
    assert.equal(cdn.length, 4);
    for (const r of cdn) {
      assert.match(r.host ?? "", /^localhost:/);
      assert.equal(r.auth, undefined);
    }
  });

  it("uses per_page=100", () => {
    assert.ok(canvas.requests.some((r) => r.path.startsWith("/api/v1/courses/1/files?") && r.path.includes("per_page=100")));
  });

  it("is incremental", async () => {
    canvas.touch(102);
    const report = await lms.sync();
    assert.equal(report.downloaded, 1);
    assert.equal(report.skipped, 3);
  });

  it("extracts PPTX, DOCX and PDF text", async () => {
    const pptx = await lms.readMaterial(101);
    assert.match(pptx.text, /## Slide 2\n프로세스 스케줄링: 라운드 로빈/);
    assert.match((await lms.readMaterial(102)).text, /중간고사는 8주차/);
    assert.match((await lms.readMaterial(103)).text, /Virtual memory and paging/);
  });

  it("searches Korean substrings and short terms", () => {
    const hits = lms.search("스케줄");
    assert.equal(hits[0]?.fileId, 101);
    assert.match(hits[0]?.snippet ?? "", /«스케줄»/);
    assert.equal(lms.search("해시")[0]?.fileId, 201);
    assert.equal(lms.search("paging TLB")[0]?.fileId, 103);
    assert.equal(lms.search("스케줄", { courseId: 2 }).length, 0);
  });

  it("orders assignments by due date with undated last", () => {
    const names = lms.store.assignments({ courseId: 1 }).map((a) => a.name);
    assert.deepEqual(names, ["과제1: 스케줄러 구현", "기말 프로젝트", "출석"]);
    const upcoming = lms.store.assignments({ upcomingOnly: true, withinDays: 7 }).map((a) => a.id);
    assert.deepEqual(upcoming, [11]);
    assert.equal(lms.store.assignments({ courseId: 1 })[0]?.description, "라운드 로빈 스케줄러");
  });

  it("serves MCP tools from the cache", async () => {
    const server = createMcpServer(lms);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "get_announcements",
      "list_assignments",
      "list_board_posts",
      "list_courses",
      "list_materials",
      "read_material",
      "search_materials",
    ]);

    const apiCallsBefore = canvas.requests.length;
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { text: string }[])[0]!.text;

    const courses = JSON.parse(text(await client.callTool({ name: "list_courses", arguments: {} })));
    assert.equal(courses.length, 2);
    const search = JSON.parse(text(await client.callTool({ name: "search_materials", arguments: { query: "라운드 로빈" } })));
    assert.equal(search.results[0].fileId, 101);
    const read = text(await client.callTool({ name: "read_material", arguments: { file_id: 101, max_chars: 1000 } }));
    assert.match(read, /# 1주차_운영체제_개요\.pptx/);
    const due = JSON.parse(text(await client.callTool({ name: "list_assignments", arguments: { upcoming_only: true } })));
    assert.deepEqual(due.map((a: { id: number }) => a.id), [11, 12]);
    const news = JSON.parse(text(await client.callTool({ name: "get_announcements", arguments: {} })));
    assert.equal(news[0].title, "휴강 안내");
    const missing = await client.callTool({ name: "read_material", arguments: { file_id: 999999 } });
    assert.equal(missing.isError, true);

    // Everything above except the missing file was answered locally.
    const apiCalls = canvas.requests.slice(apiCallsBefore).map((r) => r.path);
    assert.ok(apiCalls.every((p) => p.startsWith("/api/v1/files/999999")), `unexpected API calls: ${apiCalls.join(", ")}`);
    await client.close();
  });

  it("lists LearningX items as links", async () => {
    assert.deepEqual(
      (await lms.links(2)).map((l) => [l.title, l.module]),
      [["3주차 강의자료", "1주차"]],
    );
    assert.deepEqual(await lms.links(1), []);
  });

  it("imports local files, keeps them across syncs, and removes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lms-import-"));
    try {
      mkdirSync(join(dir, "week3"));
      writeFileSync(join(dir, "week3", "트리_순회.docx"), makeDocx(["이진 트리 중위 순회와 후위 순회 비교"]));
      writeFileSync(join(dir, "week3", "video.mp4"), "not indexed");
      writeFileSync(join(dir, ".DS_Store"), "junk");

      const report = await lms.importFiles(2, [dir]);
      assert.equal(report.imported.length, 1);
      assert.deepEqual(report.skipped.map((s) => s.reason), ["unsupported file type"]);
      const id = report.imported[0]!.id;
      assert.ok(id < 0);
      assert.equal(lms.search("중위 순회")[0]?.fileId, id);

      assert.equal((await lms.importFiles(2, [dir])).unchanged.length, 1);

      const report2 = await lms.sync({ courseId: 2 });
      assert.equal(report2.removed, 0);
      assert.ok(lms.store.file(id), "imported file survives a Canvas refresh");

      const apiCallsBefore = canvas.requests.length;
      assert.match((await lms.readMaterial(id)).text, /후위 순회/);
      assert.equal(canvas.requests.length, apiCallsBefore, "reading an imported file never calls the API");

      await lms.removeImported(id);
      assert.equal(lms.store.file(id), undefined);
      assert.equal(lms.search("중위 순회").length, 0);
      await assert.rejects(lms.removeImported(101), /not an imported file/);
      await assert.rejects(lms.importFiles(999, [dir]), /not an active course/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns LearningX items from list_materials over MCP", async () => {
    const server = createMcpServer(lms);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "list_materials", arguments: { course_id: 2 } });
    const data = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.deepEqual(data.files.map((f: { name: string }) => f.name), ["자료구조_해시.docx"]);
    assert.equal(data.learningx[0].title, "3주차 강의자료");
    assert.match(data.note, /openlms import/);
    await client.close();
  });
});

describe("learningx", () => {
  let canvas: FakeCanvas;
  let home: string;
  let lms: Lms;

  before(async () => {
    canvas = await startFakeCanvas();
    home = mkdtempSync(join(tmpdir(), "lms-lx-"));
    lms = new Lms({ home, credentials: memoryCredentials(canvas.baseUrl), client: noSleep });
  });
  after(async () => {
    lms.close();
    await canvas.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("parses the LTI launch form", () => {
    const form = parseLaunchForm(`<form action="/search"><input name="q"></form>
      <form action='https://lms.example/learningx/lti/x?a=1&amp;b=2' method="post">
      <input type="hidden" name="oauth_signature" value="a&amp;b=" /><input name="user_id" value='7'></form>`);
    assert.equal(form.action, "https://lms.example/learningx/lti/x?a=1&b=2");
    assert.equal(form.fields.get("oauth_signature"), "a&b=");
    assert.equal(form.fields.get("user_id"), "7");
    assert.throws(() => parseLaunchForm("<form action='/x'></form>"), /launch form not found/);
  });

  it("is off unless --learningx is given", async () => {
    const report = await lms.sync({ courseId: 2 });
    assert.equal(report.learningx, 0);
    assert.ok(!canvas.requests.some((r) => r.path.startsWith("/learningx/") || r.path.includes("sessionless_launch")));
  });

  it("mirrors unlocked LearningX PDFs without sending the Canvas token", async () => {
    const start = canvas.requests.length;
    const report = await lms.sync({ learningx: true });
    assert.deepEqual(report.errors, []);
    assert.equal(report.learningx, 2);
    assert.deepEqual(
      lms.store.files(2).filter((f) => f.source === "learningx").map((f) => [f.id, f.name, f.textStatus]),
      [
        [learningxFileId(501), "4주차 해시 심화.pdf", "ok"],
        [learningxFileId(502), "5주차 해시 응용.pdf", "ok"],
      ],
    );
    assert.equal(lms.search("Bloom filter")[0]?.fileId, learningxFileId(501));
    assert.match((await lms.readMaterial(learningxFileId(502))).text, /Cuckoo hashing/);

    const offApi = canvas.requests.slice(start).filter((r) => /^\/(login|learningx|viewer|contents)\//.test(r.path));
    assert.ok(offApi.some((r) => r.path.startsWith("/learningx/api/v1/courses/2/modules")));
    for (const r of offApi) {
      assert.notEqual(r.auth, `Bearer ${TOKEN}`, `Canvas token sent to ${r.path}`);
    }
  });

  it("re-downloads changed items, drops removed ones, and keeps them across plain syncs", async () => {
    canvas.touchLearningX(502);
    canvas.removeLearningX(501);
    const report = await lms.sync({ courseId: 2, learningx: true });
    assert.deepEqual(report.errors, []);
    assert.equal(report.downloaded, 1);
    assert.equal(report.removed, 1);
    assert.equal(lms.store.file(learningxFileId(501)), undefined);
    assert.equal(lms.search("Bloom filter").length, 0);

    const plain = await lms.sync({ courseId: 2 });
    assert.equal(plain.removed, 0);
    assert.equal(lms.store.file(learningxFileId(502))?.source, "learningx");
  });

  it("mirrors board posts and indexes their attachments", async () => {
    const posts = lms.store.boardPosts({ courseId: 2 });
    assert.deepEqual(
      posts.map((p) => [p.board, p.title, p.isNotice, p.attachments.map((a) => a.fileId)]),
      [
        ["강의자료실", "시험 범위 안내", true, []],
        ["강의자료실", "6주차 트리 자료", false, [202]],
        ["Q&A 게시판", "해시 질문", false, [201]],
      ],
    );
    assert.match(posts[0]!.content, /중간고사는 트리까지/);
    const attached = lms.store.file(202);
    assert.equal(attached?.source, "board");
    assert.equal(attached?.module, "강의자료실");
    assert.equal(attached?.textStatus, "ok");
    assert.equal(lms.search("중위 순회")[0]?.fileId, 202);
    // A file the Canvas list already has stays a Canvas file.
    assert.equal(lms.store.file(201)?.source, "canvas");
    assert.ok(!canvas.requests.some((r) => r.path.startsWith("/learningx/") && r.auth === `Bearer ${TOKEN}`));
  });

  it("re-reads only changed posts and drops attachments of removed posts", async () => {
    const start = canvas.requests.length;
    const again = await lms.sync({ courseId: 2, learningx: true });
    assert.deepEqual(again.errors, []);
    assert.equal(again.boardPosts, 3);
    const detailCalls = canvas.requests.slice(start).filter((r) => /\/posts\/\d+$/.test(r.path));
    assert.deepEqual(detailCalls, []);
    assert.ok(!canvas.requests.slice(start).some((r) => r.path.startsWith("/cdn/202")));

    const plain = await lms.sync({ courseId: 2 });
    assert.equal(plain.removed, 0);
    assert.equal(lms.store.file(202)?.source, "board");

    canvas.removeBoardPost(802);
    const report = await lms.sync({ courseId: 2, learningx: true });
    assert.equal(report.boardPosts, 2);
    assert.equal(report.removed, 1);
    assert.equal(lms.store.file(202), undefined);
    assert.equal(lms.search("중위 순회").length, 0);
  });
});

describe("store migrations", () => {
  it("adds the source column to a 0.1.0 database", () => {
    const dir = mkdtempSync(join(tmpdir(), "lms-migrate-"));
    try {
      const path = join(dir, "lms.db");
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL, name TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '',
        local_path TEXT NOT NULL DEFAULT '', text_status TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL DEFAULT '');
        INSERT INTO files (id, course_id, name) VALUES (7, 1, 'old.pdf');`);
      old.close();
      const store = new Store(path);
      assert.equal(store.file(7)?.source, "canvas");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("snippet", () => {
  it("marks the match and trims context", () => {
    assert.equal(snippet("가나다 라마바 사아자", "라마", 3), "…나다 «라마»바 사…");
  });
});
