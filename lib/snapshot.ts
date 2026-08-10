import { CHAINS, type ChainConfig } from './chains';
import { fetchCosmosStats } from './cosmos';
import { kvGet, kvSet } from './kv';
import { fetchPrices, type PriceQuote } from './prices';
import type { GlobalStats, LiveStats, ProjectStats, Snapshot } from './types';

const SNAPSHOT_KEY = 'provalidator:snapshot:v1';
/** 업스트림이 계속 죽어 있어도 이 기간 동안은 마지막 성공값으로 응답합니다. */
const SNAPSHOT_TTL_SECONDS = 86_400;

/** 체인 데이터와 가격은 서로 독립적으로 폴백합니다. */
interface Resolved<T> {
  value: T;
  source: ProjectStats['source'];
}

/**
 * 전 체인 스냅샷을 만듭니다. 각 값의 폴백 순서:
 *   live (방금 수집) → cached (KV 의 마지막 성공값) → static (하드코딩)
 *
 * 체인 데이터와 가격은 별개로 폴백합니다 — CoinGecko 만 죽어도 체인 수치는 라이브로 나갑니다.
 * 한 체인이 실패해도 나머지는 정상 응답하며, API 는 절대 5xx 를 내지 않습니다.
 */
export async function buildSnapshot(): Promise<Snapshot> {
  const now = Math.floor(Date.now() / 1000);

  // KV 읽기 · 가격 조회 · 체인 수집을 전부 동시에 시작합니다.
  const previousPromise = kvGet<Snapshot>(SNAPSHOT_KEY);
  const pricesPromise = fetchPrices(
    CHAINS.map((c) => c.coingeckoId).filter((id): id is string => Boolean(id)),
  );
  const livePromises = CHAINS.map(async (chain): Promise<LiveStats | null> => {
    if (chain.kind !== 'cosmos') return null; // Aptos / Monad: 아직 어댑터 없음
    try {
      return await fetchCosmosStats(chain);
    } catch (error) {
      console.error(`[${chain.id}] live fetch failed:`, error);
      return null;
    }
  });

  const [previous, prices, liveResults] = await Promise.all([
    previousPromise,
    pricesPromise,
    Promise.all(livePromises),
  ]);

  const projects = CHAINS.map((chain, index) =>
    toProjectStats(
      chain,
      resolveChainStats(chain, liveResults[index], previous),
      resolvePrice(chain, prices[chain.coingeckoId ?? ''], previous),
      now,
    ),
  );

  const snapshot: Snapshot = {
    generated_at: now,
    projects: Object.fromEntries(projects.map((p) => [p.chain_id, p])),
  };

  // 라이브로 하나라도 받아왔을 때만 저장 — 전부 폴백인 스냅샷으로 캐시를 덮어쓰지 않습니다.
  const hasLive = projects.some(
    (p) => p.source === 'live' || p.price_source === 'live',
  );
  if (hasLive) await kvSet(SNAPSHOT_KEY, snapshot, SNAPSHOT_TTL_SECONDS);

  return snapshot;
}

function resolveChainStats(
  chain: ChainConfig,
  live: LiveStats | null,
  previous: Snapshot | null,
): Resolved<LiveStats> {
  if (live) return { value: live, source: 'live' };

  const cached = previous?.projects[chain.id];
  if (cached && cached.source !== 'static') {
    return {
      value: {
        fees: cached.fees,
        apr: cached.apr,
        staked_amount: cached.staked_amount,
        delegators: cached.delegators,
      },
      source: 'cached',
    };
  }
  return { value: {}, source: 'static' };
}

function resolvePrice(
  chain: ChainConfig,
  quote: PriceQuote | undefined,
  previous: Snapshot | null,
): Resolved<{ price: number; marketCap: number }> {
  if (quote) {
    return {
      value: {
        price: quote.usd,
        marketCap: quote.usdMarketCap ?? chain.static.market_cap,
      },
      source: 'live',
    };
  }

  const cached = previous?.projects[chain.id];
  if (cached?.token_price && cached.price_source !== 'static') {
    return {
      value: {
        price: cached.token_price,
        marketCap: cached.market_cap ?? chain.static.market_cap,
      },
      source: 'cached',
    };
  }

  return {
    value: { price: chain.static.token_price, marketCap: chain.static.market_cap },
    source: 'static',
  };
}

function toProjectStats(
  chain: ChainConfig,
  stats: Resolved<LiveStats>,
  price: Resolved<{ price: number; marketCap: number }>,
  timestamp: number,
): ProjectStats {
  const fallback = chain.static;
  const apr = stats.value.apr ?? fallback.apr;
  const stakedAmount = stats.value.staked_amount ?? fallback.staked_amount;
  const tokenPrice = price.value.price;

  return {
    chain_id: chain.id,
    project_title: chain.projectTitle,
    token: chain.token,
    fees: round(stats.value.fees ?? fallback.fees, 4),
    apr: round(apr, 6),
    apr_percent: round(apr * 100, 4),
    token_price: tokenPrice,
    staked_amount: round(stakedAmount, 6),
    staked_amount_usd: round(stakedAmount * tokenPrice, 2),
    delegators: stats.value.delegators ?? fallback.delegators,
    market_cap: round(price.value.marketCap, 2),
    source: stats.source,
    price_source: price.source,
    timestamp,
  };
}

export function computeGlobalStats(snapshot: Snapshot): GlobalStats {
  const projects = Object.values(snapshot.projects);
  return {
    total_assets_usd_value: round(
      projects.reduce((sum, p) => sum + (p.staked_amount_usd ?? 0), 0),
      2,
    ),
    total_delegators: projects.reduce((sum, p) => sum + (p.delegators ?? 0), 0),
    total_chains: projects.length,
    timestamp: snapshot.generated_at,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
