import type { MonadChain } from './chains';
import { kvGet, kvSet } from './kv';
import type { LiveStats } from './types';

/**
 * Monad 어댑터.
 *
 * Monad 의 스테이킹은 컨트랙트가 아니라 프리컴파일(0x…1000)입니다.
 * 조회는 `getValidator(uint64 validatorId)` 하나로 끝납니다.
 *
 * ⚠️ 프리컴파일은 STATICCALL 을 거부하므로 view 함수들이 nonpayable 로 선언돼 있습니다.
 *    eth_call 은 CALL 로 동작하므로 정상 조회됩니다 (실측 확인).
 *
 * validatorId 는 주소로 역추적할 수 없습니다 — 익스플로러에 표시되는 주소와
 * 온체인 authAddress 가 다릅니다. lib/chains.ts 에 직접 넣어야 합니다.
 */

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001000';
/** getValidator(uint64) */
const GET_VALIDATOR_SELECTOR = '0x2b6d639a';
/** commission 은 1e18 스케일 고정소수입니다 (150000000000000000 = 15%). */
const COMMISSION_SCALE = 1e18;
const TIMEOUT_MS = 6_000;

/**
 * accRewardPerToken 의 스케일. 스테이크(1e18)당 보상(1e18)을 담는 누적값이라 1e36 입니다.
 * 다른 라운드 스케일(1e18·1e27)을 대입하면 APR 이 1e9 배 이상으로 튀어 실측상 배제됩니다.
 */
const ACC_REWARD_SCALE = 1e36;
const SECONDS_PER_YEAR = 31_536_000;

/**
 * APR 측정 구간. 블록이 약 0.3초라 12,000 블록이면 대략 1시간입니다.
 *
 * 구간을 길게 잡으면 밸리데이터가 액티브 셋에서 빠져 있던 기간이 섞여 값이 낮아집니다
 * (실측: 1시간 12.5% / 10시간 7.5% / 25시간 7.2%). 반대로 너무 짧으면 노이즈가 큽니다.
 * 0.5시간과 1시간이 12.7% / 12.5% 로 거의 같아 1시간을 씁니다.
 */
const APR_SAMPLE_BLOCKS = 12_000;
const APR_CACHE_KEY = 'provalidator:monad-apr:v1';
const APR_CACHE_TTL_SECONDS = 600;

export interface ValidatorInfo {
  authAddress: string;
  /** wei 단위 (MON 은 18 decimals) */
  stake: bigint;
  /** 0.15 = 15% */
  commission: number;
  /** 위임자에게 지급된 누적 보상(스테이크 1 단위당). 두 시점을 비교해 보상률을 역산합니다. */
  accRewardPerToken: bigint;
  /** 합의에 반영된 스테이크. 0 이면 액티브 셋에 없다는 뜻입니다. */
  consensusStake: bigint;
}

export async function fetchMonadStats(chain: MonadChain): Promise<LiveStats> {
  if (chain.validatorId === null) {
    throw new Error('monad validatorId is not configured in lib/chains.ts');
  }

  const info = await getValidator(chain.rpc, chain.validatorId);
  if (!info) throw new Error(`validator ${chain.validatorId} not found`);

  // 액티브 셋에 없으면 보상이 실제로 0 이므로 측정할 것도 없습니다.
  const apr =
    info.consensusStake === 0n ? 0 : await measureApr(chain).catch(() => null);

  return {
    fees: info.commission * 100,
    apr,
    staked_amount: Number(info.stake) / 10 ** chain.exponent,
    // 위임자 수는 delegate 이벤트를 전부 스캔해야 알 수 있어 요청당 조회로는 부적합합니다.
    delegators: null,
  };
}

/** 여러 RPC 를 순서대로 시도하는 JSON-RPC 호출. */
async function rpcCall<T>(
  rpcs: string[],
  method: string,
  params: unknown[],
): Promise<T> {
  let lastError: unknown;
  for (const rpc of rpcs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: unknown };
      if (body.result === undefined || body.result === null) {
        throw new Error(`rpc error: ${JSON.stringify(body.error)}`);
      }
      return body.result;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `monad ${method} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** blockTag 시점의 밸리데이터 상태. 기본은 최신 블록입니다. */
export async function getValidator(
  rpcs: string[],
  validatorId: number,
  blockTag = 'latest',
): Promise<ValidatorInfo | null> {
  const data = GET_VALIDATOR_SELECTOR + validatorId.toString(16).padStart(64, '0');
  const result = await rpcCall<string>(rpcs, 'eth_call', [
    { to: STAKING_PRECOMPILE, data },
    blockTag,
  ]);
  return decodeValidator(result);
}

/**
 * 실제 지급된 보상으로 APR 을 역산합니다.
 *
 * Monad 는 보상률 파라미터를 온체인에 노출하지 않지만, `accRewardPerToken` 이
 * 스테이크 1 단위당 누적 지급액이라 두 시점의 차이를 연율로 환산하면 실측 APR 이 나옵니다.
 * 이 누적값은 위임자에게 실제로 꽂히는 금액이므로 **커미션이 이미 차감된 순 APR** 입니다.
 */
async function measureApr(chain: MonadChain): Promise<number | null> {
  if (chain.validatorId === null) return null;

  const cached = await kvGet<number>(APR_CACHE_KEY);
  if (typeof cached === 'number' && cached > 0) return cached;

  const latest = await rpcCall<{ number: string; timestamp: string }>(
    chain.rpc,
    'eth_getBlockByNumber',
    ['latest', false],
  );
  const height = Number(BigInt(latest.number));
  const olderTag = `0x${(height - APR_SAMPLE_BLOCKS).toString(16)}`;

  const [now, before, olderBlock] = await Promise.all([
    getValidator(chain.rpc, chain.validatorId, latest.number),
    getValidator(chain.rpc, chain.validatorId, olderTag),
    rpcCall<{ timestamp: string }>(chain.rpc, 'eth_getBlockByNumber', [
      olderTag,
      false,
    ]),
  ]);
  if (!now || !before) return null;

  const elapsed = Number(BigInt(latest.timestamp) - BigInt(olderBlock.timestamp));
  if (elapsed <= 0) return null;

  // 큰 수끼리는 BigInt 로 먼저 빼서 정밀도 손실을 막습니다.
  const delta = Number(now.accRewardPerToken - before.accRewardPerToken);
  if (delta <= 0) return null;

  const apr = (delta / ACC_REWARD_SCALE) * (SECONDS_PER_YEAR / elapsed);
  if (!Number.isFinite(apr) || apr <= 0) return null;

  await kvSet(APR_CACHE_KEY, apr, APR_CACHE_TTL_SECONDS);
  return apr;
}

/**
 * 반환 튜플의 헤드 슬롯 배치 (각 32바이트):
 *   0 authAddress · 1 flags · 2 stake · 3 accRewardPerToken · 4 commission · …
 */
function decodeValidator(result: string): ValidatorInfo | null {
  const hex = result.startsWith('0x') ? result.slice(2) : result;
  // 정적 헤드 슬롯 10개(마지막 두 개는 bytes 오프셋)까지 읽습니다.
  if (hex.length < 640) return null;

  const slot = (n: number) => hex.slice(n * 64, (n + 1) * 64);
  const authAddress = slot(0).slice(24);
  if (/^0+$/.test(authAddress)) return null; // 존재하지 않는 validatorId

  return {
    authAddress: `0x${authAddress}`,
    stake: BigInt(`0x${slot(2)}`),
    accRewardPerToken: BigInt(`0x${slot(3)}`),
    commission: Number(BigInt(`0x${slot(4)}`)) / COMMISSION_SCALE,
    consensusStake: BigInt(`0x${slot(6)}`),
  };
}
