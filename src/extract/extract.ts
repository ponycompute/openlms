// Text extraction for course materials: PDF (unpdf/pdf.js), PPTX and DOCX
// (zip + OOXML text runs), plus plain-text formats.
import { extname } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

export type ExtractKind = "pdf" | "pptx" | "docx" | "text" | "html";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".py", ".c", ".cpp", ".h", ".java", ".js", ".ts", ".go", ".rs", ".sql", ".tex"]);

export function extractKind(name: string, contentType = ""): ExtractKind | undefined {
  const ext = extname(name).toLowerCase();
  if (ext === ".pdf" || contentType === "application/pdf") {
    return "pdf";
  }
  if (ext === ".pptx" || contentType.includes("presentationml")) {
    return "pptx";
  }
  if (ext === ".docx" || contentType.includes("wordprocessingml")) {
    return "docx";
  }
  if (ext === ".html" || ext === ".htm") {
    return "html";
  }
  if (TEXT_EXTENSIONS.has(ext) || contentType.startsWith("text/")) {
    return "text";
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Rough HTML → plain text for assignment descriptions and announcements. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) {
    return "";
  }
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, i, lines) => line !== "" || (i > 0 && lines[i - 1] !== ""))
    .join("\n")
    .trim();
}

function xmlRuns(xml: string, tag: "a:t" | "w:t"): string {
  const paragraphTag = tag === "a:t" ? "a:p" : "w:p";
  const paragraphs = xml.split(new RegExp(`</${paragraphTag}>`));
  const runRe = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const lines: string[] = [];
  for (const p of paragraphs) {
    let line = "";
    for (const m of p.matchAll(runRe)) {
      line += decodeEntities(m[1] ?? "");
    }
    if (line.trim()) {
      lines.push(line.trim());
    }
  }
  return lines.join("\n");
}

function numericSuffix(path: string): number {
  return Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);
}

function extractPptx(data: Uint8Array): string {
  const entries = unzipSync(data, {
    filter: (f) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(f.name),
  });
  const slides = Object.keys(entries)
    .filter((n) => n.startsWith("ppt/slides/"))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b));
  const parts: string[] = [];
  for (const slide of slides) {
    const n = numericSuffix(slide);
    const body = xmlRuns(strFromU8(entries[slide]!), "a:t");
    const notesXml = entries[`ppt/notesSlides/notesSlide${n}.xml`];
    const notes = notesXml ? xmlRuns(strFromU8(notesXml), "a:t") : "";
    let block = `## Slide ${n}\n${body}`;
    if (notes) {
      block += `\n[Notes] ${notes}`;
    }
    parts.push(block.trim());
  }
  return parts.join("\n\n");
}

function extractDocx(data: Uint8Array): string {
  const entries = unzipSync(data, { filter: (f) => f.name === "word/document.xml" });
  const xml = entries["word/document.xml"];
  return xml ? xmlRuns(strFromU8(xml), "w:t") : "";
}

async function extractPdf(data: Uint8Array): Promise<string> {
  // verbosity 0: only errors, not pdf.js font warnings on stdout.
  const pdf = await getDocumentProxy(data, { verbosity: 0 });
  try {
    const { text } = await extractPdfText(pdf, { mergePages: false });
    return text
      .map((page, i) => `## Page ${i + 1}\n${page.trim()}`)
      .join("\n\n");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Extracts plain text; throws on corrupt input. */
export async function extractText(kind: ExtractKind, data: Uint8Array): Promise<string> {
  switch (kind) {
    case "pdf":
      return extractPdf(data);
    case "pptx":
      return extractPptx(data);
    case "docx":
      return extractDocx(data);
    case "html":
      return htmlToText(new TextDecoder().decode(data));
    case "text":
      return new TextDecoder().decode(data);
  }
}

/** True when extracted text carries no real content (e.g. scanned PDF). */
export function isEffectivelyEmpty(text: string): boolean {
  return text.replace(/## (Page|Slide) \d+/g, "").replace(/\s+/g, "").length < 10;
}
