-- 시험지(exam)와 라이팅(writing) 파일을 한 테이블에서 관리합니다.
CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  category       TEXT NOT NULL CHECK (category IN ('exam', 'writing')),
  original_name  TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size           INTEGER NOT NULL,
  r2_key         TEXT NOT NULL,
  extracted_text TEXT,            -- docx 등에서 브라우저가 추출해 보낸 텍스트

  -- 시험지용
  school         TEXT,
  grade          TEXT,
  year           INTEGER,
  term           TEXT,            -- 예: 1학기
  exam_type      TEXT,            -- 예: 중간고사

  -- 라이팅용 (이름 대신 학생 ID 사용)
  student_id     TEXT,
  assignment     TEXT,

  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_category   ON files (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_exam       ON files (school, year, term);
CREATE INDEX IF NOT EXISTS idx_files_student    ON files (student_id, created_at DESC);

-- ==========================================================
-- 분석 결과 (Claude가 MCP 도구로 저장)
-- 같은 파일을 다시 분석해 저장하면 이전 결과를 대체합니다.
-- ==========================================================

-- 시험지: 파일 단위 요약
CREATE TABLE IF NOT EXISTS exam_analyses (
  file_id        TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  summary        TEXT,
  question_count INTEGER NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 시험지: 문항 단위 분석
CREATE TABLE IF NOT EXISTS exam_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  q_no       INTEGER NOT NULL,
  q_type     TEXT NOT NULL,                 -- 예: 어법, 빈칸추론, 순서배열
  topic      TEXT,                          -- 예: 관계대명사, 교과서 3과
  difficulty TEXT CHECK (difficulty IN ('상', '중', '하')),
  points     REAL,
  note       TEXT,
  UNIQUE (file_id, q_no)
);
CREATE INDEX IF NOT EXISTS idx_exam_questions_type  ON exam_questions (q_type);
CREATE INDEX IF NOT EXISTS idx_exam_questions_topic ON exam_questions (topic);

-- 라이팅: 첨삭 총평 (파일당 1건)
CREATE TABLE IF NOT EXISTS writing_feedbacks (
  id         TEXT PRIMARY KEY,
  file_id    TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  student_id TEXT,
  score      REAL,
  summary    TEXT,
  strengths  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_writing_feedbacks_student ON writing_feedbacks (student_id, created_at DESC);

-- 라이팅: 오류 항목
CREATE TABLE IF NOT EXISTS writing_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT NOT NULL REFERENCES writing_feedbacks(id) ON DELETE CASCADE,
  error_type  TEXT NOT NULL,                -- 문법, 어휘, 철자, 구두점, 문장구조, 내용구성, 기타
  subtype     TEXT,                         -- 예: 시제, 수일치, 관사
  original    TEXT,
  corrected   TEXT,
  explanation TEXT
);
CREATE INDEX IF NOT EXISTS idx_writing_errors_feedback ON writing_errors (feedback_id);
CREATE INDEX IF NOT EXISTS idx_writing_errors_type     ON writing_errors (error_type, subtype);
