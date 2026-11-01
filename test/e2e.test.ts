import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CredentialStore } from "../src/auth/credentials.js";
import { CanvasClient, CanvasError, nextLink } from "../src/canvas/client.js";
import { Lms } from "../src/lms.js";
import { createMcpServer } from "../src/mcp/server.js";
import { snippet } from "../src/store/store.js";
import { startFakeCanvas, TOKEN, type FakeCanvas } from "./fake-canvas.js";

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
});

describe("snippet", () => {
  it("marks the match and trims context", () => {
    assert.equal(snippet("가나다 라마바 사아자", "라마", 3), "…나다 «라마»바 사…");
  });
});
