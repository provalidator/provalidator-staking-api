import type { MonadChain } from './chains';
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

export interface ValidatorInfo {
  authAddress: string;
  /** wei 단위 (MON 은 18 decimals) */
  stake: bigint;
  /** 0.15 = 15% */
  commission: number;
  /** 합의에 반영된 스테이크. 0 이면 액티브 셋에 없다는 뜻입니다. */
  consensusStake: bigint;
}

export async function fetchMonadStats(chain: MonadChain): Promise<LiveStats> {
  if (chain.validatorId === null) {
    throw new Error('monad validatorId is not configured in lib/chains.ts');
  }

  const info = await getValidator(chain.rpc, chain.validatorId);
  if (!info) throw new Error(`validator ${chain.validatorId} not found`);

  return {
    fees: info.commission * 100,
    // Monad 는 온체인에서 보상률을 노출하지 않으므로 보통은 static 으로 폴백합니다.
    // 다만 액티브 셋에 없으면(consensusStake = 0) 실제 보상이 0 이므로 그렇게 보고합니다.
    apr: info.consensusStake === 0n ? 0 : null,
    staked_amount: Number(info.stake) / 10 ** chain.exponent,
    // 위임자 수는 delegate 이벤트를 전부 스캔해야 알 수 있어 요청당 조회로는 부적합합니다.
    delegators: null,
  };
}

/** 여러 RPC 를 순서대로 시도합니다. */
export async function getValidator(
  rpcs: string[],
  validatorId: number,
): Promise<ValidatorInfo | null> {
  const data = GET_VALIDATOR_SELECTOR + validatorId.toString(16).padStart(64, '0');

  let lastError: unknown;
  for (const rpc of rpcs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: STAKING_PRECOMPILE, data }, 'latest'],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: string; error?: unknown };
      if (!body.result) throw new Error(`rpc error: ${JSON.stringify(body.error)}`);
      return decodeValidator(body.result);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `monad getValidator failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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
    commission: Number(BigInt(`0x${slot(4)}`)) / COMMISSION_SCALE,
    consensusStake: BigInt(`0x${slot(6)}`),
  };
}
