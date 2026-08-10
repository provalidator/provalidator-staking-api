import type { StaticStats } from './types';

/**
 * APR 계산 전략.
 * - 'mint'    : 표준 x/mint 모듈 (annual_provisions 또는 inflation × supply)
 * - 'osmosis' : Osmosis epoch 기반 mint 모듈
 * - 'none'    : 인플레이션 기반 보상이 없음 → static 값 사용
 */
export type AprStrategy = 'mint' | 'osmosis' | 'none';

interface BaseChain {
  id: string;
  projectTitle: string;
  token: string;
  /** 나중에 CoinGecko 붙일 때 사용 (현재는 미사용) */
  coingeckoId?: string;
  /** 라이브 수집 실패 시 폴백. 지금은 Aptos/Monad 가 항상 이 값을 씁니다. */
  static: StaticStats;
}

export interface CosmosChain extends BaseChain {
  kind: 'cosmos';
  valoper: string;
  denom: string;
  exponent: number;
  /** 앞에서부터 시도, 실패하면 다음 엔드포인트로 failover */
  rest: string[];
  aprStrategy: AprStrategy;
}

export interface ExternalChain extends BaseChain {
  kind: 'external';
  address: string;
  note: string;
}

export type ChainConfig = CosmosChain | ExternalChain;

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
    aprStrategy: 'mint',
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

  // ---- 아직 라이브 어댑터 없음: 항상 static 값을 반환합니다 ----
  {
    kind: 'external',
    id: 'aptos',
    projectTitle: 'Aptos',
    token: 'APT',
    coingeckoId: 'aptos',
    address:
      '0xdfb7b8b27f5bbfd61dd76bacd2c5339a15b583e686b136bec586f00d50043b86',
    note: 'Aptos fullnode REST (/v1/accounts/{addr}/resource/0x1::stake::StakePool) 어댑터 필요',
    static: {
      fees: 3.0,
      apr: 0.078,
      token_price: 7.25,
      staked_amount: 750_000_000,
      delegators: 48_000,
      market_cap: 7_800_000_000,
    },
  },
  {
    kind: 'external',
    id: 'monad',
    projectTitle: 'Monad',
    token: 'MON',
    coingeckoId: 'monad',
    address: '0x279FC7DdDB5D7cD6114A71e10e522B58CF868700',
    note: 'Monad staking contract 조회 어댑터 필요',
    static: {
      fees: 7.0,
      apr: 0.256,
      token_price: 0.35,
      staked_amount: 4_500_000_000,
      delegators: 2_500,
      market_cap: 10_000_000_000,
    },
  },
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
