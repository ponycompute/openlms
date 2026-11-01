// stdio MCP server. Every tool is read-only and cache-first: the local
// SQLite cache answers when it can, the LMS API only fills gaps.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Lms, type LmsOptions } from "../lms.js";
import { VERSION } from "../version.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

export function createMcpServer(lms: Lms): McpServer {
  const server = new McpServer(
    { name: "openlms", title: "OpenLMS", version: VERSION },
    {
      instructions:
        "Tools for the student's Canvas/LearningX LMS. Use search_materials to find relevant lecture content, then read_material for the full text, and cite the file name. Data comes from a local cache; run `openlms sync` in a terminal for a full refresh. LearningX PDFs are indexed like other files when the user has run `openlms sync --learningx`; other LearningX items are listed by list_materials as links, and the user can download them and run `openlms import` to make them searchable.",
    },
  );

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description: "List the student's active courses (id, name, code, term).",
      inputSchema: { refresh: z.boolean().optional().describe("Force refresh from the LMS") },
      annotations: READ_ONLY,
    },
    ({ refresh }) => guard(async () => ok(await lms.courses({ refresh }))),
  );

  server.registerTool(
    "list_materials",
    {
      title: "List course materials",
      description:
        "List a course's files (with text-extraction status; use the id with read_material) and its LearningX items. Files with source learningx are LearningX PDFs and can be read normally. LearningX items cannot be read by this server: give the user the html_url to open in a browser, and tell them they can index LearningX PDFs with `openlms sync --learningx` or downloaded files with `openlms import <path> --course <id>`.",
      inputSchema: {
        course_id: z.number().int().describe("Course ID from list_courses"),
        refresh: z.boolean().optional().describe("Force refresh of the file list from the LMS"),
      },
      annotations: READ_ONLY,
    },
    ({ course_id, refresh }) =>
      guard(async () => {
        const files = await lms.materials(course_id, { refresh });
        const links = await lms.links(course_id);
        return ok({
          files: files.map(({ localPath: _localPath, ...f }) => f),
          learningx: links.map(({ courseId: _courseId, ...l }) => l),
          ...(links.length > 0
            ? {
                note: "learningx items are hosted in LearningX. Share html_url so the user can open them; LearningX PDFs can be indexed with `openlms sync --learningx`, other downloaded files with `openlms import <path> --course <id>`.",
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    "read_material",
    {
      title: "Read material text",
      description:
        "Return the extracted text of a course file (PDF/PPTX/DOCX/text). Long texts are paged: pass offset to continue where the previous call stopped.",
      inputSchema: {
        file_id: z.number().int().describe("File ID from list_materials or search_materials"),
        offset: z.number().int().min(0).optional().describe("Character offset (default 0)"),
        max_chars: z.number().int().min(1000).max(100_000).optional().describe("Max characters to return (default 20000)"),
      },
      annotations: READ_ONLY,
    },
    ({ file_id, offset, max_chars }) =>
      guard(async () => {
        const r = await lms.readMaterial(file_id, { offset, maxChars: max_chars });
        const header = [
          `# ${r.file.name}`,
          `course: ${r.file.courseName || r.file.courseId} · file_id: ${r.file.id} · chars ${r.offset}-${r.offset + r.text.length} of ${r.totalChars}`,
          r.truncated ? `(truncated — call again with offset=${r.offset + r.text.length})` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text", text: `${header}\n\n${r.text}` }] };
      }),
  );

  server.registerTool(
    "search_materials",
    {
      title: "Search materials",
      description:
        "Full-text search across synced lecture materials (substring matching, works for Korean). Returns file ids with highlighted snippets («…»).",
      inputSchema: {
        query: z.string().min(1).describe("Search terms; multiple terms are AND-ed"),
        course_id: z.number().int().optional().describe("Restrict to one course"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    ({ query, course_id, limit }) =>
      guard(() => {
        const hits = lms.search(query, { courseId: course_id, limit: limit ?? 10 });
        if (hits.length === 0 && lms.store.files().length === 0) {
          return ok({ results: [], note: "The local index is empty. Ask the user to run `openlms sync`." });
        }
        return ok({ results: hits });
      }),
  );

  server.registerTool(
    "list_assignments",
    {
      title: "List assignments",
      description: "List assignments sorted by due date (soonest first; undated last). Times are ISO-8601 UTC.",
      inputSchema: {
        course_id: z.number().int().optional().describe("Restrict to one course"),
        upcoming_only: z.boolean().optional().describe("Only assignments not yet due"),
        within_days: z.number().int().min(1).optional().describe("With upcoming_only: due within N days"),
        refresh: z.boolean().optional().describe("Force refresh from the LMS"),
      },
      annotations: READ_ONLY,
    },
    ({ course_id, upcoming_only, within_days, refresh }) =>
      guard(async () =>
        ok(
          await lms.assignments(
            { courseId: course_id, upcomingOnly: upcoming_only || Boolean(within_days), withinDays: within_days },
            { refresh },
          ),
        ),
      ),
  );

  server.registerTool(
    "get_announcements",
    {
      title: "Get announcements",
      description: "Recent course announcements, newest first.",
      inputSchema: {
        course_id: z.number().int().optional().describe("Restrict to one course"),
        limit: z.number().int().min(1).max(100).optional().describe("Max items (default 20)"),
        refresh: z.boolean().optional().describe("Force refresh from the LMS"),
      },
      annotations: READ_ONLY,
    },
    ({ course_id, limit, refresh }) => guard(async () => ok(await lms.announcements({ courseId: course_id, limit: limit ?? 20, refresh }))),
  );

  return server;
}

export async function runMcpServer(opts: LmsOptions = {}): Promise<void> {
  const lms = new Lms(opts);
  const server = createMcpServer(lms);
  const shutdown = async () => {
    await server.close();
    lms.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`OpenLMS ${VERSION} ready on stdio\n`);
}
