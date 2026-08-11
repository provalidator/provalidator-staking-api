/**
 * CoinGecko 가격 / 시가총액 조회.
 *
 * 전 체인을 요청 1회로 처리합니다 (simple/price 는 id 를 콤마로 여러 개 받습니다).
 * 키 없이도 동작하지만 무료 티어는 rate limit 이 빡빡하므로,
 * 트래픽이 늘면 demo 키를 넣는 걸 권장합니다:
 *   COINGECKO_API_KEY=CG-xxxx        (무료 demo 키)
 *   COINGECKO_PRO_API_KEY=CG-xxxx    (유료 키 — 호스트가 pro-api 로 바뀝니다)
 */
import { kvGet, kvSet } from './kv';

const TIMEOUT_MS = 6_000;

const proKey = process.env.COINGECKO_PRO_API_KEY;
const demoKey = process.env.COINGECKO_API_KEY;

const BASE_URL = proKey
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';

export interface PriceQuote {
  usd: number;
  usdMarketCap: number | null;
  /** CoinGecko 가 호스팅하는 토큰 로고 URL */
  logo: string | null;
}

export interface PriceResult {
  quotes: Record<string, PriceQuote>;
  /** true 면 CoinGecko 조회에 실패해서 마지막으로 성공한 시세를 쓰고 있다는 뜻입니다. */
  stale: boolean;
}

/**
 * 마지막으로 성공한 시세를 따로 보관합니다.
 *
 * 스냅샷 안에만 두면, CoinGecko 가 잠깐 실패했을 때 static 값으로 채워진 스냅샷이
 * 저장되면서 멀쩡하던 캐시 시세를 덮어써 버립니다. 무료 티어는 rate limit 이 빡빡해서
 * 이 상황이 실제로 발생합니다.
 */
const PRICE_CACHE_KEY = 'provalidator:prices:v1';
const PRICE_CACHE_TTL_SECONDS = 86_400;

/** coingecko id → 시세. 실패하면 마지막 성공 시세로 폴백합니다. */
export async function fetchPrices(ids: string[]): Promise<PriceResult> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { quotes: {}, stale: false };

  // simple/price 대신 coins/markets 를 씁니다 — 같은 요청 1회로 로고 URL 까지 옵니다.
  const url =
    `${BASE_URL}/coins/markets` +
    `?vs_currency=usd&ids=${encodeURIComponent(unique.join(','))}` +
    `&per_page=${unique.length}&page=1&sparkline=false`;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (proKey) headers['x-cg-pro-api-key'] = proKey;
  else if (demoKey) headers['x-cg-demo-api-key'] = demoKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const body = (await res.json()) as Array<{
      id: string;
      current_price?: number;
      market_cap?: number;
      image?: string;
    }>;
    if (!Array.isArray(body)) throw new Error('unexpected CoinGecko payload');

    const quotes: Record<string, PriceQuote> = {};
    for (const entry of body) {
      const price = entry.current_price;
      // 0 이나 누락은 유효한 시세가 아니므로 폴백으로 넘깁니다.
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;

      const cap = entry.market_cap;
      quotes[entry.id] = {
        usd: price,
        usdMarketCap:
          typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : null,
        logo: entry.image ?? null,
      };
    }
    if (Object.keys(quotes).length === 0) throw new Error('no usable quotes');

    await kvSet(PRICE_CACHE_KEY, quotes, PRICE_CACHE_TTL_SECONDS);
    return { quotes, stale: false };
  } catch (error) {
    console.error('CoinGecko fetch failed:', error);
    const cached = await kvGet<Record<string, PriceQuote>>(PRICE_CACHE_KEY);
    return { quotes: cached ?? {}, stale: true };
  } finally {
    clearTimeout(timer);
  }
}
