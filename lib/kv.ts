/**
 * Upstash Redis (Vercel 마켓플레이스 통합) 기반 스냅샷 저장소.
 *
 * SDK 없이 REST 만 씁니다 — 의존성 0, 콜드스타트 영향 없음.
 * 환경변수가 없으면 자동으로 비활성화되고, API 는 여전히 동작합니다
 * (라이브 수집 실패 시 static 폴백으로 내려감).
 *
 * Vercel 에서 Upstash 를 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동 주입됩니다.
 */
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

export const kvEnabled = Boolean(url && token);

const TIMEOUT_MS = 3_000;

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`KV HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function kvGet<T>(key: string): Promise<T | null> {
  if (!kvEnabled) return null;
  try {
    const body = (await call(`/get/${encodeURIComponent(key)}`)) as {
      result: string | null;
    };
    return body.result ? (JSON.parse(body.result) as T) : null;
  } catch {
    return null;
  }
}

/** ttlSeconds 를 넉넉히 두면 업스트림이 오래 죽어 있어도 stale 응답을 유지할 수 있습니다. */
export async function kvSet(
  key: string,
  value: unknown,
  ttlSeconds = 86_400,
): Promise<void> {
  if (!kvEnabled) return;
  try {
    await call(`/set/${encodeURIComponent(key)}?EX=${ttlSeconds}`, {
      method: 'POST',
      body: JSON.stringify(value),
    });
  } catch {
    // 캐시 쓰기 실패는 무시 — 응답에는 영향을 주지 않습니다.
  }
}
