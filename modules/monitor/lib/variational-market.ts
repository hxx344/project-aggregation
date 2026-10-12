import { validateExchangeQuote, type ExchangeLeg, type ExchangeQuote } from './exchange-quotes.ts';
import { requestVariational } from './variational-api.ts';

type Symbol = 'BZ' | 'CL';
type JsonObject = Record<string, unknown>;
const YEAR_SECONDS = 365 * 24 * 3600;
const instrument = (symbol: Symbol) => ({ underlying: symbol, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' });
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Var 行情响应格式无效。');
  return value as JsonObject;
};
const numeric = (value: unknown): number => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) throw Error('Var 行情数值无效。');
  const result = Number(value);
  if (!Number.isFinite(result)) throw Error('Var 行情数值无效。');
  return result;
};
const stamp = (value: unknown): number => {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw Error('Var 行情时间无效。');
  return Date.parse(value);
};

/** The indicative response has a separate mark_price; bid/ask are never its substitute.
 * Protocol reused from variational-grid client.py / models.py, verified 2026-09-19.
 */
export function parseVariationalMark(input: unknown, symbol: Symbol, now = Date.now()) {
  const value = object(input), receivedInstrument = object(value.instrument), expected = instrument(symbol);
  if (Object.keys(receivedInstrument).length !== Object.keys(expected).length || Object.entries(expected).some(([key, item]) => receivedInstrument[key] !== item) || numeric(value.qty) !== 1) throw Error('Var 原油合约或报价数量不匹配。');
  const price = numeric(value.mark_price), bid = numeric(value.bid), ask = numeric(value.ask), sourceTime = stamp(value.timestamp);
  if (price <= 0 || bid <= 0 || ask < bid) throw Error('Var 标记价格或报价无效。');
  if (sourceTime < now - 30_000 || sourceTime > now + 2_000) throw Error('Var 标记行情已过期。');
  return { price, sourceTime };
}

/** Official frontend, observed 2026-10-09:
 * https://omni.variational.io/_app/immutable/chunks/2OPCX0k9.js registers /funding/v2.
 * https://omni.variational.io/_app/immutable/chunks/VdRjQSXS.js constructs
 * {underlying, instrument_type}, and defines year seconds as 365*24*3600.
 * https://omni.variational.io/_app/immutable/chunks/D0i0EUnE.js transforms
 * predicted_funding_rate * funding_interval_s / yearSeconds for period display.
 * The raw rate is annualized decimal, not a percentage or an actual past payment.
 */
export function parseVariationalFunding(input: unknown, now = Date.now()) {
  const value = object(input), annualRate = numeric(value.predicted_funding_rate), intervalSeconds = numeric(value.funding_interval_s), next = stamp(value.next_funding_time);
  if (!Number.isInteger(intervalSeconds / 3600) || intervalSeconds < 3600 || intervalSeconds > 86_400 || next <= now || next > now + intervalSeconds * 1000 + 60_000) throw Error('Var 资金费周期或下次结算时间无效。');
  const fundingRate = annualRate * intervalSeconds / YEAR_SECONDS;
  if (!Number.isFinite(fundingRate) || Math.abs(fundingRate) > 1) throw Error('Var 预测资金费率无效。');
  return { fundingRate, fundingIntervalHours: intervalSeconds / 3600, nextFundingAt: new Date(next).toISOString() };
}

const rejected = (error: unknown) => Boolean(error && typeof error === 'object' && 'rejected' in error && error.rejected === true);

export async function readVariationalPublicFunding({ fetcher = fetch, clock = Date.now }: { fetcher?: typeof fetch; clock?: () => number } = {}) {
  // These endpoints are public. Never attach a saved token to a funding request.
  const values = await Promise.all(['BZ', 'CL'].map(symbol => requestVariational(`/funding/v2?underlying=${symbol as Symbol}&instrument_type=perpetual_rwa_future`, null, { fetcher })));
  const now = clock();
  return { left: parseVariationalFunding(values[0], now), right: parseVariationalFunding(values[1], now), fetchedAt: new Date(now).toISOString() };
}

export function withVariationalFunding(quote: ExchangeQuote, funding: Awaited<ReturnType<typeof readVariationalPublicFunding>> | null, now = Date.now()): ExchangeQuote {
  const valid = funding && [funding.left, funding.right].every(leg => Date.parse(leg.nextFundingAt) > now);
  return validateExchangeQuote({ ...quote,
    left: { ...quote.left, ...(valid ? funding.left : { fundingRate: null, nextFundingAt: null }) },
    right: { ...quote.right, ...(valid ? funding.right : { fundingRate: null, nextFundingAt: null }) },
    fundingFetchedAt: valid ? funding.fetchedAt : null,
    fundingError: valid ? '' : funding ? 'Var 预测结算时间已到，等待下一轮公开资金费更新。' : 'Var 公开资金费暂不可用，后台将自动重试；无需更新 token。',
  }, 'variational', 'oil');
}

export async function readVariationalAuthenticatedMarks(token: string, { fetcher = fetch, clock = Date.now }: { fetcher?: typeof fetch; clock?: () => number } = {}): Promise<ExchangeQuote> {
  const results = await Promise.allSettled([
    requestVariational('/quotes/indicative', token, { fetcher, body: { instrument: instrument('BZ'), qty: '1' } }),
    requestVariational('/quotes/indicative', token, { fetcher, body: { instrument: instrument('CL'), qty: '1' } }),
  ]);
  if (results.some(result => result.status === 'rejected' && rejected(result.reason))) throw Object.assign(Error('Variational 未通过会话认证，请更新 token。'), { rejected: true });
  const [leftMark, rightMark] = results;
  if (leftMark.status !== 'fulfilled' || rightMark.status !== 'fulfilled') throw Error('Var 认证标记行情暂不可用。');
  const now = clock(), left = parseVariationalMark(leftMark.value, 'BZ', now), right = parseVariationalMark(rightMark.value, 'CL', now);
  if (Math.abs(left.sourceTime - right.sourceTime) > 15_000) throw Error('Var 原油双腿行情不同步。');
  const leg = (symbol: Symbol, price: number): ExchangeLeg => ({ symbol, price,
    // For this monitor's explicit current estimate, weight rates by current marks.
    // This is not a statement about the venue's actual payment valuation basis.
    fundingPrice: price, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null });
  return validateExchangeQuote({ exchange: 'variational', monitorId: 'oil', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'mark',
      fetchedAt: new Date(Math.min(left.sourceTime, right.sourceTime)).toISOString(), timestampBasis: 'source',
      fundingFetchedAt: null, status: 'live', left: leg('BZ', left.price), right: leg('CL', right.price), fundingError: '',
    }, 'variational', 'oil');
}
