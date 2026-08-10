/**
 * 로컬 확인용 미니 서버. Vercel CLI 없이 api/stats.ts 핸들러를 그대로 구동합니다.
 * (배포에는 포함되지 않음 — 실제 로컬 개발은 `npx vercel dev` 를 쓰세요.)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/stats';

const PORT = Number(process.env.PORT ?? 3000);

function adapt(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const vercelReq = Object.assign(req, { query, cookies: {}, body: undefined });
  const vercelRes = Object.assign(res, {
    status(code: number) {
      res.statusCode = code;
      return vercelRes;
    },
    json(body: unknown) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body, null, 2));
      return vercelRes;
    },
    send(body: unknown) {
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
      return vercelRes;
    },
    redirect() {
      return vercelRes;
    },
  });

  return {
    req: vercelReq as unknown as VercelRequest,
    res: vercelRes as unknown as VercelResponse,
  };
}

createServer((rawReq, rawRes) => {
  const { req, res } = adapt(rawReq, rawRes);
  void handler(req, res);
}).listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}/api/stats?endpoint=chains`);
});
