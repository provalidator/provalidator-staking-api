import type { AssetConfig } from './chains';
import { kvGet, kvSet } from './kv';
import { Lcd, num } from './lcd';

/**
 * 우리가 밸리데이터를 운영하지 않는 자산의 **네트워크 기준 APR**.
 *
 * 밸리데이터 체인의 `apr` 은 "프로발리데이터에게 위임했을 때의 순 APR"이지만,
 * 여기서는 그 네트워크에서 스테이킹했을 때의 기준 APR(커미션 차감 전)을 냅니다.
 * 체인마다 보상 구조가 완전히 달라서 소스별로 따로 계산합니다.
 */
export type NetworkAprSource =
  | 'cosmos-mint'
  | 'zetachain'
  | 'solana'
  | 'ethereum'
  | 'hyperliquid';

const SECONDS_PER_YEAR = 31_536_000;
const TIMEOUT_MS = 8_000;

/** 네트워크 APR 은 분 단위로 흔들리지 않으므로 스냅샷보다 길게 캐시합니다. */
const CACHE_KEY = 'provalidator:network-apr:v1';
const CACHE_TTL_SECONDS = 600; // 10m

/** asset id → 네트워크 APR(소수). 계산 불가한 자산은 키가 없습니다. */
export async function fetchNetworkAprs(
  assets: AssetConfig[],
): Promise<Record<string, number>> {
  const targets = assets.filter((a) => a.networkApr);
  if (targets.length === 0) return {};

  const cached = await kvGet<Record<string, number>>(CACHE_KEY);
  if (cached && Object.keys(cached).length > 0) return cached;

  const results = await Promise.all(
    targets.map(async (asset) => {
      try {
        const apr = await computeApr(asset);
        return apr !== null && apr > 0 ? ([asset.id, apr] as const) : null;
      } catch (error) {
        console.error(`[${asset.id}] network APR failed:`, error);
        return null;
      }
    }),
  );

  const map = Object.fromEntries(results.filter((r) => r !== null));
  if (Object.keys(map).length > 0) await kvSet(CACHE_KEY, map, CACHE_TTL_SECONDS);
  return map;
}

function computeApr(asset: AssetConfig): Promise<number | null> {
  switch (asset.networkApr) {
    case 'cosmos-mint':
      return cosmosMintApr(asset);
    case 'zetachain':
      return zetachainApr(asset);
    case 'solana':
      return solanaApr();
    case 'ethereum':
      return ethereumApr();
    case 'hyperliquid':
      return hyperliquidApr();
    default:
      return Promise.resolve(null);
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 표준 x/mint 체인 (Persistence). 밸리데이터 체인과 같은 공식이되 커미션을 빼지 않습니다. */
async function cosmosMintApr(asset: AssetConfig): Promise<number | null> {
  if (!asset.rest?.length) return null;
  const lcd = new Lcd(asset.rest, TIMEOUT_MS);

  const [provisions, pool, dist] = await Promise.all([
    lcd.tryGet<{ annual_provisions: string }>(
      '/cosmos/mint/v1beta1/annual_provisions',
    ),
    lcd.tryGet<{ pool: { bonded_tokens: string } }>('/cosmos/staking/v1beta1/pool'),
    lcd.tryGet<{ params: { community_tax: string } }>(
      '/cosmos/distribution/v1beta1/params',
    ),
  ]);

  const annual = provisions ? num(provisions.annual_provisions) : null;
  const bonded = pool ? num(pool.pool.bonded_tokens) : null;
  if (!annual || !bonded) return null;

  const tax = dist ? (num(dist.params.community_tax) ?? 0) : 0;
  return (annual * (1 - tax)) / bonded;
}

/**
 * ZetaChain 은 x/mint 대신 x/emissions 를 씁니다.
 * 블록마다 고정량을 발행하고 그중 validator_emission_percentage 만 스테이커 몫입니다.
 * 블록 시간은 고정값이 아니라 최근 블록 2개로 실측합니다.
 */
async function zetachainApr(asset: AssetConfig): Promise<number | null> {
  if (!asset.rest?.length) return null;
  const lcd = new Lcd(asset.rest, TIMEOUT_MS);

  const [params, pool, dist, latest] = await Promise.all([
    lcd.tryGet<{
      params: { validator_emission_percentage: string; block_reward_amount: string };
    }>('/zeta-chain/emissions/params'),
    lcd.tryGet<{ pool: { bonded_tokens: string } }>('/cosmos/staking/v1beta1/pool'),
    lcd.tryGet<{ params: { community_tax: string } }>(
      '/cosmos/distribution/v1beta1/params',
    ),
    lcd.tryGet<{ block: { header: { height: string; time: string } } }>(
      '/cosmos/base/tendermint/v1beta1/blocks/latest',
    ),
  ]);

  const reward = params ? num(params.params.block_reward_amount) : null;
  const share = params ? num(params.params.validator_emission_percentage) : null;
  const bonded = pool ? num(pool.pool.bonded_tokens) : null;
  if (!reward || share === null || !bonded) return null;

  const blockSeconds = await measureBlockSeconds(lcd, latest?.block.header);
  if (!blockSeconds) return null;

  const blocksPerYear = SECONDS_PER_YEAR / blockSeconds;
  const tax = dist ? (num(dist.params.community_tax) ?? 0) : 0;
  return (reward * share * blocksPerYear * (1 - tax)) / bonded;
}

const BLOCK_SAMPLE_SPAN = 2_000;

async function measureBlockSeconds(
  lcd: Lcd,
  header: { height: string; time: string } | undefined,
): Promise<number | null> {
  if (!header) return null;
  const height = num(header.height);
  if (!height) return null;

  const older = await lcd.tryGet<{ block: { header: { time: string } } }>(
    `/cosmos/base/tendermint/v1beta1/blocks/${height - BLOCK_SAMPLE_SPAN}`,
  );
  if (!older) return null;

  const elapsed =
    (Date.parse(header.time) - Date.parse(older.block.header.time)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  return elapsed / BLOCK_SAMPLE_SPAN;
}

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Solana: 인플레이션은 총 발행량 기준이고 보상은 스테이커에게만 갑니다.
 *   APR = validator 인플레이션율 × 총 발행량 / 총 활성 스테이크
 */
async function solanaApr(): Promise<number | null> {
  const [rate, supply, votes] = await Promise.all([
    postJson<{ result: { validator: number } }>(SOLANA_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getInflationRate',
    }),
    postJson<{ result: { value: { total: number } } }>(SOLANA_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSupply',
      params: [{ excludeNonCirculatingAccountsList: true }],
    }),
    postJson<{
      result: {
        current: Array<{ activatedStake: number }>;
        delinquent: Array<{ activatedStake: number }>;
      };
    }>(SOLANA_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getVoteAccounts',
      params: [{ keepUnstakedDelinquents: false }],
    }),
  ]);

  const inflation = rate.result?.validator;
  const total = supply.result?.value?.total;
  const staked =
    (votes.result?.current ?? []).reduce((s, v) => s + v.activatedStake, 0) +
    (votes.result?.delinquent ?? []).reduce((s, v) => s + v.activatedStake, 0);

  if (!inflation || !total || !staked) return null;
  return (inflation * total) / staked;
}

/**
 * Ethereum 컨센서스 발행량은 스펙상 총 스테이크의 제곱근에 비례합니다.
 *   에포크당 총 보상(gwei) = BASE_REWARD_FACTOR × √(총 유효잔고)
 *   APR = 64 × 연간 에포크 수 / √(총 유효잔고)
 * (MEV·팁 제외한 발행 기준. ultrasound.money 가 보고하는 issuance APR 과 일치 확인함)
 */
const ETH_BASE_REWARD_FACTOR = 64;
const ETH_SECONDS_PER_EPOCH = 384;

async function ethereumApr(): Promise<number | null> {
  const body = await getJson<{ sum: number }>(
    'https://ultrasound.money/api/v2/fees/effective-balance-sum',
  );
  const gwei = body.sum;
  if (!gwei || gwei <= 0) return null;

  const epochsPerYear = SECONDS_PER_YEAR / ETH_SECONDS_PER_EPOCH;
  return (ETH_BASE_REWARD_FACTOR * epochsPerYear) / Math.sqrt(gwei);
}

/**
 * Hyperliquid 는 보상률이 총 스테이크의 제곱근에 반비례한다고만 공개하고
 * 앵커 값(400M 스테이크에서 연 2.37%)을 문서에 명시합니다. 그 앵커로 환산합니다.
 * 온체인 파라미터가 아니라 문서 기준값이라는 점에 유의하세요.
 */
const HYPE_ANCHOR_STAKE = 400_000_000;
const HYPE_ANCHOR_RATE = 0.0237;
const HYPE_DECIMALS = 1e8;

async function hyperliquidApr(): Promise<number | null> {
  const validators = await postJson<Array<{ stake: number | string }>>(
    'https://api.hyperliquid.xyz/info',
    { type: 'validatorSummaries' },
  );
  if (!Array.isArray(validators) || validators.length === 0) return null;

  const staked =
    validators.reduce((sum, v) => sum + Number(v.stake), 0) / HYPE_DECIMALS;
  if (!staked) return null;

  return HYPE_ANCHOR_RATE * Math.sqrt(HYPE_ANCHOR_STAKE / staked);
}
