/** 로컬 확인용: 실제 체인에서 스냅샷을 수집해 콘솔에 출력합니다. (배포에는 포함되지 않음) */
import { buildSnapshot, computeGlobalStats } from '../lib/snapshot';

async function main() {
  const started = Date.now();
  const snapshot = await buildSnapshot();
  const elapsed = Date.now() - started;

  const rows = Object.values(snapshot.projects).map((p) => ({
    token: p.token,
    chain: p.source,
    price: p.price_source,
    'fees%': p.fees,
    'apr%': p.apr_percent,
    staked: p.staked_amount === null ? null : Math.round(p.staked_amount),
    delegators: p.delegators,
    usd_price: p.token_price,
    usd: p.staked_amount_usd === null ? null : Math.round(p.staked_amount_usd),
  }));

  console.table(rows);
  console.log('global:', computeGlobalStats(snapshot));
  console.log(`elapsed: ${elapsed}ms`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
