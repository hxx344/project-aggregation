export const fill = (overrides = {}) => ({
  key: 'asset|binance|account|um|1', sourceId: 'asset', source: '资产账本', exchangeId: 'binance', exchange: 'Binance',
  accountId: 'account', account: '主账户', scope: 'um', symbol: 'CLUSDT', base: 'CL',
  time: '2026-10-01T08:00:00.000Z', side: 'buy', positionSide: 'net',
  quantity: '2', quantityUnit: 'CL', price: '100', priceCurrency: 'USDT',
  fee: '-0.10', feeCurrency: 'USDT', realizedPnl: '0', positionBefore: '0', positionAfter: '2', stale: false,
  ...overrides,
});
export const fillsReply = (overrides = {}) => ({
  type: 'fills', requestId: 'req-1', market: 'oil', status: 'ok',
  generatedAt: '2026-10-01T08:01:00.000Z', lookbackStart: '2026-07-08T08:01:00.000Z',
  pending: false, incomplete: false, truncated: false,
  coverage: [{ sourceId: 'asset', source: '资产账本', exchangeId: 'binance', exchange: 'Binance', account: '主账户', scope: 'um',
    status: 'live', fetchedAt: '2026-10-01T08:00:30.000Z', coverageStart: '2026-07-08T08:01:00.000Z', coverageEnd: '2026-10-01T08:00:00.000Z', error: null }],
  items: [fill()], ...overrides,
});
