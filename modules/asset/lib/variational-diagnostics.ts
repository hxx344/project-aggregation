import { hasValidVariationalBalance, variationalRequestHeaders } from './variational.ts';
import type { VariationalCredential } from './variational.ts';
import type { VariationalDiagnosticReport, VariationalDiagnosticResult } from './variational-diagnostic-types.ts';

const TARGETS = [
  { endpoint: 'session', path: '/api/me' },
  { endpoint: 'portfolio', path: '/api/portfolio?compute_margin=true' },
] as const;
const MAX_BYTES = 2 * 1024 * 1024;

function contentKind(value: string | null): VariationalDiagnosticResult['contentType'] {
  const mime = value?.split(';', 1)[0].trim().toLowerCase();
  if (!mime) return 'missing';
  if (mime === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(mime)) return 'json';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  return 'other';
}

async function limitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES || !response.body) throw new SyntaxError('Invalid diagnostic response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new SyntaxError('Invalid diagnostic response'); }
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function probe(target: typeof TARGETS[number], headers: Record<string, string>, fetcher: typeof fetch, callerSignal?: AbortSignal): Promise<VariationalDiagnosticResult> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(12_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const result: VariationalDiagnosticResult = {
    ...target, status: null, contentType: null, challenge: false, elapsedMs: 0, structureOk: null, outcome: 'network_error',
  };
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    response = await fetcher('https://omni.variational.io' + target.path, {
      method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal,
    });
    signal.throwIfAborted();
    result.status = response.status >= 100 && response.status <= 599 ? response.status : null;
    result.contentType = contentKind(response.headers.get('content-type'));
    result.challenge = response.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge';
    if (result.challenge) result.outcome = 'challenge';
    else if (response.redirected || response.status >= 300 && response.status < 400) result.outcome = 'redirect';
    else if (response.status === 401) result.outcome = 'unauthorized';
    else if (response.status === 403) result.outcome = 'forbidden';
    else if (response.status === 429) result.outcome = 'rate_limited';
    else if (!response.ok) result.outcome = 'network_error';
    else if (result.contentType === 'html') result.outcome = 'html';
    else if (result.contentType !== 'json') result.outcome = 'invalid_data';
    else {
      const data = await limitedJson(response, signal);
      const object = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
      // Only attest to response structure. A token field does not prove session validity.
      result.structureOk = !!object && (target.endpoint === 'session'
        ? typeof object.token === 'string' && object.token.length > 0 && object.token.length <= 32768
        : hasValidVariationalBalance(object.balance));
      result.outcome = result.structureOk ? 'ok' : 'invalid_data';
    }
  } catch (error) {
    if (callerSignal?.aborted) result.outcome = 'cancelled';
    else if (timeout.aborted || error instanceof Error && error.name === 'TimeoutError') result.outcome = 'timeout';
    else if (error instanceof Error && error.name === 'AbortError') result.outcome = 'cancelled';
    else if (error instanceof SyntaxError) { result.structureOk = false; result.outcome = 'invalid_data'; }
    else result.outcome = 'network_error';
  } finally {
    // Do not inspect rejected bodies, arbitrary headers, Set-Cookie, or exception text.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    result.elapsedMs = Math.max(0, Math.round(performance.now() - started));
  }
  return result;
}

export async function diagnoseVariational(c: VariationalCredential, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<VariationalDiagnosticReport> {
  const headers = variationalRequestHeaders(c);
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(TARGETS.map(target => probe(target, headers, fetcher, signal)));
  return { checkedAt, client: 'asset-node', results };
}

// Prevent duplicate manual diagnostics in the single Node service; no credential is retained.
export function createVariationalDiagnosticGate(now: () => number = Date.now) {
  const entries = new Map<string, { active: boolean; nextAt: number }>();
  return {
    claim(owner: string): (() => void) | null {
      const time = now();
      for (const [key, item] of entries) if (!item.active && item.nextAt <= time) entries.delete(key);
      if (entries.has(owner) || entries.size >= 100) return null;
      const entry = { active: true, nextAt: time + 30_000 };
      entries.set(owner, entry);
      return () => { entry.active = false; };
    },
  };
}
