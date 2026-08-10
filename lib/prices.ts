/**
 * CoinGecko 가격 / 시가총액 조회.
 *
 * 전 체인을 요청 1회로 처리합니다 (simple/price 는 id 를 콤마로 여러 개 받습니다).
 * 키 없이도 동작하지만 무료 티어는 rate limit 이 빡빡하므로,
 * 트래픽이 늘면 demo 키를 넣는 걸 권장합니다:
 *   COINGECKO_API_KEY=CG-xxxx        (무료 demo 키)
 *   COINGECKO_PRO_API_KEY=CG-xxxx    (유료 키 — 호스트가 pro-api 로 바뀝니다)
 */
const TIMEOUT_MS = 6_000;

const proKey = process.env.COINGECKO_PRO_API_KEY;
const demoKey = process.env.COINGECKO_API_KEY;

const BASE_URL = proKey
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';

export interface PriceQuote {
  usd: number;
  usdMarketCap: number | null;
}

/** coingecko id → 시세. 실패하면 빈 객체를 반환합니다 (호출부가 폴백 처리). */
export async function fetchPrices(
  ids: string[],
): Promise<Record<string, PriceQuote>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};

  const url =
    `${BASE_URL}/simple/price` +
    `?ids=${encodeURIComponent(unique.join(','))}` +
    '&vs_currencies=usd&include_market_cap=true';

  const headers: Record<string, string> = { accept: 'application/json' };
  if (proKey) headers['x-cg-pro-api-key'] = proKey;
  else if (demoKey) headers['x-cg-demo-api-key'] = demoKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const body = (await res.json()) as Record<
      string,
      { usd?: number; usd_market_cap?: number }
    >;

    const quotes: Record<string, PriceQuote> = {};
    for (const [id, entry] of Object.entries(body)) {
      // 0 이나 누락은 유효한 시세가 아니므로 폴백으로 넘깁니다.
      if (typeof entry.usd !== 'number' || !Number.isFinite(entry.usd) || entry.usd <= 0) {
        continue;
      }
      const cap = entry.usd_market_cap;
      quotes[id] = {
        usd: entry.usd,
        usdMarketCap:
          typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : null,
      };
    }
    return quotes;
  } catch (error) {
    console.error('CoinGecko fetch failed:', error);
    return {};
  } finally {
    clearTimeout(timer);
  }
}
