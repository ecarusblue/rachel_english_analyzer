// Bearer 토큰 인증 (3단계 권한)
//  - ADMIN_TOKEN  : 전체 권한 (파일 업로드/삭제 + 분석 저장)
//  - ANALYST_TOKEN: 파일 조회 + 분석 결과 저장 (파일 업로드/삭제 불가). 선택 사항
//  - READ_TOKEN   : 조회/다운로드만

export type Role = "admin" | "analyst" | "reader";

interface AuthEnv {
  ADMIN_TOKEN: string;
  ANALYST_TOKEN?: string;
  READ_TOKEN: string;
}

// 길이가 달라도 같은 시간에 비교되도록 SHA-256 해시 후 상수 시간 비교
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<Role | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();

  // 토큰이 설정되지 않은 경우 항상 거부 (빈 문자열 일치 방지)
  if (env.ADMIN_TOKEN && (await safeEqual(token, env.ADMIN_TOKEN))) return "admin";
  if (env.ANALYST_TOKEN && (await safeEqual(token, env.ANALYST_TOKEN))) return "analyst";
  if (env.READ_TOKEN && (await safeEqual(token, env.READ_TOKEN))) return "reader";
  return null;
}
