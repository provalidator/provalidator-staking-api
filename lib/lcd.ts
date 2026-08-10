const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * Cosmos LCD(REST) 클라이언트.
 * 여러 엔드포인트를 순서대로 시도하고, 한 번 성공한 엔드포인트를 고정(pin)해서
 * 이후 요청은 같은 노드로 보냅니다 (노드 간 블록 높이 불일치 방지).
 */
export class Lcd {
  private pinned: string | null = null;

  constructor(
    private readonly bases: string[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async get<T>(path: string): Promise<T> {
    const order = this.pinned
      ? [this.pinned, ...this.bases.filter((b) => b !== this.pinned)]
      : this.bases;

    let lastError: unknown;
    for (const base of order) {
      try {
        const data = await this.fetchOnce(base.replace(/\/$/, '') + path);
        this.pinned = base;
        return data as T;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `LCD request failed: ${path} (${lastError instanceof Error ? lastError.message : String(lastError)})`,
    );
  }

  /** 실패해도 예외를 던지지 않는 버전. 선택적 필드 조회에 사용합니다. */
  async tryGet<T>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch {
      return null;
    }
  }

  private async fetchOnce(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** LCD 는 큰 정수를 문자열로 반환합니다. 안전하게 number 로 변환. */
export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
