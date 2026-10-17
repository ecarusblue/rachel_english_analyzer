import { authenticate, type Role } from "./auth";
import { callAnalysisTool, listAnalysisTools } from "./analysis";

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  ADMIN_TOKEN: string;
  ANALYST_TOKEN?: string;
  READ_TOKEN: string;
  ALLOWED_ORIGIN?: string;
}

interface FileRow {
  id: string;
  category: "exam" | "writing";
  original_name: string;
  content_type: string;
  size: number;
  r2_key: string;
  extracted_text: string | null;
  school: string | null;
  grade: string | null;
  year: number | null;
  term: string | null;
  exam_type: string | null;
  student_id: string | null;
  assignment: string | null;
  note: string | null;
  created_at: string;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 업로드 상한 20MB
const MAX_INLINE_BYTES = 3 * 1024 * 1024; // MCP로 본문을 직접 돌려줄 상한 3MB
const CATEGORIES = ["exam", "writing"];
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ALLOWED_TYPES = new Set([
  "application/pdf",
  DOCX_MIME,
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
]);
const FILTER_COLUMNS = [
  "category",
  "school",
  "grade",
  "term",
  "exam_type",
  "student_id",
] as const;

// ---------- 공통 유틸 ----------

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(env: Env): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN ?? "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function guessType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return DOCX_MIME;
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function str(v: string | File | null): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ---------- 목록 / 조회 ----------

// 분석 결과(시험지 분석 또는 라이팅 첨삭)가 저장된 파일인지 여부
const ANALYZED_SQL = `(EXISTS (SELECT 1 FROM exam_analyses a WHERE a.file_id = files.id)
  OR EXISTS (SELECT 1 FROM writing_feedbacks w WHERE w.file_id = files.id))`;

async function listFiles(env: Env, q: URLSearchParams) {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  for (const col of FILTER_COLUMNS) {
    const v = q.get(col);
    if (v) {
      where.push(`${col} = ?`);
      binds.push(v);
    }
  }
  const year = q.get("year");
  if (year && !Number.isNaN(Number(year))) {
    where.push("year = ?");
    binds.push(Number(year));
  }
  const analyzed = q.get("analyzed");
  if (analyzed === "true" || analyzed === "false") {
    where.push(`${ANALYZED_SQL} = ?`);
    binds.push(analyzed === "true" ? 1 : 0);
  }
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 50) || 50, 1), 200);
  binds.push(limit);

  const sql = `SELECT id, category, original_name, content_type, size, school, grade,
      year, term, exam_type, student_id, assignment, note, created_at,
      (extracted_text IS NOT NULL) AS has_text, ${ANALYZED_SQL} AS analyzed
    FROM files
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results;
}

async function getRow(env: Env, id: string): Promise<FileRow | null> {
  return env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
}

// ---------- 업로드 / 삭제 ----------

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file 필드가 필요합니다" }, 400);
  if (file.size === 0) return json({ error: "빈 파일입니다" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: `파일이 너무 큽니다 (최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` }, 413);
  }

  const category = str(form.get("category"));
  if (!category || !CATEGORIES.includes(category)) {
    return json({ error: "category는 exam 또는 writing 이어야 합니다" }, 400);
  }

  const contentType = guessType(file);
  if (!ALLOWED_TYPES.has(contentType)) {
    return json({ error: `지원하지 않는 형식입니다: ${contentType}` }, 415);
  }

  const id = crypto.randomUUID();
  const r2Key = `${category}/${id}`;
  await env.BUCKET.put(r2Key, file, { httpMetadata: { contentType } });

  const yearRaw = str(form.get("year"));
  const year = yearRaw && !Number.isNaN(Number(yearRaw)) ? Number(yearRaw) : null;

  await env.DB.prepare(
    `INSERT INTO files (id, category, original_name, content_type, size, r2_key,
       extracted_text, school, grade, year, term, exam_type, student_id, assignment, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      category,
      file.name,
      contentType,
      file.size,
      r2Key,
      str(form.get("extracted_text")),
      str(form.get("school")),
      str(form.get("grade")),
      year,
      str(form.get("term")),
      str(form.get("exam_type")),
      str(form.get("student_id")),
      str(form.get("assignment")),
      str(form.get("note")),
    )
    .run();

  return json({ id, r2_key: r2Key }, 201);
}

async function handleDelete(env: Env, id: string): Promise<Response> {
  const row = await getRow(env, id);
  if (!row) return json({ error: "not found" }, 404);
  // 분석 결과까지 한 번에 지운 뒤 저장소 파일을 삭제 (DB가 실패하면 파일은 남음)
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM writing_errors WHERE feedback_id IN (SELECT id FROM writing_feedbacks WHERE file_id = ?)",
    ).bind(id),
    env.DB.prepare("DELETE FROM writing_feedbacks WHERE file_id = ?").bind(id),
    env.DB.prepare("DELETE FROM exam_questions WHERE file_id = ?").bind(id),
    env.DB.prepare("DELETE FROM exam_analyses WHERE file_id = ?").bind(id),
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id),
  ]);
  await env.BUCKET.delete(row.r2_key);
  return json({ deleted: id });
}

// ---------- 다운로드 / 내용 ----------

async function handleDownload(env: Env, row: FileRow): Promise<Response> {
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return json({ error: "저장소에 파일이 없습니다" }, 404);
  const encoded = encodeURIComponent(row.original_name);
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
    },
  });
}

async function handleContent(env: Env, row: FileRow): Promise<Response> {
  if (row.extracted_text) {
    return json({ id: row.id, name: row.original_name, text: row.extracted_text });
  }
  if (row.content_type === DOCX_MIME) {
    return json({ error: "추출된 텍스트가 없습니다. 업로드 시 extracted_text를 함께 보내세요" }, 422);
  }
  return handleDownload(env, row); // 이미지/PDF는 원본 바이트 그대로
}

// ---------- MCP (Streamable HTTP, JSON 응답) ----------

const MCP_TOOLS = [
  {
    name: "list_files",
    description:
      "업로드된 시험지(exam)/영어 라이팅(writing) 파일 목록을 조회합니다. 필터는 모두 선택입니다.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["exam", "writing"] },
        school: { type: "string" },
        grade: { type: "string" },
        year: { type: "number" },
        term: { type: "string", description: "예: 1학기" },
        exam_type: { type: "string", description: "예: 중간고사" },
        student_id: { type: "string" },
        analyzed: {
          type: "boolean",
          description: "true=분석/첨삭 결과가 저장된 파일만, false=아직 분석 전인 파일만",
        },
        limit: { type: "number", description: "기본 50, 최대 200" },
      },
    },
  },
  {
    name: "get_file",
    description:
      "파일 ID로 내용을 가져옵니다. 추출된 텍스트가 있으면 텍스트를, 없으면 이미지/PDF 원본을 돌려줍니다.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(env: Env, role: Role, name: string, args: Record<string, unknown>) {
  const analysisResult = await callAnalysisTool(env, role, name, args);
  if (analysisResult) return analysisResult;

  if (name === "list_files") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    }
    return toolText(JSON.stringify(await listFiles(env, q), null, 2));
  }

  if (name === "get_file") {
    const row = typeof args.id === "string" ? await getRow(env, args.id) : null;
    if (!row) return toolText("파일을 찾을 수 없습니다", true);

    if (row.extracted_text) {
      return toolText(`[${row.original_name}]\n\n${row.extracted_text}`);
    }
    if (row.content_type === DOCX_MIME) {
      return toolText("이 docx에는 추출된 텍스트가 없습니다", true);
    }
    if (row.size > MAX_INLINE_BYTES) {
      return toolText(
        `파일이 ${Math.round(row.size / 1024 / 1024)}MB로 너무 큽니다. 더 작게 줄여 다시 업로드하세요`,
        true,
      );
    }
    const obj = await env.BUCKET.get(row.r2_key);
    if (!obj) return toolText("저장소에 파일이 없습니다", true);
    const data = toBase64(await obj.arrayBuffer());

    if (row.content_type.startsWith("image/")) {
      return {
        content: [{ type: "image", data, mimeType: row.content_type }],
        isError: false,
      };
    }
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: `file://${row.id}/${encodeURIComponent(row.original_name)}`,
            mimeType: row.content_type,
            blob: data,
          },
        },
      ],
      isError: false,
    };
  }

  return toolText(`알 수 없는 도구: ${name}`, true);
}

async function handleMcp(request: Request, env: Env, role: Role): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notification

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "study-room-files", version: "0.1.0" },
      });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: [...MCP_TOOLS, ...listAnalysisTools(role)] });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      return rpcResult(msg.id, await callTool(env, role, name, args));
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---------- 라우팅 ----------

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/health") return json({ ok: true });

  const role: Role | null = await authenticate(request, env);
  if (!role) return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

  if (path === "/mcp") return handleMcp(request, env, role);

  if (path === "/files") {
    if (request.method === "GET") return json(await listFiles(env, url.searchParams));
    if (request.method === "POST") {
      if (role !== "admin") return json({ error: "forbidden" }, 403);
      return handleUpload(request, env);
    }
    return json({ error: "method not allowed" }, 405);
  }

  const m = path.match(/^\/files\/([\w-]+)(\/download|\/content)?$/);
  if (m) {
    const [, id, sub] = m;
    if (request.method === "DELETE" && !sub) {
      if (role !== "admin") return json({ error: "forbidden" }, 403);
      return handleDelete(env, id);
    }
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    const row = await getRow(env, id);
    if (!row) return json({ error: "not found" }, 404);
    if (sub === "/download") return handleDownload(env, row);
    if (sub === "/content") return handleContent(env, row);
    const { extracted_text, r2_key, ...meta } = row;
    return json({ ...meta, has_text: extracted_text !== null });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    let res: Response;
    try {
      res = await route(request, env);
    } catch (err) {
      console.error(err);
      res = json({ error: "internal error" }, 500);
    }
    const headers = new Headers(res.headers);
    cors.forEach((v, k) => headers.set(k, v));
    return new Response(res.body, { status: res.status, headers });
  },
} satisfies ExportedHandler<Env>;
