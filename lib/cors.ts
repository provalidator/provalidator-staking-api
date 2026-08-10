import type { VercelResponse } from '@vercel/node';

/**
 * CORS 정책.
 *
 * 기본값은 `*` 입니다. 이 API 는 인증이 없는 공개 읽기 전용 데이터이고,
 * `*` 여야 CDN 캐시가 Origin 과 무관하게 안전하게 재사용됩니다.
 *
 * 화이트리스트가 꼭 필요하면 env 로 설정하세요:
 *   ALLOWED_ORIGINS=https://provalidator.com,https://provalidator-x-lplabs.framer.website
 *
 * ⚠️ 화이트리스트 모드에서는 응답이 Origin 마다 달라지므로 `Vary: Origin` 이 반드시 필요합니다.
 *    이게 없으면 먼저 캐시된 도메인의 헤더가 다른 도메인에 그대로 나가서 CORS 에러가 납니다.
 *    (참고: CORS 는 브라우저에만 적용됩니다. curl/서버 요청은 그대로 통과하므로 보안 장치가 아닙니다.)
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function applyCors(res: VercelResponse, origin: string | undefined): void {
  if (allowedOrigins.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Vary', 'Origin');
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
