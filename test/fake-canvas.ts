// A tiny Canvas look-alike for tests. Files redirect to a "CDN" served on a
// different host name (localhost vs 127.0.0.1) so we can verify the token is
// never forwarded off the LMS host.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { strToU8, zipSync } from "fflate";

export const TOKEN = "test-token-123";

export function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`),
  });
}

export function makePptx(slides: string[][]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  slides.forEach((lines, i) => {
    const paras = lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("");
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<p:sld xmlns:a="a" xmlns:p="p"><p:txBody>${paras}</p:txBody></p:sld>`);
  });
  return zipSync(files);
}

export function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(pdf);
}

export interface FakeCanvas {
  baseUrl: string;
  requests: { path: string; auth?: string; host?: string }[];
  /** Files that changed: bump updated_at. */
  touch(fileId: number): void;
  setRateRemaining(n: number | undefined): void;
  /** LearningX PDF items: bump updated_at or remove one. */
  touchLearningX(itemId: number): void;
  removeLearningX(itemId: number): void;
  close(): Promise<void>;
}

export async function startFakeCanvas(): Promise<FakeCanvas> {
  const requests: FakeCanvas["requests"] = [];
  let rateRemaining: number | undefined = 700;
  const updated: Record<number, string> = { 101: "2026-09-01T00:00:00Z", 102: "2026-09-02T00:00:00Z", 103: "2026-09-03T00:00:00Z", 201: "2026-09-04T00:00:00Z" };
  const blobs: Record<number, { name: string; type: string; data: Uint8Array }> = {
    101: { name: "1주차_운영체제_개요.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", data: makePptx([["운영체제 개요"], ["프로세스 스케줄링: 라운드 로빈", "문맥 교환 비용"]]) },
    102: { name: "syllabus.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: makeDocx(["강의계획서", "중간고사는 8주차에 진행합니다."]) },
    103: { name: "lecture2.pdf", type: "application/pdf", data: makePdf("Virtual memory and paging with TLB lookups") },
    201: { name: "자료구조_해시.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: makeDocx(["해시 테이블 충돌 해결: 체이닝과 개방 주소법"]) },
  };

  let base = "";
  const LX_TOKEN = "lx-session-token";
  const lxPdfs: Record<string, Uint8Array> = {
    c501: makePdf("Bloom filter hashing with double hashing"),
    c502: makePdf("Cuckoo hashing and load factors"),
  };
  // LearningX module items of course 2: two PDFs, a locked PDF and a video.
  const lxItems = new Map<number, { title: string; content: string; type: string; updated: string; locked?: boolean }>([
    [501, { title: "4주차 해시 심화", content: "c501", type: "pdf", updated: "2026-09-10T00:00:00Z" }],
    [502, { title: "5주차 해시 응용", content: "c502", type: "pdf", updated: "2026-09-11T00:00:00Z" }],
    [503, { title: "6주차 잠김", content: "c503", type: "pdf", updated: "2026-09-12T00:00:00Z", locked: true }],
    [504, { title: "강의 영상", content: "c504", type: "movie", updated: "2026-09-12T00:00:00Z" }],
  ]);
  const fileJson = (id: number) => ({
    id,
    display_name: blobs[id]!.name,
    filename: blobs[id]!.name,
    "content-type": blobs[id]!.type,
    size: blobs[id]!.data.length,
    url: `${base}/files/${id}/download?verifier=abc`,
    updated_at: updated[id],
    // Instructors often hide files from the Files browser but link them.
    hidden_for_user: id === 103,
  });

  const json = (res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { "content-type": "application/json", ...headers };
    if (rateRemaining !== undefined) {
      h["x-rate-limit-remaining"] = String(rateRemaining);
    }
    res.writeHead(status, h);
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ path: url.pathname + url.search, auth: req.headers.authorization, host: req.headers.host });

    // ---- LearningX (never authenticated with the Canvas token) ----
    if (url.pathname === "/login/session_token") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><form action="${base}/learningx/lti/modulebuilder" method="POST" id="tool_form">
        <input type="hidden" name="oauth_consumer_key" value="xinics" />
        <input type="hidden" name="custom_canvas_course_id" value="2" />
        <input type="hidden" name="oauth_signature" value="sig&amp;=" />
        </form><script>document.getElementById("tool_form").submit()</script></body></html>`);
      return;
    }
    if (url.pathname === "/learningx/lti/modulebuilder" && req.method === "POST") {
      res.writeHead(302, { location: "/learningx/course/2", "set-cookie": [`xn_api_token=${encodeURIComponent(LX_TOKEN)}; Path=/`, "laravel_session=s1; Path=/"] });
      res.end();
      return;
    }
    if (url.pathname === "/learningx/course/2") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
      return;
    }
    if (url.pathname === "/learningx/api/v1/courses/2/modules") {
      if (req.headers.authorization !== `Bearer ${LX_TOKEN}`) {
        return json(res, 401, { message: "unauthenticated" });
      }
      return json(res, 200, [{ module_id: 1, title: "4주차", module_items: [...lxItems].map(([id, it]) => ({
        module_item_id: id,
        title: it.title,
        content_type: "attendance_item",
        content_data: {
          published: true,
          opened: !it.locked,
          updated_at: it.updated,
          item_content_data: { content_type: it.type, view_url: `${base}/em/${it.content}`, file_name: `${it.title}.pdf`, updated_at: it.updated },
        },
      })) }]);
    }
    if (url.pathname === "/viewer/ssplayer/uniplayer_support/content.php") {
      const id = url.searchParams.get("content_id");
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(`<?xml version="1.0"?><content><content_playing_info><content_id>${id}</content_id><content_type>sharedocs</content_type><content_uri><![CDATA[${base}/contents/knu/${id}/contents/web_files/]]></content_uri></content_playing_info></content>`);
      return;
    }
    const lxPdf = /^\/contents\/knu\/(\w+)\/contents\/web_files\/original\.pdf$/.exec(url.pathname);
    if (lxPdf && lxPdfs[lxPdf[1]!]) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(lxPdfs[lxPdf[1]!]);
      return;
    }

    if (url.pathname.startsWith("/cdn/")) {
      const id = Number(url.pathname.split("/")[2]);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(blobs[id]!.data);
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { errors: [{ message: "Invalid access token." }] }, { "www-authenticate": 'Bearer realm="canvas-lms"' });
      return;
    }
    const p = url.pathname;
    if (p === "/api/v1/users/self") {
      return json(res, 200, { id: 1, name: "홍길동", login_id: "20261234" });
    }
    if (p === "/api/v1/courses") {
      return json(res, 200, [
        { id: 1, name: "운영체제", course_code: "CSE301", term: { id: 1, name: "2026-2학기" } },
        { id: 2, name: "자료구조", course_code: "CSE201", term: { id: 1, name: "2026-2학기" } },
        { id: 3, access_restricted_by_date: true },
      ]);
    }
    if (p === "/api/v1/courses/1/files") {
      // Two pages to exercise Link-header pagination.
      if (url.searchParams.get("page") === "2") {
        return json(res, 200, [fileJson(103)]);
      }
      return json(res, 200, [fileJson(101), fileJson(102)], {
        link: `<${base}/api/v1/courses/1/files?page=2&per_page=100>; rel="next", <${base}/api/v1/courses/1/files?page=1&per_page=100>; rel="first"`,
      });
    }
    if (p === "/api/v1/courses/2/files") {
      // Real Canvas answers a hidden Files tab with 401 and no WWW-Authenticate.
      return json(res, 401, { status: "권한이 없음", errors: [{ message: "사용자에게 이 동작을 수행할 권한이 없음" }] });
    }
    if (p === "/api/v1/courses/1/tabs") {
      return json(res, 200, [{ id: "home", label: "홈" }, { id: "files", label: "파일" }]);
    }
    if (p === "/api/v1/courses/2/tabs") {
      return json(res, 200, [
        { id: "home", label: "홈" },
        { id: "context_external_tool_54", label: "출결체크", hidden: true },
        { id: "context_external_tool_46", label: "강의실" },
      ]);
    }
    if (p === "/api/v1/courses/2/external_tools/sessionless_launch") {
      if (url.searchParams.get("id") !== "46") {
        return json(res, 404, { errors: [{ message: "tool not found" }] });
      }
      return json(res, 200, { id: 46, name: "LearningX", url: `${base}/login/session_token?session_token=one-time` });
    }
    if (p === "/api/v1/courses/2/modules") {
      return json(res, 200, [{ id: 9, name: "1주차", items: [
        { id: 1, title: "해시", type: "File", content_id: 201 },
        { id: 2, title: "링크", type: "ExternalUrl" },
        { id: 3, title: "3주차 강의자료", type: "ExternalTool", html_url: `${base}/courses/2/modules/items/3` },
      ] }]);
    }
    const fileMatch = /^\/api\/v1\/(?:courses\/\d+\/)?files\/(\d+)$/.exec(p);
    if (fileMatch) {
      const id = Number(fileMatch[1]);
      return blobs[id] ? json(res, 200, fileJson(id)) : json(res, 404, { errors: [{ message: "not found" }] });
    }
    const download = /^\/files\/(\d+)\/download$/.exec(p);
    if (download) {
      // Redirect to a different host name, like Canvas → S3.
      res.writeHead(302, { location: `${base.replace("127.0.0.1", "localhost")}/cdn/${download[1]}` });
      res.end();
      return;
    }
    const assignments = /^\/api\/v1\/courses\/(\d+)\/assignments$/.exec(p);
    if (assignments) {
      const cid = Number(assignments[1]);
      const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const later = new Date(Date.now() + 20 * 86_400_000).toISOString();
      return json(res, 200, cid === 1
        ? [
            { id: 11, course_id: 1, name: "과제1: 스케줄러 구현", description: "<p>라운드 로빈 <b>스케줄러</b></p>", due_at: soon, points_possible: 10, html_url: `${base}/courses/1/assignments/11` },
            { id: 12, course_id: 1, name: "기말 프로젝트", description: null, due_at: later, points_possible: 30, html_url: `${base}/courses/1/assignments/12` },
            { id: 13, course_id: 1, name: "출석", description: null, due_at: null, points_possible: 0, html_url: `${base}/courses/1/assignments/13` },
          ]
        : [{ id: 21, course_id: 2, name: "해시 실습", description: "", due_at: new Date(Date.now() - 86_400_000).toISOString(), points_possible: 5, html_url: `${base}/courses/2/assignments/21` }]);
    }
    if (p === "/api/v1/announcements") {
      return json(res, 200, [
        { id: 31, title: "휴강 안내", message: "<p>10월 9일은 휴강입니다.</p>", posted_at: "2026-10-01T01:00:00Z", html_url: `${base}/courses/1/discussion_topics/31`, context_code: "course_1", author: { display_name: "김교수" } },
      ]);
    }
    json(res, 404, { errors: [{ message: "not found" }] });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl: base,
    requests,
    touch(fileId) {
      updated[fileId] = new Date().toISOString();
    },
    setRateRemaining(n) {
      rateRemaining = n;
    },
    touchLearningX(itemId) {
      lxItems.get(itemId)!.updated = new Date().toISOString();
    },
    removeLearningX(itemId) {
      lxItems.delete(itemId);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
