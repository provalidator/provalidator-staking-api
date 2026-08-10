import type { CosmosChain } from './chains';
import { kvGet, kvSet } from './kv';
import { Lcd, num } from './lcd';
import type { LiveStats } from './types';

interface ValidatorResponse {
  validator: {
    operator_address: string;
    jailed: boolean;
    status: string;
    tokens: string;
    description?: { moniker?: string };
    commission: { commission_rates: { rate: string } };
  };
}

interface PoolResponse {
  pool: { bonded_tokens: string; not_bonded_tokens: string };
}

interface DistributionParamsResponse {
  params: { community_tax: string };
}

interface AnnualProvisions {
  /** base denom 단위의 연간 신규 발행량 */
  amount: number;
  /** community_tax 를 차감해야 하는지 (Osmosis 는 이미 분배 비율에 반영되어 있어 false) */
  applyCommunityTax: boolean;
}

/**
 * 프로발리데이터 밸리데이터의 라이브 스탯을 수집합니다.
 *
 * validator 조회는 필수 — 실패하면 throw 해서 호출부가 캐시/static 으로 폴백합니다.
 * 나머지(pool, 인플레이션, 위임자 수)는 선택 — 실패하면 해당 필드만 null 이 됩니다.
 */
export async function fetchCosmosStats(chain: CosmosChain): Promise<LiveStats> {
  const lcd = new Lcd(chain.rest);

  // 먼저 단독 호출 → 살아있는 엔드포인트를 확정(pin)한 뒤 나머지를 병렬로 보냅니다.
  const validatorRes = await lcd.get<ValidatorResponse>(
    `/cosmos/staking/v1beta1/validators/${chain.valoper}`,
  );
  const validator = validatorRes.validator;

  const [pool, distParams, provisions, delegators] = await Promise.all([
    lcd.tryGet<PoolResponse>('/cosmos/staking/v1beta1/pool'),
    lcd.tryGet<DistributionParamsResponse>('/cosmos/distribution/v1beta1/params'),
    fetchAnnualProvisions(lcd, chain),
    fetchDelegatorCount(lcd, chain),
  ]);

  const commissionRate = num(validator.commission.commission_rates.rate) ?? 0;
  const stakedBase = num(validator.tokens);
  const bondedBase = pool ? num(pool.pool.bonded_tokens) : null;
  const communityTax = distParams ? (num(distParams.params.community_tax) ?? 0) : 0;

  let apr: number | null = null;
  if (provisions && bondedBase && bondedBase > 0) {
    const taxed = provisions.applyCommunityTax ? 1 - communityTax : 1;
    const chainApr = (provisions.amount * taxed) / bondedBase;
    // 위임자가 실제로 받는 순 APR = 체인 APR × (1 - 커미션)
    apr = chainApr * (1 - commissionRate);
  }

  return {
    fees: commissionRate * 100,
    apr,
    staked_amount: stakedBase === null ? null : stakedBase / 10 ** chain.exponent,
    delegators,
  };
}

/** 유지 중인 EVM 체인 수는 거의 안 바뀌므로 스냅샷보다 훨씬 길게 캐시합니다. */
const AXELAR_MAINTAINED_KEY = 'provalidator:axelar:maintained:v1';
const AXELAR_MAINTAINED_TTL_SECONDS = 21_600; // 6h

async function fetchAnnualProvisions(
  lcd: Lcd,
  chain: CosmosChain,
): Promise<AnnualProvisions | null> {
  if (chain.aprStrategy === 'none') return null;

  if (chain.aprStrategy === 'axelar') return fetchAxelarProvisions(lcd, chain);

  if (chain.aprStrategy === 'osmosis') {
    const [epoch, params] = await Promise.all([
      lcd.tryGet<{ epoch_provisions: string }>('/osmosis/mint/v1beta1/epoch_provisions'),
      lcd.tryGet<{
        params: { distribution_proportions: { staking: string } };
      }>('/osmosis/mint/v1beta1/params'),
    ]);
    const perEpoch = epoch ? num(epoch.epoch_provisions) : null;
    const stakingShare = params
      ? num(params.params.distribution_proportions.staking)
      : null;
    if (!perEpoch || !stakingShare) return null;
    // Osmosis 의 mint epoch 은 'day' 입니다.
    return { amount: perEpoch * 365 * stakingShare, applyCommunityTax: false };
  }

  // 표준 x/mint: annual_provisions 를 우선 사용
  const direct = await lcd.tryGet<{ annual_provisions: string }>(
    '/cosmos/mint/v1beta1/annual_provisions',
  );
  const provisions = direct ? num(direct.annual_provisions) : null;
  // 0 은 "인플레이션 보상 없음"이 아니라 "이 체인은 mint 모듈을 안 쓴다"는 신호입니다.
  // (예: Axelar 는 mint 가 항상 0 이고 보상이 x/reward 모듈에서 나옵니다.)
  // 이 경우 APR 을 0 으로 내보내지 않고 null → static 폴백으로 넘깁니다.
  if (provisions !== null && provisions > 0) {
    return { amount: provisions, applyCommunityTax: true };
  }

  // 폴백: inflation × total supply
  const [inflationRes, supplyRes] = await Promise.all([
    lcd.tryGet<{ inflation: string }>('/cosmos/mint/v1beta1/inflation'),
    lcd.tryGet<{ amount: { denom: string; amount: string } }>(
      `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(chain.denom)}`,
    ),
  ]);
  const inflation = inflationRes ? num(inflationRes.inflation) : null;
  const supply = supplyRes ? num(supplyRes.amount.amount) : null;
  if (!inflation || !supply) return null;

  return { amount: inflation * supply, applyCommunityTax: true };
}

/**
 * Axelar 는 x/mint 를 쓰지 않습니다 (annual_provisions 가 항상 0).
 * 보상은 x/reward 모듈에서 나오고, 인플레이션이 **밸리데이터가 유지하는 EVM 체인 수**에
 * 비례합니다:
 *
 *   inflation = base + (base × key_mgmt_relative_rate)
 *                    + (external_chain_voting_rate × 유지 중인 EVM 체인 수)
 *   annual_provisions = inflation × 총 발행량
 *
 * 즉 같은 체인이라도 밸리데이터마다 APR 이 다릅니다.
 */
async function fetchAxelarProvisions(
  lcd: Lcd,
  chain: CosmosChain,
): Promise<AnnualProvisions | null> {
  const [rewardParams, inflationRes, supplyRes, maintained] = await Promise.all([
    lcd.tryGet<{
      params: {
        external_chain_voting_inflation_rate: string;
        key_mgmt_relative_inflation_rate: string;
      };
    }>('/axelar/reward/v1beta1/params'),
    lcd.tryGet<{ inflation: string }>('/cosmos/mint/v1beta1/inflation'),
    lcd.tryGet<{ amount: { amount: string } }>(
      `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(chain.denom)}`,
    ),
    countMaintainedEvmChains(lcd, chain),
  ]);

  const supply = supplyRes ? num(supplyRes.amount.amount) : null;
  const votingRate = rewardParams
    ? num(rewardParams.params.external_chain_voting_inflation_rate)
    : null;
  if (!supply || votingRate === null || !maintained) return null;

  const base = (inflationRes ? num(inflationRes.inflation) : 0) ?? 0;
  const keyMgmtRate = rewardParams
    ? (num(rewardParams.params.key_mgmt_relative_inflation_rate) ?? 0)
    : 0;

  const inflation = base + base * keyMgmtRate + votingRate * maintained;
  if (inflation <= 0) return null;

  return { amount: inflation * supply, applyCommunityTax: true };
}

/**
 * 이 밸리데이터가 유지 중인 EVM 체인 수.
 *
 * 체인별로 maintainer 목록을 따로 받아야 해서 요청이 20회쯤 발생합니다.
 * 자주 바뀌는 값이 아니므로 KV 에 6시간 캐시합니다 (KV 가 없으면 매번 조회).
 */
async function countMaintainedEvmChains(
  lcd: Lcd,
  chain: CosmosChain,
): Promise<number | null> {
  const cached = await kvGet<number>(AXELAR_MAINTAINED_KEY);
  if (typeof cached === 'number' && cached > 0) return cached;

  const evmChains = await lcd.tryGet<{ chains: string[] }>(
    '/axelar/evm/v1beta1/chains',
  );
  if (!evmChains?.chains?.length) return null;

  const maintainerLists = await Promise.all(
    evmChains.chains.map((name) =>
      lcd.tryGet<{ maintainers: string[] }>(
        `/axelar/nexus/v1beta1/chain_maintainers/${encodeURIComponent(name)}`,
      ),
    ),
  );

  let count = 0;
  for (const list of maintainerLists) {
    if (list?.maintainers?.includes(chain.valoper)) count++;
  }
  if (count > 0) {
    await kvSet(AXELAR_MAINTAINED_KEY, count, AXELAR_MAINTAINED_TTL_SECONDS);
  }
  return count;
}

/**
 * 위임자 수. `pagination.count_total` 로 총 개수만 받아옵니다.
 * 공개 노드에 따라 이 쿼리를 막아둔 곳이 있어 실패하면 null 을 반환합니다.
 */
async function fetchDelegatorCount(
  lcd: Lcd,
  chain: CosmosChain,
): Promise<number | null> {
  const res = await lcd.tryGet<{ pagination: { total: string } }>(
    `/cosmos/staking/v1beta1/validators/${chain.valoper}/delegations` +
      '?pagination.limit=1&pagination.count_total=true',
  );
  return res?.pagination ? num(res.pagination.total) : null;
}
