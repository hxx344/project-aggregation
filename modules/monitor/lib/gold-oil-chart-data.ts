import { GOLD_OIL_EXCHANGES, GOLD_OIL_INTERVAL_MS, goldOilAction, goldOilLegValue, goldOilRatio, validateGoldOilHistory, type GoldOilExchange, type GoldOilHistory, type GoldOilPoint, type GoldOilType } from './gold-oil.ts';
import { validateGoldOilFunding, type GoldOilFundingHistory } from './gold-oil-funding.ts';

export type GoldOilChartRange = '1d' | '7d' | '1m' | 'all';
export type GoldOilChartWindow = { start: number; end: number };
/** A selected window, including empty or wholly unpaired prices, is not a full history. */
export type GoldOilChartHistory = Pick<GoldOilHistory, 'points' | 'fetchedAt' | 'status' | 'interval' | 'currency' | 'priceBasis'> & { coverageStart: number };
export type GoldOilHistoryChange = { first: { time: number; ratio: number }; last: { time: number; ratio: number }; change: number; percentChange: number };
export type GoldOilChartData = {
  schemaVersion: 1; scope: 'gold-oil-chart'; oilType: GoldOilType; exchange: GoldOilExchange;
  source: typeof GOLD_OIL_EXCHANGES[GoldOilExchange]['name']; range: GoldOilChartRange;
  window: GoldOilChartWindow | null; history: GoldOilChartHistory | null; funding: GoldOilFundingHistory | null;
  fundingSourceCoverage: GoldOilChartWindow | null; fullHistory: GoldOilHistoryChange | null;
  historyError: string | null; fundingError: string | null; state: 'ready' | 'partial' | 'pending';
};

export function parseGoldOilChartRange(value: unknown = '7d'): GoldOilChartRange {
  if (value === null || value === undefined) return '7d';
  if (value === '1d' || value === '7d' || value === '1m' || value === 'all') return value;
  throw Object.assign(Error('无效的金油比图表时间范围'), { status: 400 });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid gold/oil chart data');
  return value as Record<string, unknown>;
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw Error('Invalid gold/oil chart time');
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= 0) throw Error('Invalid gold/oil chart timestamp');
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw Error('Invalid gold/oil chart price');
  return value;
}
function sourceError(value: unknown): string | null {
  const error = (value as { collection?: { error?: unknown } } | null)?.collection?.error;
  return typeof error === 'string' && error ? error.slice(0, 500) : null;
}
function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message ? value.message.slice(0, 500) : fallback;
}
function chartWindow(fetchedAt: string, coverageStart: number, range: GoldOilChartRange): GoldOilChartWindow {
  const end = Math.floor(Date.parse(fetchedAt) / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
  let cutoff = end;
  if (range === '1m') {
    const date = new Date(end), month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
    const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    month.setUTCDate(Math.min(date.getUTCDate(), lastDay)); month.setUTCHours(date.getUTCHours(), date.getUTCMinutes());
    cutoff = month.getTime();
  } else if (range !== 'all') cutoff = end - (range === '1d' ? 1 : 7) * 86_400_000;
  const first = Math.ceil(coverageStart / GOLD_OIL_INTERVAL_MS) * GOLD_OIL_INTERVAL_MS;
  return { start: Math.min(end, range === 'all' ? first : Math.max(first, cutoff)), end };
}
function historyChange(history: GoldOilHistory): GoldOilHistoryChange | null {
  let first: GoldOilHistoryChange['first'] | null = null, last: GoldOilHistoryChange['last'] | null = null;
  for (const point of history.points) if (point.ratio !== null) {
    const current = { time: point.time, ratio: point.ratio }; first ??= current; last = current;
  }
  return first && last ? { first, last, change: last.ratio - first.ratio, percentChange: (last.ratio / first.ratio - 1) * 100 } : null;
}
function stateOf(history: GoldOilChartHistory | null, funding: GoldOilFundingHistory | null, sourceCoverage: GoldOilChartWindow | null, historyError: string | null, fundingError: string | null): GoldOilChartData['state'] {
  return !history && !sourceCoverage ? 'pending' : history && funding && !historyError && !fundingError ? 'ready' : 'partial';
}

/** Project independent persisted sources without changing their source times or objects. */
export function projectGoldOilChartData(historyInput: unknown, fundingInput: unknown, range: GoldOilChartRange = '7d', oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance', errors: { historyError?: string | null; fundingError?: string | null } = {}): GoldOilChartData {
  range = parseGoldOilChartRange(range);
  if (!['cl', 'bz'].includes(oilType) || !Object.hasOwn(GOLD_OIL_EXCHANGES, exchange)) throw Error('Unexpected gold/oil chart variant');
  let full: GoldOilHistory | null = null, sourceFunding: GoldOilFundingHistory | null = null;
  let historyError = errors.historyError?.slice(0, 500) || sourceError(historyInput), fundingError = errors.fundingError?.slice(0, 500) || sourceError(fundingInput);
  if (historyInput != null) try { full = validateGoldOilHistory(historyInput, oilType, exchange); } catch (error) { historyError = errorMessage(error, '价格历史暂不可用'); }
  if (fundingInput != null) try { sourceFunding = validateGoldOilFunding(fundingInput, oilType, exchange); } catch (error) { fundingError = errorMessage(error, '资金费历史暂不可用'); }
  let history: GoldOilChartHistory | null = null;
  let window = full ? chartWindow(full.fetchedAt, full.coverageStart ?? full.points[0].time, range) : sourceFunding ? chartWindow(sourceFunding.fetchedAt, sourceFunding.coverageStart, range) : null;
  let fullHistory = full ? historyChange(full) : null;
  if (full && window) {
    if ((window.end - window.start) / GOLD_OIL_INTERVAL_MS > 100_000) {
      historyError = '价格历史时间跨度超出图表范围'; full = null; fullHistory = null;
      window = sourceFunding ? chartWindow(sourceFunding.fetchedAt, sourceFunding.coverageStart, range) : null;
    } else {
      const available = new Map(full.points.filter(point => point.time >= window!.start && point.time < window!.end).map(point => [point.time, point]));
      const points: GoldOilPoint[] = [];
      for (let at = window.start; at < window.end; at += GOLD_OIL_INTERVAL_MS) points.push(available.get(at) ?? { time: at, oil: null, ...(oilType === 'cl' ? { cl: null } : {}), xau: null, ratio: null });
      history = { points, fetchedAt: full.fetchedAt, status: full.status, interval: full.interval, currency: full.currency, priceBasis: full.priceBasis, coverageStart: full.coverageStart ?? full.points[0].time };
    }
  }
  const fundingSourceCoverage = sourceFunding ? { start: sourceFunding.coverageStart, end: sourceFunding.coverageEnd } : null;
  let funding: GoldOilFundingHistory | null = null;
  if (sourceFunding && window) {
    const coverageStart = Math.max(window.start, sourceFunding.coverageStart), coverageEnd = Math.min(window.end, sourceFunding.coverageEnd);
    if (coverageEnd > coverageStart) funding = { ...sourceFunding, coverageStart, coverageEnd, points: sourceFunding.points.filter(point => point.time >= coverageStart && point.time < coverageEnd) };
    else fundingError ||= '资金费查询尚未覆盖所选区间';
  }
  return { schemaVersion: 1, scope: 'gold-oil-chart', oilType, exchange, source: GOLD_OIL_EXCHANGES[exchange].name, range, window, history, funding, fundingSourceCoverage, fullHistory, historyError, fundingError, state: stateOf(history, funding, fundingSourceCoverage, historyError, fundingError) };
}

/** Readers are supplied by the runtime; this projection never calls an exchange or writes storage. */
export async function readGoldOilChartData(readAction: (action: string) => unknown | Promise<unknown>, range: GoldOilChartRange = '7d', oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance') {
  range = parseGoldOilChartRange(range);
  const [history, funding] = await Promise.allSettled(['history', 'funding'].map(action => Promise.resolve().then(() => readAction(goldOilAction(action, oilType, exchange)))));
  return projectGoldOilChartData(history.status === 'fulfilled' ? history.value : null, funding.status === 'fulfilled' ? funding.value : null, range, oilType, exchange, {
    historyError: history.status === 'rejected' ? errorMessage(history.reason, '价格历史暂不可用') : null,
    fundingError: funding.status === 'rejected' ? errorMessage(funding.reason, '资金费历史暂不可用') : null,
  });
}

/** Validate only this scoped response: empty/unpaired selected windows are legitimate. */
export function validateGoldOilChartData(input: unknown, expectedRange: GoldOilChartRange = '7d', oilType: GoldOilType = 'cl', exchange: GoldOilExchange = 'binance'): GoldOilChartData {
  const value = record(input), range = parseGoldOilChartRange(expectedRange);
  if (!Object.hasOwn(GOLD_OIL_EXCHANGES, exchange) || value.schemaVersion !== 1 || value.scope !== 'gold-oil-chart' || value.oilType !== oilType || value.exchange !== exchange || value.source !== GOLD_OIL_EXCHANGES[exchange].name || value.range !== range) throw Error('Unexpected gold/oil chart identity');
  const readWindow = (input: unknown, aligned = false) => {
    const row = record(input), start = time(row.start), end = time(row.end);
    if (start > end || aligned && (start % GOLD_OIL_INTERVAL_MS || end % GOLD_OIL_INTERVAL_MS)) throw Error('Invalid gold/oil chart window');
    return { start, end };
  };
  const window = value.window === null ? null : readWindow(value.window, true);
  if (window && (window.end - window.start) / GOLD_OIL_INTERVAL_MS > (range === '1d' ? 96 : range === '7d' ? 672 : range === '1m' ? 31 * 96 : 100_000)) throw Error('Gold/oil chart window is too large');
  const error = (input: unknown) => { if (input === null) return null; if (typeof input !== 'string' || !input || input.length > 500) throw Error('Invalid gold/oil chart error'); return input; };
  const historyError = error(value.historyError), fundingError = error(value.fundingError);
  let history: GoldOilChartHistory | null = null;
  if (value.history !== null) {
    const row = record(value.history), fetchedAt = timestamp(row.fetchedAt), coverageStart = time(row.coverageStart);
    if (!window || row.currency !== 'USDT' || row.priceBasis !== 'mark' || row.interval !== '15m' || !['live', 'snapshot'].includes(String(row.status)) || !Array.isArray(row.points) || row.points.length > 100_000) throw Error('Invalid gold/oil chart history');
    const expected = chartWindow(fetchedAt, coverageStart, range);
    if (expected.start !== window.start || expected.end !== window.end) throw Error('Unexpected gold/oil chart window');
    let previous = 0;
    const points = row.points.map(input => {
      const point = record(input), at = time(point.time), oilValue = goldOilLegValue(point, oilType), oil = oilValue === null ? null : positive(oilValue), xau = point.xau === null ? null : positive(point.xau);
      if (at <= previous || at < window.start || at >= window.end || at % GOLD_OIL_INTERVAL_MS) throw Error('Invalid gold/oil chart candle');
      previous = at;
      return { time: at, oil, ...(oilType === 'cl' ? { cl: oil } : {}), xau, ratio: goldOilRatio(oil, xau) };
    });
    history = { points, fetchedAt, status: row.status as 'live' | 'snapshot', currency: 'USDT', priceBasis: 'mark', interval: '15m', coverageStart };
  }
  const fundingSourceCoverage = value.fundingSourceCoverage === null ? null : readWindow(value.fundingSourceCoverage);
  if (fundingSourceCoverage && fundingSourceCoverage.end <= fundingSourceCoverage.start) throw Error('Invalid gold/oil funding source coverage');
  let funding: GoldOilFundingHistory | null = null;
  if (value.funding !== null) {
    funding = validateGoldOilFunding(value.funding, oilType, exchange);
    if (!window || !fundingSourceCoverage || funding.coverageStart !== Math.max(window.start, fundingSourceCoverage.start) || funding.coverageEnd !== Math.min(window.end, fundingSourceCoverage.end)) throw Error('Unexpected gold/oil funding coverage');
  }
  let fullHistory: GoldOilHistoryChange | null = null;
  if (value.fullHistory !== null) {
    if (!history) throw Error('Missing gold/oil chart history');
    const row = record(value.fullHistory), readPoint = (input: unknown) => { const point = record(input); return { time: time(point.time), ratio: positive(point.ratio) }; };
    const first = readPoint(row.first), last = readPoint(row.last), change = last.ratio - first.ratio, percentChange = (last.ratio / first.ratio - 1) * 100;
    if (first.time > last.time || first.time < history.coverageStart || first.time % GOLD_OIL_INTERVAL_MS || last.time % GOLD_OIL_INTERVAL_MS || last.time + GOLD_OIL_INTERVAL_MS > Date.parse(history.fetchedAt) || row.change !== change || row.percentChange !== percentChange) throw Error('Invalid gold/oil history change');
    fullHistory = { first, last, change, percentChange };
  }
  const state = stateOf(history, funding, fundingSourceCoverage, historyError, fundingError);
  if (value.state !== state || Boolean(window) !== Boolean(history || fundingSourceCoverage)) throw Error('Invalid gold/oil chart state');
  return { schemaVersion: 1, scope: 'gold-oil-chart', oilType, exchange, source: GOLD_OIL_EXCHANGES[exchange].name, range, window, history, funding, fundingSourceCoverage, fullHistory, historyError, fundingError, state };
}
