import { createHash } from 'node:crypto';

const LOOKBACK_MS = 85 * 86_400_000;
const CACHE_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const VENUES = { hyperliquid: 'Hyperliquid', 'rh-lighter': 'Lighter RH' };
const iso = value => new Date(value).toISOString();
const same = (a, b) => a && b && a.exchange === b.exchange && a.connected === b.connected && a.revision === b.revision && a.identity === b.identity;

// Native fills complement the Asset CEX source. state() returns immediately;
// subsequent 5-second UI follow-ups observe the same pending read. Successful
// reads expire after 5 minutes, failures retry after 60 seconds (or the venue's
// later retryAt). A revision, identity or disconnect invalidates all old rows.
export function createAnthropicHistory({ execution, now = Date.now } = {}) {
  const entries = new Map();
  const tasks = new Set();
  let closed = false;
  const connections = () => execution.historyConnections();
  const present = binding => !closed && connections().some(current => same(current, binding));
  function invalidate(exchange) {
    entries.get(exchange)?.controller?.abort();
    entries.delete(exchange);
  }
  function read(binding) {
    if (closed || !binding.connected || !binding.identity) return;
    let entry = entries.get(binding.exchange);
    if (!entry) { entry = { binding, data: null, error: null, unsupported: false, fetchedAt: null, checkedAt: null, retryAt: 0, pending: null, controller: null }; entries.set(binding.exchange, entry); }
    if (entry.pending || now() < entry.retryAt) return;
    const controller = new AbortController(), end = now(), start = end - LOOKBACK_MS;
    entry.controller = controller;
    entry.pending = Promise.resolve().then(() => execution.readAnthropicHistory(binding.exchange, { revision: binding.revision, identity: binding.identity, start, end, signal: controller.signal })).then(data => {
      if (!present(binding) || entries.get(binding.exchange) !== entry || controller.signal.aborted) return;
      entry.data = data; entry.fetchedAt = iso(now()); entry.error = null; entry.unsupported = false; entry.retryAt = now() + CACHE_MS;
    }, error => {
      if (!present(binding) || entries.get(binding.exchange) !== entry || controller.signal.aborted) return;
      entry.unsupported = error?.status === 501;
      entry.error = entry.unsupported ? '当前连接尚不支持原生成交读取' : error?.rateLimited ? '交易所成交读取限流，稍后重试'
        : error?.code === 'timeout' ? '交易所成交读取超时，稍后重试' : '交易所成交读取失败，稍后重试';
      entry.retryAt = Math.max(now() + RETRY_MS, Number.isFinite(error?.retryAt) ? error.retryAt : 0);
    }).finally(() => {
      tasks.delete(entry.pending); entry.checkedAt = iso(now()); entry.pending = null; entry.controller = null;
    });
    tasks.add(entry.pending);
  }
  function state() {
    const bindings = connections().filter(binding => Object.hasOwn(VENUES, binding.exchange));
    for (const [exchange, entry] of entries) if (!bindings.some(binding => same(binding, entry.binding))) invalidate(exchange);
    if (!closed) for (const binding of bindings) read(binding);
    const exchanges = Object.entries(VENUES).map(([exchange, name]) => {
      const binding = bindings.find(row => row.exchange === exchange), entry = entries.get(exchange);
      const configured = !!binding?.connected && !!binding.identity && !closed, data = configured ? entry?.data : null;
      const refreshing = configured && !!entry?.pending;
      const stale = !!data && (!!entry?.error || now() - Date.parse(entry.fetchedAt) >= CACHE_MS);
      const status = !configured ? 'unconfigured' : data ? stale ? 'stale' : 'live' : entry?.unsupported ? 'unsupported' : entry?.error ? 'error' : 'loading';
      const revision = configured ? createHash('sha256').update(`${exchange}:${binding.revision}:${binding.identity}`).digest('hex') : null;
      return { id: exchange, name, accounts: [{ id: data?.accountId ?? 'current', name: exchange === 'rh-lighter' ? '当前实盘连接账户' : '当前实盘连接主账户', configured, revision,
        scopes: [{ id: 'perpetual', label: 'ANT 永续成交', status, refreshing, fetchedAt: data ? entry.fetchedAt : null,
          coverageStart: data?.coverageStart ?? null, coverageEnd: data?.coverageEnd ?? null, truncated: data?.truncated ?? false,
          error: !configured ? '请先连接该交易所实盘账户' : entry?.error ?? (stale ? '成交数据已过期，正在更新' : null), fills: data?.fills ?? [] }] }] };
    });
    const checkedAt = [...entries.values()].map(entry => entry.checkedAt).filter(Boolean).sort().at(-1) ?? null;
    return { source: { projectId: 'anthropic-history', name: 'ANT原生成交', status: 'ready', error: null, checkedAt,
      data: { schemaVersion: 1, generatedAt: iso(now()), lookbackStart: iso(now() - LOOKBACK_MS), exchanges } },
    pending: exchanges.some(exchange => exchange.accounts.some(account => account.scopes.some(scope => scope.refreshing))) };
  }
  function stop() { closed = true; for (const exchange of entries.keys()) invalidate(exchange); }
  return { state, stop, close: async () => { stop(); await Promise.allSettled([...tasks]); } };
}
