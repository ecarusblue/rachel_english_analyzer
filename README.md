# study-room-files

영어 공부방용 파일 저장 API. 시험지(exam)와 영어 라이팅(writing) 파일을 R2에 저장하고,
메타데이터는 D1에 기록합니다. 사람은 다운로드로, Claude는 MCP 도구로 같은 파일에 접근합니다.

## 설치 및 배포

```bash
npm install

# 1) R2 버킷, D1 데이터베이스 생성
npx wrangler r2 bucket create study-room-files
npx wrangler d1 create study-room-files
#   -> 출력된 database_id 를 wrangler.jsonc 의 REPLACE_WITH_YOUR_D1_ID 에 넣기

# 2) 테이블 생성
npx wrangler d1 execute study-room-files --remote --file=schema.sql

# 3) 토큰 등록 (각각 32바이트 이상 무작위 문자열 권장)
#    생성 예: openssl rand -hex 32
npx wrangler secret put ADMIN_TOKEN    # 업로드/삭제 포함 전체 권한 (웹 화면용)
npx wrangler secret put ANALYST_TOKEN  # 조회 + 분석 결과 저장 (Claude가 분석을 저장할 때)
npx wrangler secret put READ_TOKEN     # 조회/다운로드 전용

# 4) 배포
npx wrangler deploy
```

로컬 테스트: `.dev.vars.example`을 `.dev.vars`로 복사 후 `npx wrangler dev`

## 업로드 화면 (웹)

배포한 주소의 루트(`https://<your-worker>.workers.dev/`)를 열면 업로드 화면이 나옵니다. 같은 Worker가 `public/` 폴더를 함께 서비스합니다.

- 상단 탭으로 **시험지 분석**과 **라이팅 첨삭**을 구분해 업로드합니다 (`category`가 exam/writing으로 저장됨).
  - 시험지: 학교, 학년, 연도, 학기, 시험 종류 입력
  - 라이팅: 학생 ID, 과제명 입력 (이름 대신 ID 사용)
- docx는 브라우저에서 텍스트를 추출해(`public/mammoth.browser.min.js`, mammoth 1.13.0) 원본과 함께 보냅니다.
- 이미지는 긴 변 2,000px 이하 JPG로 줄여서 올립니다 (Claude가 읽을 수 있는 3MB 이하 유지).
- 여러 파일을 한 번에 올릴 수 있고, 아래 목록에서 다운로드/삭제할 수 있습니다.
- 처음 열면 **ADMIN_TOKEN**을 입력합니다. 토큰은 코드에 들어 있지 않고, "이 기기에 기억하기"를 켠 경우에만 그 브라우저에 저장됩니다. 공용 PC에서는 끄세요.
- 읽기 전용 토큰으로 접속하면 목록 조회와 다운로드는 되지만 업로드/삭제는 거부됩니다.

## 토큰 권한

| 토큰 | 조회/다운로드 | 분석 결과 조회 | 분석 결과 저장 | 파일 업로드/삭제 |
|------|:---:|:---:|:---:|:---:|
| READ_TOKEN | O | O | X | X |
| ANALYST_TOKEN | O | O | O | X |
| ADMIN_TOKEN | O | O | O | O |

Claude에는 **ANALYST_TOKEN**(분석을 저장할 때) 또는 READ_TOKEN(조회만)을 넣으세요.
ADMIN_TOKEN은 웹 업로드 화면에서만 사용하는 것을 권장합니다. ANALYST_TOKEN은 선택 사항입니다.

## API

모든 요청에 `Authorization: Bearer <토큰>` 헤더가 필요합니다 (`/health` 제외).

| 메서드 | 경로 | 권한 | 설명 |
|---|---|---|---|
| GET | `/files?category=&school=&year=&student_id=&limit=` | read | 목록 |
| POST | `/files` | admin | 업로드 (multipart/form-data) |
| GET | `/files/:id` | read | 메타데이터 |
| GET | `/files/:id/download` | read | 원본 다운로드 |
| GET | `/files/:id/content` | read | 추출 텍스트(JSON) 또는 이미지/PDF 원본 |
| DELETE | `/files/:id` | admin | 삭제 |
| POST | `/mcp` | read | MCP 엔드포인트 (`list_files`, `get_file`) |

### 업로드 예시

```bash
curl -X POST https://<your-worker>.workers.dev/files \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@2025_1학기_중간고사.pdf" \
  -F "category=exam" \
  -F "school=OO중" -F "grade=2" -F "year=2025" \
  -F "term=1학기" -F "exam_type=중간고사"
```

라이팅 업로드는 `category=writing`, `student_id=S001`, `assignment=Unit3 에세이` 등을 보냅니다.
이름 대신 학생 ID를 쓰고, ID와 이름 매칭표는 별도로 관리하세요.

### docx 처리

무료 Workers는 CPU 시간이 짧아 서버에서 docx를 파싱하지 않습니다.
웹앱에서 업로드 전에 텍스트를 추출(예: mammoth.js)해 `extracted_text` 필드로 함께 보내세요.
텍스트가 없는 docx는 `get_file`이 오류를 반환합니다.

## 분석 결과 저장 (MCP 도구)

Claude가 시험지/라이팅을 읽고 분석한 결과를 저장하고, 쌓인 데이터로 경향과 약점을 조회합니다.
권한이 없는 토큰에는 저장 도구가 목록에 나타나지 않습니다.

| 도구 | 권한 | 설명 |
|---|---|---|
| `list_files` | read | 파일 목록. `analyzed=false`로 분석 전인 파일만 조회 |
| `get_file` | read | 파일 내용 (텍스트/이미지/PDF) |
| `get_vocabulary` | read | 지금까지 쓴 문항 유형·단원·오류 용어 (저장 전에 확인해 용어를 통일) |
| `save_exam_analysis` | analyst | 시험지 문항별 분석 저장 (문항 번호, 유형, 단원, 난이도, 배점) |
| `get_exam_analysis` | read | 시험지 한 건의 분석 조회 |
| `exam_trends` | read | 학교/학년/학기/연도 필터로 출제 경향 집계 (유형·단원·난이도·연도별) |
| `save_writing_feedback` | analyst | 라이팅 첨삭 저장 (총평, 점수, 오류 목록) |
| `get_writing_feedback` | read | 라이팅 한 건의 첨삭 조회 |
| `student_error_summary` | read | 학생별 누적 오류 통계, 최근 점수, 오류 예시 |

같은 파일을 다시 분석해 저장하면 이전 결과를 대체합니다. 파일을 삭제하면 분석 결과도 함께 삭제됩니다.

사용 예 (Claude에게):
- "분석 안 된 시험지 전부 분석해서 저장해줘"
- "OO중 중2 1학기 중간고사 최근 3년 출제 경향 알려줘"
- "S001 학생 라이팅 첨삭하고 저장한 뒤, 누적 약점 알려줘"

기존 DB를 쓰고 있다면 배포 전에 `npx wrangler d1 execute study-room-files --remote --file=schema.sql`을 다시 실행해 분석 테이블을 추가하세요 (여러 번 실행해도 안전합니다).

## Claude 연결

Claude Code:

```bash
claude mcp add --transport http study-room-files \
  https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <ANALYST_TOKEN>"
```

claude.ai 커스텀 커넥터가 Bearer 헤더 직접 지정을 지원하는지는 확인이 필요합니다.
지원하지 않으면 Claude Code나 Claude API(도구 호출)로 연결하거나, 이후 OAuth 방식으로 확장해야 합니다.

## 알아둘 점

- 업로드 상한 20MB, MCP로 이미지/PDF 본문을 돌려주는 상한 3MB입니다. 큰 이미지는 업로드 전에 리사이즈하세요 (긴 변 2,000px 정도).
- R2 버킷의 public access는 켜지 마세요.
- `ALLOWED_ORIGIN`을 웹앱 도메인으로 바꾸면 다른 사이트에서의 브라우저 호출을 막을 수 있습니다.
- 인증 실패 반복에 대한 속도 제한은 Cloudflare 대시보드의 Rate limiting 규칙으로 추가하세요.
