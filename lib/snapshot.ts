import { fetchAptosStats } from './aptos';
import { CHAINS, type ChainConfig, staticOf } from './chains';
import { fetchCosmosStats } from './cosmos';
import { fetchMonadStats } from './monad';
import { kvGet, kvSet } from './kv';
import { fetchNetworkAprs } from './networks';
import { fetchPrices, type PriceQuote } from './prices';
import type {
  DataSource,
  GlobalStats,
  LiveStats,
  ProjectStats,
  Snapshot,
} from './types';

const SNAPSHOT_KEY = 'provalidator:snapshot:v2';
/** 업스트림이 계속 죽어 있어도 이 기간 동안은 마지막 성공값으로 응답합니다. */
const SNAPSHOT_TTL_SECONDS = 86_400;

/**
 * 이 기간 안에 만들어진 스냅샷이 KV 에 있으면 업스트림을 아예 건드리지 않고 재사용합니다.
 *
 * 엔드포인트마다 URL 이 달라 CDN 캐시가 따로 잡히는데, 이 게이트가 없으면
 * `global_stats` · `chains` · `token=SOL` 이 각자 전체 수집을 유발합니다.
 * 게이트를 두면 어떤 엔드포인트가 먼저 깨우든 수집은 분당 1회로 수렴합니다.
 *
 * CDN 의 s-maxage 가 60초라 데이터는 최대 (60 + 이 값)초만큼 오래될 수 있습니다.
 * 스테이킹 지표에는 충분히 짧은 시간입니다.
 */
const SNAPSHOT_FRESH_SECONDS = 50;

/** 체인 데이터와 가격은 서로 독립적으로 폴백합니다. */
interface Resolved<T> {
  value: T;
  source: DataSource;
}

interface PriceValue {
  price: number | null;
  marketCap: number | null;
  logo: string | null;
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

  // 방금 만든 스냅샷이 있으면 업스트림을 건드리지 않고 그대로 씁니다.
  // 이 한 번의 KV 조회를 먼저 기다리는 대신, 나머지 수집 전체를 건너뜁니다.
  const previous = await kvGet<Snapshot>(SNAPSHOT_KEY);
  if (previous && now - previous.generated_at < SNAPSHOT_FRESH_SECONDS) {
    return previous;
  }

  // 가격 조회 · 체인 수집 · 네트워크 APR 을 전부 동시에 시작합니다.
  const pricesPromise = fetchPrices(
    CHAINS.map((c) => c.coingeckoId).filter((id): id is string => Boolean(id)),
  );
  const livePromises = CHAINS.map(async (chain): Promise<LiveStats | null> => {
    try {
      switch (chain.kind) {
        case 'cosmos':
          return await fetchCosmosStats(chain);
        case 'aptos':
          return await fetchAptosStats(chain);
        case 'monad':
          return await fetchMonadStats(chain);
        case 'asset':
          return null; // 스테이킹 지표가 없는 자산
      }
    } catch (error) {
      console.error(`[${chain.id}] live fetch failed:`, error);
      return null;
    }
  });

  // 우리가 운영하지 않는 자산의 네트워크 기준 APR (Solana, Ethereum, ZetaChain 등)
  const networkAprPromise = fetchNetworkAprs(
    CHAINS.filter((c) => c.kind === 'asset'),
  );

  const [prices, liveResults, networkAprs] = await Promise.all([
    pricesPromise,
    Promise.all(livePromises),
    networkAprPromise,
  ]);

  const projects = CHAINS.map((chain, index) =>
    toProjectStats(
      chain,
      resolveChainStats(chain, liveResults[index], previous),
      resolvePrice(
        chain,
        prices.quotes[chain.coingeckoId ?? ''],
        prices.stale,
        previous,
      ),
      networkAprs[chain.id] ?? previousAssetApr(chain, previous),
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

/**
 * 네트워크 APR 이 이번 라운드에 안 잡혔을 때 쓰는 2차 폴백.
 * KV 안에서 이미 한 번 폴백하지만, KV 자체가 비활성이거나 비어 있을 수 있습니다.
 * 응답의 apr 은 백분율이므로 내부 단위(소수)로 되돌려서 넘깁니다.
 */
function previousAssetApr(
  chain: ChainConfig,
  previous: Snapshot | null,
): number | null {
  if (chain.kind !== 'asset') return null;
  const cached = previous?.projects[chain.id];
  return cached?.apr ? cached.apr / 100 : null;
}

function resolveChainStats(
  chain: ChainConfig,
  live: LiveStats | null,
  previous: Snapshot | null,
): Resolved<LiveStats> {
  if (chain.kind === 'asset') return { value: {}, source: 'none' };
  if (live) return { value: live, source: 'live' };

  const cached = previous?.projects[chain.id];
  if (cached && cached.source !== 'static') {
    return {
      value: {
        fees: cached.fees,
        // 응답의 apr 은 백분율이지만 내부 계산은 소수로 다룹니다.
        // 여기서 되돌리지 않으면 출력 때 100 이 한 번 더 곱해집니다.
        apr: cached.apr === null ? null : cached.apr / 100,
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
  quotesAreStale: boolean,
  previous: Snapshot | null,
): Resolved<PriceValue> {
  const fallback = staticOf(chain);

  if (quote) {
    return {
      value: {
        price: quote.usd,
        marketCap: quote.usdMarketCap ?? fallback?.market_cap ?? null,
        logo: quote.logo,
      },
      source: quotesAreStale ? 'cached' : 'live',
    };
  }

  const cached = previous?.projects[chain.id];
  // 'cached' 도 받아줍니다. 'live' 만 받으면 한 번 static 으로 떨어진 순간
  // 이 경로가 영영 막혀서 CoinGecko 가 복구될 때까지 static 에 갇힙니다.
  if (
    cached?.token_price &&
    (cached.price_source === 'live' || cached.price_source === 'cached')
  ) {
    return {
      value: {
        price: cached.token_price,
        marketCap: cached.market_cap,
        logo: cached.logo,
      },
      source: 'cached',
    };
  }

  if (fallback) {
    return {
      value: {
        price: fallback.token_price,
        marketCap: fallback.market_cap,
        logo: previous?.projects[chain.id]?.logo ?? null,
      },
      source: 'static',
    };
  }

  // CoinGecko 미등재 자산 (NOBL). 가짜 값을 만들지 않고 null 로 둡니다.
  return { value: { price: null, marketCap: null, logo: null }, source: 'none' };
}

function toProjectStats(
  chain: ChainConfig,
  stats: Resolved<LiveStats>,
  price: Resolved<PriceValue>,
  networkApr: number | null,
  timestamp: number,
): ProjectStats {
  const isAsset = chain.kind === 'asset';
  const fallback = staticOf(chain);
  const tokenPrice = price.value.price;

  // 밸리데이터 체인은 "우리에게 위임했을 때의 순 APR",
  // 자산은 "그 네트워크의 기준 APR(커미션 차감 전)" 입니다.
  // 내부에서는 소수(0.1479)로 다루고 출력할 때만 백분율로 바꿉니다.
  const aprRatio = isAsset ? networkApr : (stats.value.apr ?? fallback?.apr ?? null);
  const aprPercent = aprRatio === null ? null : round(aprRatio * 100, 2);
  const fees = isAsset ? null : (stats.value.fees ?? fallback?.fees ?? null);
  const staked = isAsset
    ? null
    : (stats.value.staked_amount ?? fallback?.staked_amount ?? null);

  return {
    chain_id: chain.id,
    project_title: chain.projectTitle,
    token: chain.token,
    type: isAsset ? 'asset' : 'validator',
    logo: price.value.logo,
    fees: round(fees, 4),
    // apr 과 apr_percent 는 둘 다 백분율입니다 (14.79 = 14.79%).
    // 프론트가 apr 을 그대로 % 로 붙여 쓰고 있어 소수(0.1479)를 내보내면 100배 작게 표시됩니다.
    apr: aprPercent,
    apr_percent: aprPercent,
    token_price: tokenPrice,
    staked_amount: round(staked, 6),
    staked_amount_usd:
      staked === null || tokenPrice === null ? null : round(staked * tokenPrice, 2),
    // 위임자 수는 static 폴백이 없습니다. 실제로 못 세면 null 로 내보냅니다 —
    // 하드코딩된 숫자를 대신 내보내면 total_delegators 가 조용히 부풀려집니다.
    delegators: isAsset ? null : (stats.value.delegators ?? null),
    market_cap: round(price.value.marketCap, 2),
    source: stats.source,
    price_source: price.source,
    timestamp,
  };
}

export function computeGlobalStats(snapshot: Snapshot): GlobalStats {
  const projects = Object.values(snapshot.projects);
  // 가격만 추적하는 자산은 합산에서 빠집니다 — 우리가 운영하는 밸리데이터의 지표만 셉니다.
  const validators = projects.filter((p) => p.type === 'validator');
  return {
    total_assets_usd_value: round(
      validators.reduce((sum, p) => sum + (p.staked_amount_usd ?? 0), 0),
      2,
    ) as number,
    total_delegators: validators.reduce((sum, p) => sum + (p.delegators ?? 0), 0),
    total_chains: validators.length,
    timestamp: snapshot.generated_at,
  };
}

function round(value: number, digits: number): number;
function round(value: number | null, digits: number): number | null;
function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
