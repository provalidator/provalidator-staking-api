# ProValidator Staking API

Vercel Functions 기반 스테이킹 스탯 API. 기존 `provalidator_info_api.php` 대체용.

## 왜 JSON 파일 저장을 안 쓰는가

Vercel 서버리스 함수의 파일시스템은 읽기 전용이고, `/tmp` 는 인스턴스마다 따로 존재하다 사라집니다.
크론이 A 인스턴스에 JSON 을 써도 사용자 요청은 B 인스턴스로 갑니다.

대신 **CDN 캐시 + KV 폴백** 2단 구조를 씁니다:

```
요청 → Vercel Edge CDN
        ├─ 캐시 hit (60초 이내)      → 즉시 응답, 함수 실행 0회
        └─ 캐시 stale/miss           → 함수 실행
                                        ├─ Cosmos LCD 병렬 수집 → Upstash KV 저장 → 응답
                                        └─ 수집 실패 → KV 의 마지막 성공값 → 없으면 static 폴백
```

`stale-while-revalidate` 덕분에, 캐시가 만료돼도 사용자는 옛날 값을 즉시 받고 갱신은 백그라운드에서 일어납니다.
체인 RPC 가 느리거나 죽어도 응답 속도와 가용성이 유지됩니다. **크론 불필요.**

## 엔드포인트

베이스: `/api/stats` (`/provalidator_info_api.php` 로도 접근 가능 — `vercel.json` rewrite)

| 요청 | 설명 |
|---|---|
| `?endpoint=chains` | **신규.** 전체 체인 + 글로벌 스탯을 한 번에 |
| `?endpoint=chain_stats&token=ATOM` | 체인 1개 (`chain_id=ATOM` 도 동일하게 동작) |
| `?endpoint=global_stats` | 합산 스탯 (하드코딩 아님 — 체인 데이터에서 계산) |
| `?endpoint=health` | 진단용. KV 연결 상태를 왕복 테스트로 확인 (캐시 안 함) |

Framer 가 체인마다 호출하고 있다면 `endpoint=chains` 한 번으로 바꾸는 걸 권장합니다.

### PHP 버전과 달라진 점

- 모든 수치가 **문자열이 아니라 number**
- `apr` 은 소수(`0.145`), `apr_percent` 는 백분율(`14.5`) — 둘 다 제공
- `global_stats` 는 체인 데이터에서 합산 계산
- 응답에 `source` / `price_source` 필드 추가: `live` | `cached` | `static`
- `chain_id` → `token` 으로 이름 정리 (구 파라미터도 계속 동작)

### 응답 예시

```json
{
  "message": "Success",
  "data": {
    "project": {
      "chain_id": "cosmos",
      "project_title": "Cosmos Hub",
      "token": "ATOM",
      "fees": 5.0,
      "apr": 0.1421,
      "apr_percent": 14.21,
      "token_price": 8.45,
      "staked_amount": 1234567.89,
      "staked_amount_usd": 10432098.67,
      "delegators": 5231,
      "market_cap": 727053354.99,
      "source": "live",
      "price_source": "live",
      "timestamp": 1754800000
    }
  }
}
```

## 현재 데이터 소스

| 체인 | 체인 데이터 | 가격 / 시총 |
|---|---|---|
| Cosmos Hub, Osmosis, Axelar, Agoric, AtomOne | **live** (커미션, 위임량, 위임자 수, 순 APR) | **live** (CoinGecko) |
| Aptos | **live** (커미션, 위임량, 순 APR) | **live** (CoinGecko) |
| Monad | **live** (커미션, 위임량) | **live** (CoinGecko) |

체인 데이터와 가격은 **서로 독립적으로 폴백**합니다. CoinGecko 만 죽어도 체인 수치는 라이브로 나가고,
반대도 마찬가지입니다. 응답의 `source` / `price_source` 필드로 각각 어디서 왔는지 확인할 수 있습니다.

가격은 CoinGecko `simple/price` 를 요청 1회로 전 체인 조회합니다. 키 없이 동작하지만 429 가 보이면
`COINGECKO_API_KEY` 에 무료 demo 키를 넣으세요.

**위임자 수(`delegators`)에는 static 폴백이 없습니다.** 실제로 셀 수 없으면 `null` 을 내보냅니다.
하드코딩된 숫자를 대신 채우면 `total_delegators` 가 조용히 부풀려지기 때문입니다.
Aptos 와 Monad 는 구조상 이 값을 못 세므로 항상 `null` 입니다 (아래 참고).

### Aptos

`0x1::delegation_pool` 이 아니라 `0x1::staking_contract` 모델입니다 — 공개 위임 풀이 아니라
staker ↔ operator 1:1 계약이라 **공개 위임자라는 개념이 없습니다** (`delegators: null`).

operator 주소로 인덱서를 조회해 스테이크 풀들을 찾고, 각 풀의 `0x1::stake::StakePool` 에서
`active + pending_active` 를 합산합니다 (`pending_inactive` 는 언본딩 중이라 제외).
커미션은 풀이 아니라 staker 계정의 `0x1::staking_contract::Store` 에 operator 별로 들어 있습니다.

APR 은 `StakingRewardsConfig.rewards_rate`(FixedPoint64) × 연간 에포크 수로 계산합니다.
`StakingConfig.rewards_rate` 는 거버넌스로 갱신되지 않는 레거시 필드라 값이 다릅니다
(레거시 기준 7.0%, 실제 2.60%). 현재 `rewards_rate == min_rewards_rate` 로 하한에 도달한 상태입니다.

### Monad

스테이킹이 컨트랙트가 아니라 **프리컴파일**(`0x…1000`)이고, `getValidator(uint64 validatorId)`
하나로 조회됩니다. 프리컴파일은 STATICCALL 을 거부하지만 `eth_call` 은 CALL 이라 정상 동작합니다.

> ⚠️ **validatorId 는 주소로 역추적할 수 없습니다.** 익스플로러에 쓰이는 주소
> (`0x279FC7…`)와 온체인 `authAddress`(`0x3673f7e6…`)가 다릅니다.
> 밸리데이터 221개를 전수 조회해도 매칭되지 않으므로 `lib/chains.ts` 에 id 를 직접 넣어야 합니다.

Monad 는 보상률을 온체인에 노출하지 않아 APR 은 static 폴백입니다. 단 `consensusStake == 0`
(= 액티브 셋에 없음)이면 실제 보상이 0 이므로 `apr: 0` 으로 보고합니다.

### APR 계산식

```
체인 APR      = 연간 신규발행량 × (1 - community_tax) / bonded_tokens
밸리데이터 APR = 체인 APR × (1 - 커미션)
```

Osmosis 는 epoch 기반 mint 모듈이라 별도 경로를 씁니다 (`epoch_provisions × 365 × staking 비율`).

**Axelar 는 `x/mint` 를 쓰지 않습니다** (`annual_provisions` 가 항상 0). 보상이 `x/reward` 모듈에서
나오고, 인플레이션이 **밸리데이터가 유지하는 EVM 체인 수**에 비례합니다:

```
inflation = base + base × key_mgmt_relative_rate
                 + external_chain_voting_rate × 유지 중인 EVM 체인 수
```

즉 같은 Axelar 라도 밸리데이터마다 APR 이 다릅니다. 현재 프로발리데이터는 EVM 체인 20개를
전부 유지 중이고 `external_chain_voting_inflation_rate` 가 0.002 이므로 인플레이션은 4% 입니다.
체인 수 집계는 체인마다 maintainer 목록을 받아야 해서 요청이 20회쯤 발생하는데, 거의 안 바뀌는
값이라 KV 에 6시간 캐시합니다 (KV 가 없으면 매 스냅샷마다 조회합니다).

### 알려진 한계 (실측 확인됨)

- **Osmosis** — mint 기반 계산은 약 1.8% 로 나옵니다. Osmosis 는 taker fee 도 스테이커에게 분배하는데
  이 공식에는 잡히지 않아 **과소 추정**입니다. 실 수치가 중요하면 별도 보정이 필요합니다.
- **AtomOne** — 약 47% 로 나옵니다 (인플레 20% + 낮은 본딩 비율). distribution 파라미터에
  `nakamoto_bonus` 라는 커스텀 항목이 있어 표준 공식은 근사치입니다.
- **위임자 수** — publicnode 는 `pagination.count_total` 쿼리를 503 으로 막습니다.
  그래서 polkachu 계열을 1순위 엔드포인트로 두었습니다 (실패 시 자동 failover).

## 로컬 실행

```bash
npm install
```

체인 수집 결과만 표로 확인 (서버 없이):

```bash
npm run probe
```

HTTP 레이어까지 포함해 로컬 서버 구동:

```bash
npm run serve
```

```bash
curl "http://localhost:3000/api/stats?endpoint=chains"
```

Vercel 런타임을 그대로 재현하려면 `npx vercel dev` 를 쓰세요.

## 배포

```bash
npx vercel --prod
```

환경변수는 전부 선택 사항입니다 (`.env.example` 참고). 아무것도 없어도 공개 노드로 동작합니다.

프로덕션에서는 두 가지를 권장합니다:
1. Vercel 대시보드에서 Upstash Redis 연결 → KV 폴백 활성화 (업스트림 장애 시 무중단)
2. `REST_*` 환경변수로 자체 노드 지정 → 공개 노드 rate limit 회피

## 다음 작업

- [x] CoinGecko 가격/시총 연동 (`lib/prices.ts`)
- [x] Aptos 어댑터 (`lib/aptos.ts`)
- [x] Monad 어댑터 (`lib/monad.ts`)
- [x] Axelar `x/reward` 기반 APR
- [ ] Osmosis taker fee 반영한 APR 보정
- [ ] Monad APR — 온체인 소스가 없어 현재 static 폴백
