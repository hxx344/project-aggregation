type Endpoint = 'exchangeInfo' | 'premiumIndex' | 'fundingInfo';
type FailureKind = 'timeout' | 'network' | 'http' | 'invalid_json' | 'invalid_data';
type FailureOptions = { httpStatus?: number; retryAt?: number };
const labels = { exchangeInfo: '合约信息', premiumIndex: '标记价格', fundingInfo: '资金费周期', quote: '报价校验' };
const transientStatuses = new Set([408, 500, 502, 503, 504]);
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

/** Application-owned diagnostics only: never expose provider bodies or URLs. */
export class BinanceQuoteError extends Error {
  readonly endpoint: Endpoint | 'quote';
  readonly kind: FailureKind;
  readonly httpStatus?: number;
  readonly retryAt?: number;
  constructor(endpoint: Endpoint | 'quote', kind: FailureKind, options: FailureOptions = {}) {
    super('Binance public quote read failed');
    this.name = 'BinanceQuoteError';
    this.endpoint = endpoint;
    this.kind = kind;
    this.httpStatus = options.httpStatus;
    this.retryAt = options.retryAt;
  }
}

export function formatBinanceQuoteError(error: unknown): string | null {
  if (!(error instanceof BinanceQuoteError)) return null;
  const label = Object.hasOwn(labels, error.endpoint) ? labels[error.endpoint] : '行情';
  const status = Number.isInteger(error.httpStatus) && error.httpStatus! >= 400 && error.httpStatus! <= 599 ? error.httpStatus : null;
  const detail = error.kind === 'timeout' ? '请求超时' : error.kind === 'network' ? '网络连接失败'
    : error.kind === 'invalid_json' ? '响应格式无效' : error.kind === 'invalid_data' ? '数据不完整或时间无效'
      : status === 429 ? '请求受限（HTTP 429），等待限流冷却'
        : status === 418 ? 'IP 暂时受限（HTTP 418），等待冷却'
          : status !== null ? `请求失败（HTTP ${status}）` : '读取失败';
  return `Binance ${label}${detail}；保留上次成功数据，后台将自动重试。`;
}

function retryDeadline(value: string | null, now: number, fallback: number) {
  if (value !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
    if (Number.isSafeInteger(deadline) && deadline > now) return deadline;
  }
  return now + fallback;
}

function transportKind(error: unknown, signal: AbortSignal, fetching = false): FailureKind | null {
  const value = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  if (signal.aborted || value?.name === 'TimeoutError') return 'timeout';
  if (networkCodes.has(value?.code ?? '') || networkCodes.has(value?.cause?.code ?? '')
      || fetching && value?.name === 'TypeError') return 'network';
  return null;
}

/** Bounded retries for public GETs only. The caller owns shared in-flight reads. */
export function createBinanceQuoteRequest({ fetcher = fetch, clock = Date.now,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: { fetcher?: typeof fetch; clock?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const limited = new Map<Endpoint, number>();
  let bannedUntil = 0;
  function checkCooldown(endpoint: Endpoint) {
    const now = clock(), until = limited.get(endpoint) ?? 0;
    if (now < bannedUntil) throw new BinanceQuoteError(endpoint, 'http', { httpStatus: 418, retryAt: bannedUntil });
    if (now < until) throw new BinanceQuoteError(endpoint, 'http', { httpStatus: 429, retryAt: until });
  }
  async function attempt(endpoint: Endpoint) {
    checkCooldown(endpoint);
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try { response = await fetcher(`https://fapi.binance.com/fapi/v1/${endpoint}`, { cache: 'no-store', signal }); }
    catch (error) {
      const kind = transportKind(error, signal, true);
      if (kind) throw new BinanceQuoteError(endpoint, kind);
      throw error;
    }
    if (!response.ok) {
      const status = response.status;
      let retryAt: number | undefined;
      if (status === 429 || status === 418) {
        retryAt = retryDeadline(response.headers.get('retry-after'), clock(), status === 418 ? 120_000 : 60_000);
        if (status === 418) bannedUntil = Math.max(bannedUntil, retryAt);
        else limited.set(endpoint, Math.max(limited.get(endpoint) ?? 0, retryAt));
      }
      // Release the response without copying an upstream error body into logs/UI.
      try { await response.body?.cancel(); } catch { /* The fixed HTTP diagnostic is sufficient. */ }
      throw new BinanceQuoteError(endpoint, 'http', { httpStatus: status, retryAt });
    }
    try { return await response.json() as unknown; }
    catch (error) {
      const kind = transportKind(error, signal);
      throw new BinanceQuoteError(endpoint, kind ?? 'invalid_json');
    }
  }
  return async (endpoint: Endpoint): Promise<unknown> => {
    if (!['exchangeInfo', 'premiumIndex', 'fundingInfo'].includes(endpoint)) throw Error('Unsupported public quote endpoint');
    try { return await attempt(endpoint); }
    catch (error) {
      const retryable = error instanceof BinanceQuoteError && (error.kind === 'network' || error.kind === 'timeout'
        || error.kind === 'http' && transientStatuses.has(error.httpStatus ?? 0));
      // Optional funding must not add a second timeout to otherwise valid prices.
      if (!retryable || endpoint === 'fundingInfo') throw error;
      await sleep(300);
      return attempt(endpoint);
    }
  };
}
