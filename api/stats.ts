import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findChain } from '../lib/chains';
import { applyCors } from '../lib/cors';
import { buildSnapshot, computeGlobalStats } from '../lib/snapshot';
import type { Snapshot } from '../lib/types';

/**
 * CDN 캐시 정책 — 여기가 이 API 의 핵심입니다.
 *
 * s-maxage=60            : Vercel Edge 가 60초 동안 캐시된 JSON 을 그대로 응답 (함수 실행 0회)
 * stale-while-revalidate : 60초가 지나도 옛날 값을 "즉시" 주고 백그라운드에서 갱신
 *                          → 사용자는 체인 RPC 지연을 절대 체감하지 않습니다.
 *
 * 즉, "1분마다 JSON 파일에 저장" 이 이 헤더 한 줄로 대체됩니다. 크론 불필요.
 */
const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=600';

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  applyCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ message: 'Error', error: 'Method not allowed.' });
    return;
  }

  const endpoint = first(req.query.endpoint) || 'chain_stats';
  // PHP 버전은 `chain_id` 를 썼지만 실제로는 토큰 심볼이었습니다. 둘 다 받습니다.
  const chainQuery = first(req.query.token) || first(req.query.chain_id);

  let snapshot: Snapshot;
  try {
    snapshot = await buildSnapshot();
  } catch (error) {
    console.error('snapshot build failed:', error);
    res.status(503).json({ message: 'Error', error: 'Upstream data unavailable.' });
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  switch (endpoint) {
    case 'global_stats': {
      send(res, 200, { message: 'Success', data: computeGlobalStats(snapshot) });
      return;
    }

    // 신규: 전체 체인을 한 번에. Framer 가 체인마다 호출할 필요가 없어집니다.
    case 'chains': {
      send(res, 200, {
        message: 'Success',
        data: {
          projects: Object.values(snapshot.projects),
          global: computeGlobalStats(snapshot),
        },
      });
      return;
    }

    case 'chain_stats': {
      const chain = chainQuery ? findChain(chainQuery) : undefined;
      const project = chain ? snapshot.projects[chain.id] : undefined;
      if (!project) {
        // 404 는 짧게만 캐시 — 체인을 새로 추가했을 때 바로 반영되도록.
        res.setHeader('Cache-Control', 'public, s-maxage=30');
        res.status(404).json({
          message: 'Error',
          error: `Token or chain '${chainQuery}' not found.`,
          supported: Object.values(snapshot.projects).map((p) => p.token),
        });
        return;
      }
      send(res, 200, { message: 'Success', data: { project } });
      return;
    }

    default: {
      res.setHeader('Cache-Control', 'no-store');
      res.status(400).json({
        message: 'Error',
        error:
          "Invalid endpoint. Supported: 'chains', 'chain_stats', 'global_stats'.",
      });
    }
  }
}

function send(res: VercelResponse, status: number, body: unknown): void {
  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.setHeader('CDN-Cache-Control', CACHE_CONTROL);
  res.status(status).json(body);
}
