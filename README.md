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

Framer 가 체인마다 호출하고 있다면 `endpoint=chains` 한 번으로 바꾸는 걸 권장합니다.

### PHP 버전과 달라진 점

- 모든 수치가 **문자열이 아니라 number**
- `apr` 은 소수(`0.145`), `apr_percent` 는 백분율(`14.5`) — 둘 다 제공
- `global_stats` 는 체인 데이터에서 합산 계산
- 응답에 `source` 필드 추가: `live` | `cached` | `static`
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
      "market_cap": 3300000000,
      "source": "live",
      "timestamp": 1754800000
    }
  }
}
```

## 현재 데이터 소스

| 체인 | 상태 | 라이브로 수집되는 값 |
|---|---|---|
| Cosmos Hub, Osmosis, Axelar, Agoric, AtomOne | **live** | 커미션, 위임량, 위임자 수, 순 APR |
| Aptos, Monad | static | 전부 하드코딩 (`lib/chains.ts`) |

**가격 / 시가총액은 전 체인 하드코딩입니다.** CoinGecko 를 붙이려면 `lib/snapshot.ts` 의
`tokenPrice` 부분만 교체하면 됩니다 (`coingeckoId` 는 이미 설정에 들어 있습니다).

### APR 계산식

```
체인 APR      = 연간 신규발행량 × (1 - community_tax) / bonded_tokens
밸리데이터 APR = 체인 APR × (1 - 커미션)
```

Osmosis 는 epoch 기반 mint 모듈이라 별도 경로를 씁니다 (`epoch_provisions × 365 × staking 비율`).

### 알려진 한계 (실측 확인됨)

- **Axelar** — `x/mint` 의 `annual_provisions` 가 항상 `0` 입니다. Axelar 보상은 `x/reward` 모듈에서
  나오기 때문입니다. 현재는 APR 만 static(12.7%)으로 폴백하고 커미션·위임량·위임자 수는 라이브입니다.
  정확한 값이 필요하면 `x/reward` 전용 어댑터가 필요합니다.
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

- [ ] CoinGecko 가격/시총 연동 (`lib/snapshot.ts` 의 `tokenPrice`)
- [ ] Axelar `x/reward` 기반 APR 어댑터
- [ ] Osmosis taker fee 반영한 APR 보정
- [ ] Aptos 어댑터 — fullnode REST `/v1/accounts/{addr}/resource/0x1::stake::StakePool`
- [ ] Monad 어댑터 — 스테이킹 컨트랙트 조회
