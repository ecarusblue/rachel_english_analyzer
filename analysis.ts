// 분석 결과 저장/조회 MCP 도구
//  - 조회 도구: 모든 토큰에서 사용 가능
//  - 저장 도구: ADMIN_TOKEN / ANALYST_TOKEN 만 사용 가능

import type { Role } from "./auth";

export interface DbEnv {
  DB: D1Database;
}

export interface ToolResult {
  content: unknown[];
  isError: boolean;
}

class InputError extends Error {}

const DIFFICULTIES = ["상", "중", "하"];
const ERROR_TYPES = ["문법", "어휘", "철자", "구두점", "문장구조", "내용구성", "기타"];
const MAX_QUESTIONS = 200;
const MAX_ERRORS = 200;

// ---------- 입력 검증 ----------

function text(data: unknown, isError = false): ToolResult {
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: body }], isError };
}

function reqStr(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new InputError(`${name}은(는) 필수 문자열입니다`);
  const s = v.trim();
  if (s.length > max) throw new InputError(`${name}은(는) ${max}자 이하여야 합니다`);
  return s;
}

function optStr(v: unknown, name: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  return reqStr(v, name, max);
}

function optNum(v: unknown, name: string, min: number, max: number): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new InputError(`${name}은(는) ${min}~${max} 사이 숫자여야 합니다`);
  }
  return v;
}

function asObject(v: unknown, name: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new InputError(`${name}은(는) 객체여야 합니다`);
  }
  return v as Record<string, unknown>;
}

async function getFile(env: DbEnv, id: string, category: "exam" | "writing") {
  const f = await env.DB.prepare("SELECT id, category, student_id FROM files WHERE id = ?")
    .bind(id)
    .first<{ id: string; category: string; student_id: string | null }>();
  if (!f) throw new InputError("파일을 찾을 수 없습니다");
  if (f.category !== category) {
    throw new InputError(`${category === "exam" ? "시험지(exam)" : "라이팅(writing)"} 파일이 아닙니다`);
  }
  return f;
}

// ---------- 저장 ----------

async function saveExamAnalysis(env: DbEnv, args: Record<string, unknown>) {
  const fileId = reqStr(args.file_id, "file_id", 64);
  await getFile(env, fileId, "exam");

  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) {
    throw new InputError(`questions는 1~${MAX_QUESTIONS}개의 배열이어야 합니다`);
  }
  const seen = new Set<number>();
  const rows = raw.map((item, i) => {
    const q = asObject(item, `questions[${i}]`);
    const qNo = q.q_no;
    if (typeof qNo !== "number" || !Number.isInteger(qNo) || qNo < 1 || qNo > 300) {
      throw new InputError(`questions[${i}].q_no는 1~300 정수여야 합니다`);
    }
    if (seen.has(qNo)) throw new InputError(`문항 번호가 중복됩니다: ${qNo}`);
    seen.add(qNo);
    const difficulty = optStr(q.difficulty, `questions[${i}].difficulty`, 5);
    if (difficulty && !DIFFICULTIES.includes(difficulty)) {
      throw new InputError(`questions[${i}].difficulty는 상/중/하 중 하나여야 합니다`);
    }
    return {
      q_no: qNo,
      q_type: reqStr(q.q_type, `questions[${i}].q_type`, 30),
      topic: optStr(q.topic, `questions[${i}].topic`, 60),
      difficulty,
      points: optNum(q.points, `questions[${i}].points`, 0, 100),
      note: optStr(q.note, `questions[${i}].note`, 300),
    };
  });
  const summary = optStr(args.summary, "summary", 2000);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM exam_questions WHERE file_id = ?").bind(fileId),
    env.DB.prepare("DELETE FROM exam_analyses WHERE file_id = ?").bind(fileId),
    env.DB.prepare(
      "INSERT INTO exam_analyses (file_id, summary, question_count) VALUES (?, ?, ?)",
    ).bind(fileId, summary, rows.length),
    env.DB.prepare(
      `INSERT INTO exam_questions (file_id, q_no, q_type, topic, difficulty, points, note)
       SELECT ?, json_extract(value, '$.q_no'), json_extract(value, '$.q_type'),
              json_extract(value, '$.topic'), json_extract(value, '$.difficulty'),
              json_extract(value, '$.points'), json_extract(value, '$.note')
       FROM json_each(?)`,
    ).bind(fileId, JSON.stringify(rows)),
  ]);
  return { file_id: fileId, saved_questions: rows.length };
}

async function saveWritingFeedback(env: DbEnv, args: Record<string, unknown>) {
  const fileId = reqStr(args.file_id, "file_id", 64);
  const file = await getFile(env, fileId, "writing");

  const summary = reqStr(args.summary, "summary", 2000);
  const strengths = optStr(args.strengths, "strengths", 2000);
  const score = optNum(args.score, "score", 0, 100);

  const raw = args.errors ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_ERRORS) {
    throw new InputError(`errors는 최대 ${MAX_ERRORS}개의 배열이어야 합니다`);
  }
  const errors = raw.map((item, i) => {
    const e = asObject(item, `errors[${i}]`);
    const errorType = reqStr(e.error_type, `errors[${i}].error_type`, 20);
    if (!ERROR_TYPES.includes(errorType)) {
      throw new InputError(`errors[${i}].error_type은 ${ERROR_TYPES.join("/")} 중 하나여야 합니다`);
    }
    return {
      error_type: errorType,
      subtype: optStr(e.subtype, `errors[${i}].subtype`, 30),
      original: optStr(e.original, `errors[${i}].original`, 500),
      corrected: optStr(e.corrected, `errors[${i}].corrected`, 500),
      explanation: optStr(e.explanation, `errors[${i}].explanation`, 500),
    };
  });

  const id = crypto.randomUUID();
  const stmts = [
    env.DB.prepare(
      "DELETE FROM writing_errors WHERE feedback_id IN (SELECT id FROM writing_feedbacks WHERE file_id = ?)",
    ).bind(fileId),
    env.DB.prepare("DELETE FROM writing_feedbacks WHERE file_id = ?").bind(fileId),
    env.DB.prepare(
      "INSERT INTO writing_feedbacks (id, file_id, student_id, score, summary, strengths) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, fileId, file.student_id, score, summary, strengths),
  ];
  if (errors.length) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO writing_errors (feedback_id, error_type, subtype, original, corrected, explanation)
         SELECT ?, json_extract(value, '$.error_type'), json_extract(value, '$.subtype'),
                json_extract(value, '$.original'), json_extract(value, '$.corrected'),
                json_extract(value, '$.explanation')
         FROM json_each(?)`,
      ).bind(id, JSON.stringify(errors)),
    );
  }
  await env.DB.batch(stmts);
  return { file_id: fileId, student_id: file.student_id, saved_errors: errors.length };
}

// ---------- 조회 ----------

type Row = Record<string, unknown>;

async function getExamAnalysis(env: DbEnv, args: Record<string, unknown>) {
  const fileId = reqStr(args.file_id, "file_id", 64);
  const [head, qs] = await env.DB.batch<Row>([
    env.DB.prepare(
      `SELECT f.original_name, f.school, f.grade, f.year, f.term, f.exam_type,
              a.summary, a.question_count, a.updated_at
       FROM exam_analyses a JOIN files f ON f.id = a.file_id WHERE a.file_id = ?`,
    ).bind(fileId),
    env.DB.prepare(
      "SELECT q_no, q_type, topic, difficulty, points, note FROM exam_questions WHERE file_id = ? ORDER BY q_no",
    ).bind(fileId),
  ]);
  if (!head.results.length) throw new InputError("이 파일의 분석 결과가 없습니다");
  return { ...head.results[0], questions: qs.results };
}

async function getWritingFeedback(env: DbEnv, args: Record<string, unknown>) {
  const fileId = reqStr(args.file_id, "file_id", 64);
  const fb = await env.DB.prepare(
    `SELECT w.id, w.student_id, w.score, w.summary, w.strengths, w.created_at, f.assignment
     FROM writing_feedbacks w JOIN files f ON f.id = w.file_id WHERE w.file_id = ?`,
  )
    .bind(fileId)
    .first<Row>();
  if (!fb) throw new InputError("이 파일의 첨삭 결과가 없습니다");
  const { results } = await env.DB.prepare(
    "SELECT error_type, subtype, original, corrected, explanation FROM writing_errors WHERE feedback_id = ? ORDER BY id",
  )
    .bind(fb.id)
    .all<Row>();
  const { id: _id, ...rest } = fb;
  return { ...rest, errors: results };
}

async function examTrends(env: DbEnv, args: Record<string, unknown>) {
  const where = ["f.category = 'exam'"];
  const binds: (string | number)[] = [];
  for (const col of ["school", "grade", "term", "exam_type"] as const) {
    const v = optStr(args[col], col, 60);
    if (v) {
      where.push(`f.${col} = ?`);
      binds.push(v);
    }
  }
  const from = optNum(args.year_from, "year_from", 2000, 2100);
  const to = optNum(args.year_to, "year_to", 2000, 2100);
  if (from !== null) { where.push("f.year >= ?"); binds.push(from); }
  if (to !== null) { where.push("f.year <= ?"); binds.push(to); }

  const w = where.join(" AND ");
  const base = `FROM exam_questions q JOIN files f ON f.id = q.file_id WHERE ${w}`;
  const [files, totals, byType, byTopic, byDifficulty, byYear] = await env.DB.batch<Row>([
    env.DB.prepare(`SELECT COUNT(*) AS total_exam_files FROM files f WHERE ${w}`).bind(...binds),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT f.id) AS analyzed_exams, COUNT(*) AS questions,
              COALESCE(SUM(q.points), 0) AS total_points ${base}`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT q.q_type, COUNT(*) AS count, COALESCE(SUM(q.points), 0) AS points ${base}
       GROUP BY q.q_type ORDER BY count DESC`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT q.topic, COUNT(*) AS count ${base} AND q.topic IS NOT NULL
       GROUP BY q.topic ORDER BY count DESC LIMIT 30`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT q.difficulty, COUNT(*) AS count ${base} AND q.difficulty IS NOT NULL
       GROUP BY q.difficulty ORDER BY count DESC`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT f.year, q.q_type, COUNT(*) AS count ${base}
       GROUP BY f.year, q.q_type ORDER BY f.year, count DESC`,
    ).bind(...binds),
  ]);
  return {
    ...files.results[0],
    ...totals.results[0],
    by_type: byType.results,
    by_topic: byTopic.results,
    by_difficulty: byDifficulty.results,
    by_year_and_type: byYear.results,
  };
}

async function studentErrorSummary(env: DbEnv, args: Record<string, unknown>) {
  const sid = reqStr(args.student_id, "student_id", 60);
  const [overall, byError, recent, examples] = await env.DB.batch<Row>([
    env.DB.prepare(
      "SELECT COUNT(*) AS feedbacks, AVG(score) AS avg_score FROM writing_feedbacks WHERE student_id = ?",
    ).bind(sid),
    env.DB.prepare(
      `SELECT e.error_type, e.subtype, COUNT(*) AS count
       FROM writing_errors e JOIN writing_feedbacks w ON w.id = e.feedback_id
       WHERE w.student_id = ? GROUP BY e.error_type, e.subtype ORDER BY count DESC LIMIT 20`,
    ).bind(sid),
    env.DB.prepare(
      `SELECT w.file_id, f.assignment, w.score, w.created_at
       FROM writing_feedbacks w JOIN files f ON f.id = w.file_id
       WHERE w.student_id = ? ORDER BY w.created_at DESC LIMIT 5`,
    ).bind(sid),
    env.DB.prepare(
      `SELECT e.error_type, e.subtype, e.original, e.corrected
       FROM writing_errors e JOIN writing_feedbacks w ON w.id = e.feedback_id
       WHERE w.student_id = ? ORDER BY e.id DESC LIMIT 10`,
    ).bind(sid),
  ]);
  if (!overall.results[0] || Number(overall.results[0].feedbacks) === 0) {
    throw new InputError("이 학생의 첨삭 결과가 없습니다");
  }
  return {
    student_id: sid,
    ...overall.results[0],
    error_counts: byError.results,
    recent_feedbacks: recent.results,
    recent_error_examples: examples.results,
  };
}

async function getVocabulary(env: DbEnv) {
  const [types, topics, errs] = await env.DB.batch<Row>([
    env.DB.prepare(
      "SELECT q_type AS name, COUNT(*) AS count FROM exam_questions GROUP BY q_type ORDER BY count DESC LIMIT 50",
    ),
    env.DB.prepare(
      `SELECT topic AS name, COUNT(*) AS count FROM exam_questions WHERE topic IS NOT NULL
       GROUP BY topic ORDER BY count DESC LIMIT 50`,
    ),
    env.DB.prepare(
      `SELECT error_type, subtype, COUNT(*) AS count FROM writing_errors
       GROUP BY error_type, subtype ORDER BY count DESC LIMIT 50`,
    ),
  ]);
  return {
    exam_q_types: types.results,
    exam_topics: topics.results,
    writing_error_subtypes: errs.results,
    difficulty_values: DIFFICULTIES,
    error_type_values: ERROR_TYPES,
  };
}

// ---------- MCP 도구 정의 ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: boolean;
}

const fileIdProp = { type: "string", description: "list_files에서 얻은 파일 id" };

const ANALYSIS_TOOLS: ToolDef[] = [
  {
    name: "get_vocabulary",
    description:
      "지금까지 저장된 분석에서 쓰인 문항 유형·단원·오류 하위유형 용어 목록입니다. 새 분석을 저장하기 전에 호출해, 이미 쓰인 용어를 재사용하면 통계가 깔끔해집니다.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_exam_analysis",
    description: "시험지 파일 한 건의 저장된 문항별 분석 결과를 조회합니다.",
    inputSchema: { type: "object", properties: { file_id: fileIdProp }, required: ["file_id"] },
  },
  {
    name: "exam_trends",
    description:
      "저장된 시험지 분석을 집계해 출제 경향(문항 유형·단원·난이도·연도별 변화)을 반환합니다. 필터는 모두 선택입니다. analyzed_exams가 total_exam_files보다 작으면 미분석 시험지가 있다는 뜻입니다.",
    inputSchema: {
      type: "object",
      properties: {
        school: { type: "string" },
        grade: { type: "string", description: "예: 중2" },
        term: { type: "string", description: "예: 1학기" },
        exam_type: { type: "string", description: "예: 중간고사" },
        year_from: { type: "number" },
        year_to: { type: "number" },
      },
    },
  },
  {
    name: "get_writing_feedback",
    description: "라이팅 파일 한 건의 저장된 첨삭 결과(총평, 오류 목록)를 조회합니다.",
    inputSchema: { type: "object", properties: { file_id: fileIdProp }, required: ["file_id"] },
  },
  {
    name: "student_error_summary",
    description:
      "학생 한 명의 누적 오류 유형·하위유형 통계, 최근 점수, 최근 오류 예시를 반환합니다. 약점 파악과 다음 수업 계획에 사용합니다.",
    inputSchema: {
      type: "object",
      properties: { student_id: { type: "string" } },
      required: ["student_id"],
    },
  },
  {
    name: "save_exam_analysis",
    description:
      "시험지 파일을 읽고 문항별로 분석한 결과를 저장합니다. 같은 file_id로 다시 저장하면 이전 분석을 대체합니다. 저장 전에 get_vocabulary로 기존 용어를 확인하고 같은 용어를 쓰세요. 문항 유형 예: 어법, 빈칸추론, 순서배열, 문장삽입, 주제·요지, 내용일치, 서술형.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        file_id: fileIdProp,
        summary: { type: "string", description: "시험 전체 특징 요약 (선택)" },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              q_no: { type: "integer", description: "문항 번호" },
              q_type: { type: "string", description: "문항 유형" },
              topic: { type: "string", description: "단원/문법 항목/지문 주제 (선택)" },
              difficulty: { type: "string", enum: DIFFICULTIES },
              points: { type: "number", description: "배점 (선택)" },
              note: { type: "string", description: "특이사항 (선택)" },
            },
            required: ["q_no", "q_type"],
          },
        },
      },
      required: ["file_id", "questions"],
    },
  },
  {
    name: "save_writing_feedback",
    description:
      "학생 라이팅을 첨삭한 결과를 저장합니다. 같은 file_id로 다시 저장하면 이전 결과를 대체합니다. 오류가 없으면 errors는 비워도 됩니다.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        file_id: fileIdProp,
        summary: { type: "string", description: "총평" },
        strengths: { type: "string", description: "잘한 점 (선택)" },
        score: { type: "number", description: "0~100 (선택)" },
        errors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              error_type: { type: "string", enum: ERROR_TYPES },
              subtype: { type: "string", description: "예: 시제, 수일치, 관사 (선택)" },
              original: { type: "string", description: "학생이 쓴 표현" },
              corrected: { type: "string", description: "수정안" },
              explanation: { type: "string", description: "설명" },
            },
            required: ["error_type"],
          },
        },
      },
      required: ["file_id", "summary"],
    },
  },
];

export function listAnalysisTools(role: Role) {
  return ANALYSIS_TOOLS.filter((t) => !t.write || role !== "reader").map(
    ({ write: _write, ...tool }) => tool,
  );
}

export async function callAnalysisTool(
  env: DbEnv,
  role: Role,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  const def = ANALYSIS_TOOLS.find((t) => t.name === name);
  if (!def) return null;
  if (def.write && role === "reader") {
    return text("쓰기 권한이 없습니다. ANALYST_TOKEN 또는 ADMIN_TOKEN으로 연결하세요", true);
  }
  try {
    switch (name) {
      case "get_vocabulary": return text(await getVocabulary(env));
      case "get_exam_analysis": return text(await getExamAnalysis(env, args));
      case "exam_trends": return text(await examTrends(env, args));
      case "get_writing_feedback": return text(await getWritingFeedback(env, args));
      case "student_error_summary": return text(await studentErrorSummary(env, args));
      case "save_exam_analysis": return text(await saveExamAnalysis(env, args));
      case "save_writing_feedback": return text(await saveWritingFeedback(env, args));
      default: return null;
    }
  } catch (err) {
    if (err instanceof InputError) return text(err.message, true);
    throw err;
  }
}
