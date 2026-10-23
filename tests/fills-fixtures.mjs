export const STAMP = '2026-10-23T00:00:00.000Z';
export const NOW = Date.parse(STAMP);
export const LOOKBACK = new Date(NOW - 85 * 86400_000).toISOString();
export const fill = (overrides = {}) => ({ id: 'fill-1', symbol: 'CLUSDT', base: 'CL', time: STAMP, side: 'buy', positionSide: 'net',
  quantity: '1.000000000000000001', quantityUnit: 'CL', price: '71.123456789012345678', priceCurrency: 'USDT',
  fee: '-0.000000000000000001', feeCurrency: 'USDT', realizedPnl: null, positionBefore: '0', positionAfter: '1.000000000000000001', ...overrides });
export const payload = () => ({ schemaVersion: 1, generatedAt: STAMP, lookbackStart: LOOKBACK, exchanges: [
  { id: 'binance', name: 'Binance', accounts: [{ id: 'main', name: '主账户', configured: true, revision: 'a'.repeat(64), scopes: [
    { id: 'um', label: 'U 本位', status: 'live', refreshing: false, fetchedAt: STAMP, coverageStart: LOOKBACK, coverageEnd: STAMP, truncated: false, error: null, fills: [fill()] },
  ] }] },
] });
export const scope = data => data.exchanges[0].accounts[0].scopes[0];
export const response = () => ({ generatedAt: STAMP, sources: [
  { projectId: 'asset', name: 'Asset 账本', status: 'ready', checkedAt: STAMP, error: null, data: payload() },
] });
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
