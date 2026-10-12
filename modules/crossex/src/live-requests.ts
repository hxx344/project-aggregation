export type PendingRequest = { version: 1; id: string; kind: 'confirm' | 'cancel'; orderId?: string };
type RequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function requestStorageKey(pathname: string) { return 'gate-crossex:pending:v1:' + pathname; }

export function readPendingRequest(storage: RequestStorage | null, key: string): PendingRequest | null {
  try {
    const raw = storage?.getItem(key); if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !validId(value.id) || !['confirm', 'cancel'].includes(String(value.kind))) return null;
    if (value.orderId !== undefined && (typeof value.orderId !== 'string' || !value.orderId || value.orderId.length > 256)) return null;
    return { version: 1, id: value.id, kind: value.kind as PendingRequest['kind'], ...(typeof value.orderId === 'string' ? { orderId: value.orderId } : {}) };
  } catch { return null; }
}

/** Store only operation identity, never credentials, account data or order inputs. */
export function writePendingRequest(storage: RequestStorage | null, key: string, value: PendingRequest | null): boolean {
  try {
    if (!storage) return false;
    if (value) storage.setItem(key, JSON.stringify({ version: 1, id: value.id, kind: value.kind, ...(value.orderId ? { orderId: value.orderId } : {}) }));
    else storage.removeItem(key);
    return true;
  } catch { return false; }
}

export async function readRequestStatus(pending: PendingRequest, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher('/api/live/requests/' + encodeURIComponent(pending.id), { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(record(data) && typeof data.error === 'string' ? data.error : '原请求状态查询未完成，请继续查询。');
  return data;
}

export function resolveRequestStatus(pending: PendingRequest, data: unknown): { resolved: boolean; notSubmitted: boolean; orderId?: string } {
  if (!record(data)) return { resolved: false, notSubmitted: false };
  if (data.requestStatus === 'not_submitted') return { resolved: true, notSubmitted: true };
  if (data.requestStatus !== 'submitted' || data.kind !== pending.kind || !record(data.result)) return { resolved: false, notSubmitted: false };
  const result = data.result;
  if (typeof result.requestId !== 'string' || result.requestId !== pending.id) return { resolved: false, notSubmitted: false };
  if (pending.kind === 'confirm') {
    const statuses = new Set(['NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'CANCELED', 'FAIL', 'REJECT', 'REJECTED', 'EXPIRED', 'UNSENT']);
    const known = ['completed', 'pending', 'partial', 'failed'].includes(String(result.state));
    const knownLegs = Array.isArray(result.legs) && result.legs.length > 0 && result.legs.every(leg => record(leg) && typeof leg.status === 'string' && statuses.has(leg.status.toUpperCase()));
    return { resolved: known && knownLegs, notSubmitted: false };
  }
  const order = record(result.order) ? result.order : null;
  const orderId = typeof order?.id === 'string' ? order.id : typeof result.orderId === 'string' ? result.orderId : undefined;
  const terminal = ['FILLED', 'CANCELLED', 'CANCELED', 'FAIL', 'REJECT', 'REJECTED', 'EXPIRED'];
  return { resolved: !!order && terminal.includes(String(order.status).toUpperCase()), notSubmitted: false, ...(orderId ? { orderId } : {}) };
}
