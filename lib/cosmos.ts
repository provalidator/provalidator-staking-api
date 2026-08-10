import type { CosmosChain } from './chains';
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

async function fetchAnnualProvisions(
  lcd: Lcd,
  chain: CosmosChain,
): Promise<AnnualProvisions | null> {
  if (chain.aprStrategy === 'none') return null;

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
