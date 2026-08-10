import type { AptosChain } from './chains';
import { Lcd, num } from './lcd';
import type { LiveStats } from './types';

/**
 * Aptos 어댑터.
 *
 * 프로발리데이터는 `0x1::delegation_pool` 이 아니라 `0x1::staking_contract` 모델을 씁니다.
 * (= 공개 위임 풀이 아니라 staker ↔ operator 1:1 계약)
 * 따라서:
 *   - operator 주소로 인덱서를 조회해 스테이크 풀 주소들을 찾고
 *   - 각 풀의 StakePool 리소스에서 위임량을 합산하고
 *   - 커미션은 staker 계정의 staking_contract::Store 에서 읽습니다
 *   - 위임자 수는 개념 자체가 없으므로 명시적으로 null 을 반환합니다
 */

const SECONDS_PER_YEAR = 31_536_000;
/** Move 의 FixedPoint64 는 하위 64비트가 소수부입니다. */
const FIXED_POINT_64 = 2 ** 64;

interface StakePoolResource {
  data: {
    active: { value: string };
    pending_active: { value: string };
    pending_inactive: { value: string };
    inactive: { value: string };
  };
}

interface StakerResource {
  data: { staker: string };
}

interface StakingContractStore {
  data: {
    staking_contracts: {
      data: Array<{
        key: string; // operator address
        value: { commission_percentage: string; pool_address: string };
      }>;
    };
  };
}

export async function fetchAptosStats(chain: AptosChain): Promise<LiveStats> {
  const rest = new Lcd(chain.rest);

  const pools = await resolveStakePools(chain);
  if (pools.length === 0) {
    throw new Error(`no stake pools found for operator ${chain.operator}`);
  }

  const [poolStates, commissionRate, grossApr] = await Promise.all([
    Promise.all(
      pools.map((pool) =>
        rest.tryGet<StakePoolResource>(
          `/accounts/${pool}/resource/0x1::stake::StakePool`,
        ),
      ),
    ),
    fetchCommissionRate(rest, chain, pools),
    fetchGrossApr(rest),
  ]);

  // active + pending_active 만 위임량으로 봅니다.
  // pending_inactive 는 언본딩 중이라 곧 빠져나갈 물량입니다.
  let staked = 0;
  let sawPool = false;
  for (const state of poolStates) {
    if (!state) continue;
    sawPool = true;
    staked +=
      (num(state.data.active.value) ?? 0) +
      (num(state.data.pending_active.value) ?? 0);
  }
  if (!sawPool) throw new Error('all StakePool reads failed');

  const apr =
    grossApr === null || commissionRate === null
      ? null
      : grossApr * (1 - commissionRate);

  return {
    fees: commissionRate === null ? null : commissionRate * 100,
    apr,
    staked_amount: staked / 10 ** chain.exponent,
    // staking_contract 풀에는 공개 위임자가 없습니다. static 폴백으로 넘어가지 않도록
    // 키를 명시적으로 두고 null 을 넣습니다.
    delegators: null,
  };
}

/**
 * operator 주소 → 스테이크 풀 주소들.
 * 인덱서가 죽으면 설정에 적어둔 알려진 풀 주소로 폴백합니다.
 */
async function resolveStakePools(chain: AptosChain): Promise<string[]> {
  const query = `{ current_staking_pool_voter(where: {operator_address: {_eq: "${chain.operator}"}}) { staking_pool_address } }`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(chain.indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { current_staking_pool_voter?: Array<{ staking_pool_address: string }> };
    };
    const pools = body.data?.current_staking_pool_voter?.map(
      (row) => row.staking_pool_address,
    );
    if (pools && pools.length > 0) return pools;
  } catch (error) {
    console.error('[aptos] indexer lookup failed:', error);
  } finally {
    clearTimeout(timer);
  }
  return chain.knownStakePools;
}

/** 커미션은 풀이 아니라 staker(소유자) 계정에 operator 별로 저장됩니다. */
async function fetchCommissionRate(
  rest: Lcd,
  chain: AptosChain,
  pools: string[],
): Promise<number | null> {
  for (const pool of pools) {
    const staker = await rest.tryGet<StakerResource>(
      `/accounts/${pool}/resource/0x1::staking_contract::Staker`,
    );
    if (!staker) continue;

    const store = await rest.tryGet<StakingContractStore>(
      `/accounts/${staker.data.staker}/resource/0x1::staking_contract::Store`,
    );
    const entry = store?.data.staking_contracts.data.find(
      (row) => row.key.toLowerCase() === chain.operator.toLowerCase(),
    );
    const percentage = entry ? num(entry.value.commission_percentage) : null;
    if (percentage !== null) return percentage / 100;
  }
  return null;
}

/**
 * 체인 전체 스테이킹 보상률(커미션 차감 전).
 *
 * StakingRewardsConfig 가 거버넌스로 갱신되는 현재 값이고,
 * StakingConfig.rewards_rate 는 갱신되지 않는 레거시 필드입니다.
 * 전자를 우선 쓰고 없을 때만 후자로 떨어집니다.
 */
async function fetchGrossApr(rest: Lcd): Promise<number | null> {
  const [rewards, block, legacy] = await Promise.all([
    rest.tryGet<{ data: { rewards_rate: { value: string } } }>(
      '/accounts/0x1/resource/0x1::staking_config::StakingRewardsConfig',
    ),
    rest.tryGet<{ data: { epoch_interval: string } }>(
      '/accounts/0x1/resource/0x1::block::BlockResource',
    ),
    rest.tryGet<{
      data: { rewards_rate: string; rewards_rate_denominator: string };
    }>('/accounts/0x1/resource/0x1::staking_config::StakingConfig'),
  ]);

  // epoch_interval 은 마이크로초 단위입니다.
  const epochMicros = block ? num(block.data.epoch_interval) : null;
  if (!epochMicros) return null;
  const epochsPerYear = SECONDS_PER_YEAR / (epochMicros / 1_000_000);

  const fixed = rewards ? num(rewards.data.rewards_rate.value) : null;
  if (fixed) return (fixed / FIXED_POINT_64) * epochsPerYear;

  const numerator = legacy ? num(legacy.data.rewards_rate) : null;
  const denominator = legacy ? num(legacy.data.rewards_rate_denominator) : null;
  if (!numerator || !denominator) return null;
  return (numerator / denominator) * epochsPerYear;
}
