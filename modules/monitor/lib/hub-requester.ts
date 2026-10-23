export const HUB_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
export type RequestTimers = {
  timeoutMs?: number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (timer: never) => void;
  createId?: () => string;
};
/** Latest request wins; only unanswered requests can be repeated after a handshake. */
export function createHubRequester<Q, R extends { requestId: string; market: string }>({
  send, onReply, parse, market, timeout, timeoutMs = 20_000, schedule = setTimeout, cancel = clearTimeout,
  createId = () => `monitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
}: RequestTimers & {
  send: (query: Q, requestId: string) => void; onReply: (reply: R) => void;
  parse: (value: unknown) => R | null; market: (query: Q) => string;
  timeout: (query: Q, requestId: string) => R;
}) {
  let latest: string | null = null, timer: unknown = null, asked: Q | null = null;
  const clear = () => { if (timer !== null) cancel(timer as never); timer = null; };
  const request = (query: Q | null) => {
    const requestId = createId();
    if (!query || !HUB_REQUEST_ID.test(requestId)) return null;
    clear(); latest = requestId; asked = query;
    timer = schedule(() => {
      if (latest !== requestId) return;
      latest = null; timer = null; onReply(timeout(query, requestId));
    }, timeoutMs);
    send(query, requestId);
    return requestId;
  };
  return {
    request,
    receive(value: unknown) {
      const reply = parse(value);
      if (!reply || latest === null || reply.requestId !== latest || !asked || reply.market !== market(asked)) return false;
      latest = null; clear(); onReply(reply); return true;
    },
    retry: () => latest !== null && asked ? request(asked) : null,
    dispose() { latest = null; asked = null; clear(); },
  };
}
