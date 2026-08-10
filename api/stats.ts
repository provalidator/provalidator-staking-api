import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findChain } from '../lib/chains';
import { applyCors } from '../lib/cors';
import { kvEnabled, kvGet, kvSet } from '../lib/kv';
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

  // 진단용. KV 가 실제로 붙었는지 확인합니다 (환경변수만 보는 게 아니라 왕복 테스트).
  if (endpoint === 'health') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ message: 'Success', data: await checkKv() });
    return;
  }

  // PHP 버전은 `chain_id` 를 썼지만 실제로는 토큰 심볼이었습니다.
  // `chain` 도 자연스럽게 손이 가는 이름이라 별칭으로 받습니다.
  const chainQuery =
    first(req.query.token) || first(req.query.chain_id) || first(req.query.chain);

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
          error: chainQuery
            ? `Token or chain '${chainQuery}' not found.`
            : "Missing token. Use ?endpoint=chain_stats&token=ATOM (aliases: chain_id, chain), or ?endpoint=chains for all chains.",
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
          "Invalid endpoint. Supported: 'chains', 'chain_stats', 'global_stats', 'health'.",
      });
    }
  }
}

/** 환경변수 존재 여부가 아니라 실제 쓰기·읽기 왕복으로 KV 연결을 확인합니다. */
async function checkKv() {
  if (!kvEnabled) {
    return {
      kv_configured: false,
      kv_working: false,
      hint: 'KV_REST_API_URL / KV_REST_API_TOKEN 이 없습니다. Upstash 연결 후 재배포가 필요합니다.',
    };
  }

  const probeKey = 'provalidator:health-probe';
  const token = String(Math.floor(Date.now() / 1000));
  await kvSet(probeKey, token, 60);
  const readBack = await kvGet<string>(probeKey);

  return {
    kv_configured: true,
    kv_working: readBack === token,
    snapshot_cached: (await kvGet<unknown>('provalidator:snapshot:v1')) !== null,
    axelar_chain_count_cached:
      (await kvGet<number>('provalidator:axelar:maintained:v1')) ?? null,
  };
}

function send(res: VercelResponse, status: number, body: unknown): void {
  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.setHeader('CDN-Cache-Control', CACHE_CONTROL);
  res.status(status).json(body);
}
