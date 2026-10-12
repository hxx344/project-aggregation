import { initialCrossExSettings, validateCrossExConfig } from './perpetual-crossex-store.mjs';
import { createSpotTransferReader, SPOT_TRANSFER_SOURCES, SPOT_TRANSFER_TTL_MS, TRANSFER_UNAVAILABLE, spotTransferEvidence } from './perpetual-spot-transfer.mjs';

/** Auxiliary polling never runs on the signal request path. Metadata is not restored as fresh after restart. */
export function createCrossExFilterService({ store, clock = Date.now, read = createSpotTransferReader({ clock }), intervalMs = 60_000 } = {}) {
  let state = store?.get() ?? initialCrossExSettings(), running = false, timer, task, controller, generation = 0, dataRevision = 0, storageError = '', queue = Promise.resolve();
  state.config = validateCrossExConfig(state.config);
  let blocked = new Set(state.config.blockedBases);
  let pairCache;
  const metadata = new Map();
  const enabled = () => state.config.requireSpotTransfer;
  const status = (exchange, now) => {
    const value = metadata.get(exchange);
    return TRANSFER_UNAVAILABLE[exchange] ? 'unsupported' : value?.error ? 'error' : !value ? 'pending' : !Number.isFinite(value.at) || value.at <= 0 || value.at > now || now - value.at >= SPOT_TRANSFER_TTL_MS ? 'stale' : 'live';
  };
  const version = now => JSON.stringify([state.revision, dataRevision, storageError, Object.keys(SPOT_TRANSFER_SOURCES).map(id => status(id, now))]);
  function spotTransferPairs(now) {
    if (!enabled() || storageError) return [];
    const key = version(now);
    if (pairCache?.key === key) return pairCache.pairs;
    const pairs = [], exchanges = Object.keys(SPOT_TRANSFER_SOURCES).sort();
    for (let i = 0; i < exchanges.length; i++) for (let j = i + 1; j < exchanges.length; j++) {
      const longExchange = exchanges[i], shortExchange = exchanges[j];
      if (status(longExchange, now) !== 'live' || status(shortExchange, now) !== 'live') continue;
      for (const base of metadata.get(longExchange).assets.keys()) {
        if (blocked.has(base)) continue;
        const evidence = spotTransferEvidence({ base, exchange: longExchange, multiplier: 1 }, { base, exchange: shortExchange, multiplier: 1 }, metadata, now);
        if (evidence) pairs.push({ base, exchanges: [longExchange, shortExchange], ...evidence });
      }
    }
    pairCache = { key, pairs };
    return pairs;
  }
  const view = () => {
    const now = clock();
    return { available: Boolean(store), generatedAt: now, revision: state.revision, metadataRevision: dataRevision, config: structuredClone(state.config), error: storageError,
    spotTransferPairs: structuredClone(spotTransferPairs(now)),
    refreshIntervalMs: intervalMs, staleAfterMs: SPOT_TRANSFER_TTL_MS,
    venues: ['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter'].map(exchange => {
      const value = metadata.get(exchange);
      return { exchange, state: status(exchange, now), checkedAt: value?.at ?? null, spotAssets: value?.assets ? [...value.assets.values()].filter(asset => asset.spotSymbols.length > 0).length : 0,
        error: TRANSFER_UNAVAILABLE[exchange] ?? value?.error ?? '', sources: SPOT_TRANSFER_SOURCES[exchange] ?? [] };
    }),
  }; };
  function refresh() {
    if (!running || !enabled() || task) return task ?? Promise.resolve();
    const current = generation;
    controller = new AbortController(); const signal = controller.signal;
    task = Promise.allSettled(Object.keys(SPOT_TRANSFER_SOURCES).map(async exchange => {
      try {
        const value = await read(exchange, signal);
        if (!Number.isFinite(value?.at) || value.at <= 0 || value.at > clock() || clock() - value.at >= SPOT_TRANSFER_TTL_MS || !(value.assets instanceof Map)) throw new Error('公开数据缺失或已经过期');
        if (running && enabled() && generation === current) { metadata.set(exchange, { ...value, error: '' }); dataRevision++; }
      } catch {
        if (running && enabled() && generation === current) { metadata.set(exchange, { ...metadata.get(exchange), error: '公开资料读取失败，暂不推送涉及此平台的机会' }); dataRevision++; }
      }
    })).finally(() => { task = null; controller = null; });
    return task;
  }
  function reschedule() {
    clearInterval(timer); generation++; controller?.abort(); metadata.clear(); dataRevision++;
    if (!running || !enabled()) return;
    // An aborted previous generation may still be settling; retry only when it finishes.
    if (task) void task.then(refresh); else void refresh();
    timer = setInterval(() => { void refresh(); }, intervalMs); timer.unref?.();
  }
  return {
    view, refresh,
    start() { if (running) return; running = true; reschedule(); },
    async stop() { running = false; generation++; clearInterval(timer); controller?.abort(); await task; await queue; },
    filter() {
      const now = clock(), required = enabled(), blockedSnapshot = blocked;
      return { enabled: required || blockedSnapshot.size > 0, requireSpotTransfer: required, blockedBases: [...blockedSnapshot], revision: state.revision,
        version: version(now),
        evaluate: (long, short, at) => blockedSnapshot.has(long.base) || blockedSnapshot.has(short.base) ? null : !required ? {} : storageError ? null : spotTransferEvidence(long, short, metadata, at),
      };
    },
    update(input) {
      const operation = queue.then(async () => {
        if (!store) throw new Error('当前服务无法保存 CrossEx 筛选设置');
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['revision', 'config'].includes(key)) || !Number.isSafeInteger(input.revision)) throw new Error('CrossEx 筛选请求无效');
        if (input.revision !== state.revision) throw Object.assign(new Error('设置已在其他页面更新，请重新读取后再保存'), { status: 409 });
        const config = validateCrossExConfig(input.config, state.config), next = { ...state, revision: state.revision + 1, config };
        try { await store.save(next); } catch { storageError = 'CrossEx 筛选保存失败，请检查数据目录'; throw new Error(storageError); }
        const changed = config.requireSpotTransfer !== enabled(); state = next; storageError = '';
        blocked = new Set(config.blockedBases);
        if (changed) reschedule();
        return view();
      });
      queue = operation.catch(() => {}); return operation;
    },
  };
}
