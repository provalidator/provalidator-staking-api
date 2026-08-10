import type { StaticStats } from './types';

/**
 * APR 계산 전략.
 * - 'mint'    : 표준 x/mint 모듈 (annual_provisions 또는 inflation × supply)
 * - 'osmosis' : Osmosis epoch 기반 mint 모듈
 * - 'axelar'  : x/reward 모듈 — 밸리데이터가 유지하는 EVM 체인 수에 비례
 * - 'none'    : 인플레이션 기반 보상이 없음 → static 값 사용
 */
export type AprStrategy = 'mint' | 'osmosis' | 'axelar' | 'none';

interface BaseChain {
  id: string;
  projectTitle: string;
  token: string;
  /** CoinGecko 가격 조회용. 미등재 자산은 없을 수 있습니다. */
  coingeckoId?: string;
}

/** 밸리데이터를 운영하는 체인은 라이브 수집 실패 시 쓸 폴백 값을 갖습니다. */
interface ValidatorChain extends BaseChain {
  static: StaticStats;
}

export interface CosmosChain extends ValidatorChain {
  kind: 'cosmos';
  valoper: string;
  denom: string;
  exponent: number;
  /** 앞에서부터 시도, 실패하면 다음 엔드포인트로 failover */
  rest: string[];
  aprStrategy: AprStrategy;
}

export interface AptosChain extends ValidatorChain {
  kind: 'aptos';
  /** 밸리데이터 operator 주소. 여기서 스테이크 풀들을 역으로 찾습니다. */
  operator: string;
  /** 인덱서가 죽었을 때 쓸 알려진 풀 주소 (operator 조회 결과와 동일) */
  knownStakePools: string[];
  indexer: string;
  exponent: number;
  rest: string[];
}

export interface MonadChain extends ValidatorChain {
  kind: 'monad';
  /** 스테이킹 프리컴파일의 uint64 validatorId. 모르면 null → static 폴백. */
  validatorId: number | null;
  /** 참고용으로 남겨둔, 원래 받은 주소 */
  authAddress: string;
  exponent: number;
  rpc: string[];
}

/**
 * 밸리데이터를 운영하지 않고 가격·시총만 추적하는 자산.
 * 스테이킹 지표(위임량·커미션·APR·위임자)는 전부 null 로 나가고
 * total_assets_usd_value / total_delegators 합산에도 들어가지 않습니다.
 */
export interface AssetConfig extends BaseChain {
  kind: 'asset';
}

export type ChainConfig = CosmosChain | AptosChain | MonadChain | AssetConfig;

/** 자산에는 static 폴백이 없습니다. */
export function staticOf(chain: ChainConfig): StaticStats | undefined {
  return chain.kind === 'asset' ? undefined : chain.static;
}

function asset(
  id: string,
  projectTitle: string,
  token: string,
  coingeckoId?: string,
): AssetConfig {
  return { kind: 'asset', id, projectTitle, token, coingeckoId };
}

/**
 * REST 엔드포인트는 공개 노드 기본값입니다.
 * 프로발리데이터 자체 노드가 있으면 env 로 덮어쓰는 걸 권장합니다.
 *   REST_COSMOS=https://my-node.example.com
 * (아래 resolveRest() 참고)
 */
function resolveRest(id: string, defaults: string[]): string[] {
  const override = process.env[`REST_${id.toUpperCase()}`];
  return override ? [override, ...defaults] : defaults;
}

export const CHAINS: ChainConfig[] = [
  {
    kind: 'cosmos',
    id: 'agoric',
    projectTitle: 'Agoric',
    token: 'BLD',
    coingeckoId: 'agoric',
    valoper: 'agoricvaloper1xvz54pusznw8t76985kl3v2epduhyuscr4zxx3',
    denom: 'ubld',
    exponent: 6,
    aprStrategy: 'mint',
    rest: resolveRest('agoric', [
      'https://agoric-api.polkachu.com',
      'https://rest.cosmos.directory/agoric',
    ]),
    static: {
      fees: 10.0,
      apr: 0.11,
      token_price: 0.1983,
      staked_amount: 1_150_000_000,
      delegators: 1_150,
      market_cap: 250_000_000,
    },
  },
  {
    kind: 'cosmos',
    id: 'cosmos',
    projectTitle: 'Cosmos Hub',
    token: 'ATOM',
    coingeckoId: 'cosmos',
    valoper: 'cosmosvaloper1g48268mu5vfp4wk7dk89r0wdrakm9p5xk0q50k',
    denom: 'uatom',
    exponent: 6,
    aprStrategy: 'mint',
    // polkachu 를 1순위로 둡니다 — publicnode 는 delegations count_total 쿼리를 503 으로 막습니다.
    rest: resolveRest('cosmos', [
      'https://cosmos-api.polkachu.com',
      'https://cosmos-rest.publicnode.com',
      'https://rest.cosmos.directory/cosmoshub',
    ]),
    static: {
      fees: 5.0,
      apr: 0.145,
      token_price: 8.45,
      staked_amount: 285_000_000,
      delegators: 52_000,
      market_cap: 3_300_000_000,
    },
  },
  {
    kind: 'cosmos',
    id: 'osmosis',
    projectTitle: 'Osmosis',
    token: 'OSMO',
    coingeckoId: 'osmosis',
    valoper: 'osmovaloper1gy0nyn2hscxxayj2pdyu8axmfvv75nnvhc079s',
    denom: 'uosmo',
    exponent: 6,
    aprStrategy: 'osmosis',
    rest: resolveRest('osmosis', [
      'https://osmosis-api.polkachu.com',
      'https://osmosis-rest.publicnode.com',
      'https://rest.cosmos.directory/osmosis',
    ]),
    static: {
      fees: 5.0,
      apr: 0.105,
      token_price: 0.623,
      staked_amount: 390_000_000,
      delegators: 11_500,
      market_cap: 390_000_000,
    },
  },
  {
    kind: 'cosmos',
    id: 'axelar',
    projectTitle: 'Axelar',
    token: 'AXL',
    coingeckoId: 'axelar',
    valoper: 'axelarvaloper1u3asfwr2q0xhshj88sq4yvh89qluunefh270lz',
    denom: 'uaxl',
    exponent: 6,
    aprStrategy: 'axelar',
    rest: resolveRest('axelar', [
      'https://axelar-api.polkachu.com',
      'https://axelar-rest.publicnode.com',
      'https://rest.cosmos.directory/axelar',
    ]),
    static: {
      fees: 4.0,
      apr: 0.127,
      token_price: 1.85,
      staked_amount: 380_000_000,
      delegators: 15_000,
      market_cap: 1_200_000_000,
    },
  },
  {
    kind: 'cosmos',
    id: 'atomone',
    projectTitle: 'AtomOne',
    token: 'ATONE',
    coingeckoId: 'atomone',
    valoper: 'atonevaloper1g48268mu5vfp4wk7dk89r0wdrakm9p5xlxr0l9',
    denom: 'uatone',
    exponent: 6,
    aprStrategy: 'mint',
    rest: resolveRest('atomone', [
      'https://atomone-api.allinbits.services',
      'https://atomone-rest.publicnode.com',
      'https://rest.cosmos.directory/atomone',
    ]),
    static: {
      fees: 6.5,
      apr: 0.162,
      token_price: 5.1,
      staked_amount: 120_000_000,
      delegators: 9_000,
      market_cap: 850_000_000,
    },
  },

  {
    kind: 'aptos',
    id: 'aptos',
    projectTitle: 'Aptos',
    token: 'APT',
    coingeckoId: 'aptos',
    operator:
      '0xdfb7b8b27f5bbfd61dd76bacd2c5339a15b583e686b136bec586f00d50043b86',
    // operator 로 인덱서를 조회해 얻은 풀들. 인덱서 장애 시 폴백으로 씁니다.
    knownStakePools: [
      '0xaaf21bad66f3064d712e24f82819d7fb41031fc48a146aba8e271d375d177ff9',
      '0x4cc22e5d2e84794c3c672b0b34145898ee971a4ff042eabae23627547f6dac80',
    ],
    indexer: 'https://api.mainnet.aptoslabs.com/v1/graphql',
    exponent: 8,
    rest: resolveRest('aptos', ['https://api.mainnet.aptoslabs.com/v1']),
    static: {
      fees: 10.0,
      apr: 0.026,
      token_price: 7.25,
      staked_amount: 9_553_395,
      delegators: 0,
      market_cap: 7_800_000_000,
    },
  },
  {
    kind: 'monad',
    id: 'monad',
    projectTitle: 'Monad',
    token: 'MON',
    coingeckoId: 'monad',
    validatorId: 110,
    // 익스플로러에 쓰이는 주소. 온체인 authAddress(0x3673f7e6d7a26fb48d55cd28f0b1313dd84df7ff)
    // 와는 다르므로 주소로 validatorId 를 역추적할 수 없습니다.
    authAddress: '0x279FC7DdDB5D7cD6114A71e10e522B58CF868700',
    exponent: 18,
    rpc: (process.env.RPC_MONAD ? [process.env.RPC_MONAD] : []).concat([
      'https://rpc.monad.xyz',
      'https://monad.drpc.org',
    ]),
    static: {
      fees: 7.0,
      apr: 0.256,
      token_price: 0.35,
      staked_amount: 0,
      delegators: 0,
      market_cap: 10_000_000_000,
    },
  },

  // ---- 아래부터는 밸리데이터를 운영하지 않는 자산입니다 (가격·시총만) ----
  // CoinGecko id 는 실제 조회로 심볼까지 검증했습니다.
  asset('zetachain', 'Zetachain', 'ZETA', 'zetachain'),
  asset('persistence', 'Persistence', 'XPRT', 'persistence'),
  asset('nillion', 'Nillion', 'NIL', 'nillion'),
  // Noble 은 거버넌스 토큰이 CoinGecko 에 없습니다 (검색 결과가 브릿지된 USDC 뿐).
  asset('noble', 'Noble', 'NOBL'),
  asset('ssv', 'SSV Network', 'SSV', 'ssv-network'),
  asset('bitcoin', 'Bitcoin', 'BTC', 'bitcoin'),
  asset('ethereum', 'Ethereum', 'ETH', 'ethereum'),
  asset('solana', 'Solana', 'SOL', 'solana'),
  asset('usdc', 'USD Coin', 'USDC', 'usd-coin'),
  asset('hyperliquid', 'Hyperliquid', 'HYPE', 'hyperliquid'),
  // Story(IP) 도 CoinGecko 미등재입니다. 'story-2' 는 심볼이 DATA 인 다른 자산입니다.
  asset('story', 'Story', 'IP'),
  asset('dydx', 'dYdX', 'DYDX', 'dydx-chain'),
];

export const CHAINS_BY_ID = new Map(CHAINS.map((c) => [c.id, c]));

/** 'ATOM' / 'cosmos' 둘 다로 조회 가능 (PHP 버전은 token 심볼만 받았음) */
export function findChain(query: string): ChainConfig | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    CHAINS_BY_ID.get(q) ??
    CHAINS.find((c) => c.token.toLowerCase() === q) ??
    CHAINS.find((c) => c.projectTitle.toLowerCase() === q)
  );
}
