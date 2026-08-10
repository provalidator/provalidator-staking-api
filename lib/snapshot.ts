import { CHAINS, type ChainConfig } from './chains';
import { fetchCosmosStats } from './cosmos';
import { kvGet, kvSet } from './kv';
import type { GlobalStats, LiveStats, ProjectStats, Snapshot } from './types';

const SNAPSHOT_KEY = 'provalidator:snapshot:v1';
/** 업스트림이 계속 죽어 있어도 이 기간 동안은 마지막 성공값으로 응답합니다. */
const SNAPSHOT_TTL_SECONDS = 86_400;

/**
 * 전 체인 스냅샷을 만듭니다. 체인별 폴백 순서:
 *   live (체인에서 방금 수집) → cached (KV 의 마지막 성공값) → static (하드코딩)
 *
 * 한 체인이 실패해도 나머지는 정상 응답합니다. API 는 절대 5xx 를 내지 않습니다.
 */
export async function buildSnapshot(): Promise<Snapshot> {
  const now = Math.floor(Date.now() / 1000);
  const previous = await kvGet<Snapshot>(SNAPSHOT_KEY);

  const results = await Promise.all(
    CHAINS.map(async (chain): Promise<ProjectStats> => {
      if (chain.kind !== 'cosmos') {
        // Aptos / Monad: 아직 어댑터 없음 → 항상 static
        return toProjectStats(chain, {}, 'static', now);
      }
      try {
        const live = await fetchCosmosStats(chain);
        return toProjectStats(chain, live, 'live', now);
      } catch (error) {
        console.error(`[${chain.id}] live fetch failed:`, error);
        const cached = previous?.projects[chain.id];
        if (cached) return { ...cached, source: 'cached' };
        return toProjectStats(chain, {}, 'static', now);
      }
    }),
  );

  const snapshot: Snapshot = {
    generated_at: now,
    projects: Object.fromEntries(results.map((p) => [p.chain_id, p])),
  };

  // 라이브로 하나라도 받아왔을 때만 저장 — 전부 실패한 스냅샷으로 캐시를 덮어쓰지 않습니다.
  if (results.some((p) => p.source === 'live')) {
    await kvSet(SNAPSHOT_KEY, snapshot, SNAPSHOT_TTL_SECONDS);
  }

  return snapshot;
}

function toProjectStats(
  chain: ChainConfig,
  live: LiveStats,
  source: ProjectStats['source'],
  timestamp: number,
): ProjectStats {
  const fallback = chain.static;
  const fees = live.fees ?? fallback.fees;
  const apr = live.apr ?? fallback.apr;
  const stakedAmount = live.staked_amount ?? fallback.staked_amount;
  // 가격은 아직 하드코딩입니다. CoinGecko 를 붙이면 여기만 교체하면 됩니다.
  const tokenPrice = fallback.token_price;

  return {
    chain_id: chain.id,
    project_title: chain.projectTitle,
    token: chain.token,
    fees: round(fees, 4),
    apr: round(apr, 6),
    apr_percent: round(apr * 100, 4),
    token_price: tokenPrice,
    staked_amount: round(stakedAmount, 6),
    staked_amount_usd: round(stakedAmount * tokenPrice, 2),
    delegators: live.delegators ?? fallback.delegators,
    market_cap: fallback.market_cap,
    source,
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
