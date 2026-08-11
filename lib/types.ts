/**
 * 응답에 실리는 체인 1개의 스탯.
 *
 * PHP 버전과 달리 모든 수치는 문자열이 아니라 number 로 내려갑니다.
 * - `apr`         : 백분율, 소수점 2자리 (14.5 = 14.5%)
 * - `apr_percent` : 백분율 (14.5) — `apr` 과 동일한 값
 * - `fees`        : 커미션 백분율 (5.0)
 *
 * apr 과 apr_percent 가 같은 값인 건 의도적입니다. 프론트가 apr 을 그대로 % 로
 * 붙여 쓰고 있어서, 소수(0.145)를 내보내면 화면에 100배 작게 표시됩니다.
 */
/** live = 방금 수집 / cached = 마지막 성공 스냅샷 / static = 하드코딩 폴백 / none = 해당 없음 */
export type DataSource = 'live' | 'cached' | 'static' | 'none';

export interface ProjectStats {
  chain_id: string;
  project_title: string;
  token: string;
  /**
   * validator = 프로발리데이터가 밸리데이터를 운영하는 체인 (스테이킹 지표 있음)
   * asset     = 가격만 추적하는 자산 (스테이킹 지표는 전부 null)
   */
  type: 'validator' | 'asset';
  fees: number | null;
  apr: number | null;
  apr_percent: number | null;
  /** CoinGecko 로고 URL. 프론트에서 아이콘을 직접 관리하지 않아도 됩니다. */
  logo: string | null;
  token_price: number | null;
  staked_amount: number | null;
  staked_amount_usd: number | null;
  delegators: number | null;
  market_cap: number | null;
  /** 체인 데이터 출처. type='asset' 이면 항상 'none' 입니다. */
  source: DataSource;
  /** 가격·시총 출처. 체인 데이터와 독립적으로 폴백됩니다 (CoinGecko 만 죽는 경우가 있음). */
  price_source: DataSource;
  /** 이 체인 데이터가 실제로 수집된 시각 (unix seconds) */
  timestamp: number;
}

/** 체인에서 라이브로 채울 수 있는 필드들. 나머지는 static 설정에서 채웁니다. */
export type LiveStats = Partial<
  Pick<
    ProjectStats,
    'fees' | 'apr' | 'staked_amount' | 'delegators'
  >
>;

/** 하드코딩 폴백 값 (체인이 죽었거나 아직 어댑터가 없을 때 사용) */
export interface StaticStats {
  fees: number;
  apr: number;
  token_price: number;
  staked_amount: number;
  delegators: number;
  market_cap: number;
}

export interface GlobalStats {
  total_assets_usd_value: number;
  total_delegators: number;
  total_chains: number;
  timestamp: number;
}

export interface Snapshot {
  generated_at: number;
  /** chain id 로 키잉 (예: 'cosmos', 'osmosis') */
  projects: Record<string, ProjectStats>;
}
