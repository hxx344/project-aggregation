const CODE = 'MARKET_DATA_STALE';

/** A fresh read refused because the stored dataset is stale; `reason` is the collector's recorded failure, if any. */
export function staleMarketError(reason, message = '后台行情采集失败或已过期。') {
  return Object.assign(new Error(message), { code: CODE, reason: typeof reason === 'string' && reason.trim() ? reason : null });
}

// Collector reasons are fixed application text (see market-collector.mjs); other exception text stays hidden.
export function staleMarketReason(error) {
  if (error?.code !== CODE || typeof error.reason !== 'string') return null;
  return error.reason.trim().replace(/[。；]+$/, '') || null;
}
