import { fundingWindowTotal } from '../lib/perpetual-funding-history.ts';
import { canonicalScannerDataPair, scannerDataPairKey } from '../lib/perpetual-scanner-data.ts';

const HOURS = new Set([24, 72, 168, 720]);
const IDENTITY_FIELDS = ['exchange', 'symbol', 'base', 'rawBase', 'quoteCurrency', 'marketId', 'multiplier', 'contractSize', 'dex', 'contractUnit', 'collateralCurrency', 'settlementCurrency', 'counterCurrency', 'productType', 'contractKind', 'assetClass'];
const keyOf = market => `${market.exchange}:${market.symbol}`;
const invalid = () => Object.assign(Error('筛选数据请求必须包含至多 30 个有效的当前合约组合及有效窗口'), { status: 400 });

/** This endpoint reads and registers bounded batches in the existing durable
 * collectors. Complete validation precedes either collector's registration. */
export function createPerpetualScannerDataService({ getSnapshot, getMarket, marketMetrics, fundingHistory, clock = Date.now }) {
  return {
    read(input) {
      if (!input || !Array.isArray(input.pairs) || input.pairs.length > 30 || typeof input.metrics !== 'boolean'
        || !Array.isArray(input.historyHours) || input.historyHours.length > 4 || input.historyHours.some(hours => !HOURS.has(hours))) throw invalid();
      const now = clock(), quotes = new Map((getSnapshot()?.quotes ?? []).map(quote => [keyOf(quote), quote])), requested = new Map();
      for (const pair of input.pairs) {
        if (!pair || typeof pair.base !== 'string' || !pair.base || pair.base.length > 100
          || typeof pair.longKey !== 'string' || pair.longKey.length > 160 || typeof pair.shortKey !== 'string' || pair.shortKey.length > 160
          || (pair.identity !== undefined && (typeof pair.identity !== 'string' || pair.identity.length > 4096))) throw invalid();
        const long = quotes.get(pair.longKey), short = quotes.get(pair.shortKey);
        if (!long || !short || long.exchange === short.exchange || long.base !== pair.base || short.base !== pair.base || long.comparable === false || short.comparable === false) throw invalid();
        for (const quote of [long, short]) {
          const catalog = getMarket(quote.exchange, quote.symbol);
          if (!catalog || ['exchange', 'symbol', 'base', 'quoteCurrency'].some(field => catalog[field] !== quote[field])
            || IDENTITY_FIELDS.some(field => Object.hasOwn(quote, field) && Object.hasOwn(catalog, field) && quote[field] !== catalog[field])
            || catalog.comparable === false || (catalog.delistingAt && catalog.delistingAt <= now)) throw invalid();
        }
        const canonical = canonicalScannerDataPair(pair);
        requested.set(scannerDataPairKey(pair), canonical);
      }
      const pairs = [...requested.values()], historyHours = [...new Set(input.historyHours)];
      const metrics = input.metrics && pairs.length ? marketMetrics.read({ pairs }) : null;
      const funding = historyHours.length && pairs.length ? fundingHistory.read({ pairs }) : null;
      const history = Object.create(null);
      if (funding) for (const [key, pair] of requested) {
        const long = funding.legs[pair.longKey], short = funding.legs[pair.shortKey];
        history[key] = Object.fromEntries(historyHours.map(hours => {
          const total = fundingWindowTotal(long, short, hours, now);
          // A failed or full collector queue must not hold the browser batch
          // forever just because this window has not acquired coverage yet.
          const problem = [long, short].find(leg => leg?.error || leg?.status === 'error');
          return [hours, total.status === 'pending' && problem ? { ...total, status: 'error', reason: problem.error || '历史更新失败，稍后重试' } : total];
        }));
      }
      const storageError = [...new Set([metrics?.storageError, funding?.storageError].filter(Boolean))].join(' ');
      return { schemaVersion: 1, generatedAt: now, metrics: metrics?.legs ?? Object.create(null), history, ...(storageError ? { storageError } : {}) };
    },
  };
}
