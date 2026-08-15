import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildSnapshot, computeGlobalStats } from '../lib/snapshot';

/**
 * 스냅샷 강제 갱신 엔드포인트. Vercel Cron 이 호출합니다 (vercel.json 의 `crons`).
 *
 * 일반 요청 경로와 달리 `force: true` 로 신선도 게이트를 건너뛰고 항상 새로 수집합니다.
 * 무거운 주기 작업(Solana getVoteAccounts, Monad 아카이브 조회, Axelar 체인 수 집계)을
 * 방문자 요청 대신 여기서 치르는 게 목적입니다.
 *
 * ⚠️ 방문자가 기다리지 않는 이유는 크론이 아니라 stale-while-revalidate 입니다.
 *    크론은 CDN 캐시가 아예 비어 있는 콜드 상태를 줄여주는 보조 수단입니다.
 *
 * 보안: CRON_SECRET 환경변수를 설정하면 Vercel 이 Authorization 헤더에 실어 보내고,
 * 여기서 일치하지 않는 요청을 거부합니다. 설정하지 않으면 검사하지 않습니다.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ message: 'Error', error: 'Unauthorized.' });
    return;
  }

  // 갱신 결과는 절대 캐시하지 않습니다.
  res.setHeader('Cache-Control', 'no-store');

  const startedAt = Date.now();
  try {
    const snapshot = await buildSnapshot({ force: true });
    const projects = Object.values(snapshot.projects);

    res.status(200).json({
      message: 'Success',
      data: {
        generated_at: snapshot.generated_at,
        elapsed_ms: Date.now() - startedAt,
        chains: projects.length,
        live: projects.filter((p) => p.source === 'live').length,
        priced: projects.filter((p) => p.price_source === 'live').length,
        with_apr: projects.filter((p) => p.apr !== null).length,
        global: computeGlobalStats(snapshot),
      },
    });
  } catch (error) {
    console.error('refresh failed:', error);
    res.status(500).json({
      message: 'Error',
      error: 'Snapshot refresh failed.',
      elapsed_ms: Date.now() - startedAt,
    });
  }
}
