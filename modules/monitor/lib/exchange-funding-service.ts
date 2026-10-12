import { exchangeDefinition, type Exchange } from './exchange-quotes.ts';
import { normalizeSettledFunding, validateExchangeFundingHistory, HISTORY_WINDOW_MS, type ExchangeFundingHistory, type FundingHistoryRange, type SettledFundingRecord } from './exchange-funding-history.ts';
import { createCexFundingHistoryReader } from './exchange-funding-cex.ts';
import { parseLighterOilMarkets } from './oil-dex.ts';

type JsonObject = Record<string, unknown>;
const object = (input: unknown): JsonObject => { if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid funding response'); return input as JsonObject; };
const list = (input: unknown): JsonObject[] => { if (!Array.isArray(input)) throw Error('Invalid funding history'); return input.map(object); };
const number = (input: unknown) => { if ((typeof input !== 'number' && typeof input !== 'string') || String(input).trim() === '' || !Number.isFinite(Number(input))) throw Error('Invalid funding number'); return Number(input); };

/** https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#retrieve-historical-funding-rates */
export function parseHyperliquidFundingHistory(input: unknown, symbol: string, now: number): SettledFundingRecord[] {
  if (!['xyz:BRENTOIL', 'xyz:CL'].includes(symbol)) throw Error('Unknown Hyperliquid oil contract');
  return normalizeSettledFunding(list(input).map(row => {
    if (row.coin !== symbol) throw Error('Funding contract mismatch');
    return { time: number(row.time), rate: number(row.fundingRate) };
  }), now);
}

/** REST rate is the magnitude in percentage points, with payer in direction.
 * Cross-checked against market_stats.funding_rate (last actual paid), never current_funding_rate.
 * https://apidocs.lighter.xyz/reference/fundings
 * https://apidocs.lighter.xyz/docs/websocket-reference#market-stats
 */
export function parseLighterFundingHistory(input: unknown, marketId: number, now: number): SettledFundingRecord[] {
  const value = object(input);
  if (value.code !== 200 || (value.market_id !== undefined && number(value.market_id) !== marketId)) throw Error('Lighter funding response failed');
  return normalizeSettledFunding(list(value.fundings).map(row => {
    const magnitude = number(row.rate), seconds = number(row.timestamp);
    if (magnitude < 0 || magnitude > 100 || !Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || seconds >= 100_000_000_000 || !['long', 'short'].includes(String(row.direction)) || (row.market_id !== undefined && number(row.market_id) !== marketId)) throw Error('Invalid Lighter funding settlement');
    return { time: seconds * 1000, rate: magnitude === 0 ? 0 : magnitude / 100 * (row.direction === 'short' ? -1 : 1) };
  }), now);
}

export function createExchangeFundingReader({ fetcher = fetch, clock = Date.now } = {}) {
  async function request(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetcher(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw Error(`Funding history HTTP ${response.status}`);
    return response.json();
  }
  const readCex = createCexFundingHistoryReader({ request, clock });
  let lighterMarkets: { value: ReturnType<typeof parseLighterOilMarkets>; until: number } | undefined;
  let lighterPending: Promise<ReturnType<typeof parseLighterOilMarkets>> | undefined;
  function discoverLighter() {
    if (lighterMarkets && clock() < lighterMarkets.until) return Promise.resolve(lighterMarkets.value);
    if (!lighterPending) lighterPending = request('https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails').then(input => {
      const value = parseLighterOilMarkets(input); lighterMarkets = { value, until: clock() + 60_000 }; return value;
    }).finally(() => { lighterPending = undefined; });
    return lighterPending;
  }
  async function readLeg(exchange: Exclude<Exchange, 'variational'>, symbol: string, range: FundingHistoryRange) {
    if (exchange === 'hyperliquid') {
      const records: SettledFundingRecord[] = [];
      let cursor = range.from;
      // Time-range info responses contain at most 500 records. Keep exact ms.
      // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#pagination
      for (let page = 0; page < 10; page++) {
        const input = await request('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin: symbol, startTime: cursor, endTime: range.to }) });
        const parsed = parseHyperliquidFundingHistory(input, symbol, range.to);
        if (!Array.isArray(input)) throw Error('Invalid Hyperliquid funding page');
        if (parsed.some(row => row.time < cursor)) throw Error('Hyperliquid funding pagination did not advance');
        records.push(...parsed);
        if (input.length < 500) return normalizeSettledFunding(records, range.to);
        if (!parsed.length) throw Error('Hyperliquid funding pagination did not advance');
        const next = Math.max(...parsed.map(row => row.time)) + 1;
        if (next <= cursor) throw Error('Hyperliquid funding pagination did not advance');
        if (next > range.to) return normalizeSettledFunding(records, range.to);
        cursor = next;
      }
      throw Error('Hyperliquid funding pagination limit exceeded');
    }
    if (exchange === 'lighter') {
      const market = (await discoverLighter()).find(item => item.symbol === symbol);
      if (!market) throw Error('Lighter oil contract unavailable');
      const records: SettledFundingRecord[] = [];
      // 25-day hourly windows stay below the documented 750-record response cap.
      for (let from = range.from; from <= range.to;) {
        const to = Math.min(range.to, from + 25 * 86_400_000);
        // fundings applies candle-style start boundaries: a fractional-hour start
        // skips the next settlement. Request from the preceding whole hour, then
        // filter exact bounds locally so neither the first row nor a seam is lost.
        const requestStart = Math.floor(from / 3_600_000) * 3600 - 3600;
        const query = new URLSearchParams({ market_id: String(market.marketId), resolution: '1h', start_timestamp: String(requestStart), end_timestamp: String(Math.floor(to / 1000)), count_back: '0' });
        const input = await request(`https://mainnet.zklighter.elliot.ai/api/v1/fundings?${query}`);
        const parsed = parseLighterFundingHistory(input, market.marketId, range.to);
        if (list(object(input).fundings).length >= 750 || parsed.some(row => row.time > to)) throw Error('Incomplete Lighter funding time window');
        records.push(...parsed.filter(row => row.time >= from && row.time <= to));
        from = to + 1;
      }
      return normalizeSettledFunding(records, range.to);
    }
    return readCex(exchange, symbol, range);
  }
  return async (exchange: Exchange, previous?: ExchangeFundingHistory | null): Promise<ExchangeFundingHistory> => {
    const definition = exchangeDefinition(exchange, 'oil');
    const startedAt = clock();
    if (exchange === 'variational') return validateExchangeFundingHistory({ exchange, monitorId: 'oil', currency: definition.currency, fetchedAt: new Date(startedAt).toISOString(), status: 'live', availability: 'unsupported', reason: 'Variational 公开接口尚未提供可核实的历史实际结算费率。', left: { symbol: definition.left, fetchedAt: null, error: '' }, right: { symbol: definition.right, fetchedAt: null, error: '' }, rows: [] }, exchange);
    const old = previous ? validateExchangeFundingHistory(previous, exchange) : null;
    const coverage = { from: startedAt - HISTORY_WINDOW_MS, to: startedAt };
    const ranges = (['left', 'right'] as const).map(side => {
      const previousCoverage = old?.[side].coverage;
      // New/legacy snapshots backfill the whole window; later updates overlap a day.
      const from = previousCoverage && previousCoverage.from <= coverage.from && previousCoverage.to >= coverage.from ? Math.max(coverage.from, previousCoverage.to - 86_400_000) : coverage.from;
      return { from, to: coverage.to };
    });
    const results = await Promise.allSettled([readLeg(exchange, definition.left, ranges[0]), readLeg(exchange, definition.right, ranges[1])]);
    if (results.every(result => result.status === 'rejected')) throw Error('Actual funding history unavailable');
    // The snapshot is anchored to the requested end, excluding settlements that
    // happened during pagination and keeping a stable 60-day window for all pages.
    const fetchedAt = new Date(startedAt).toISOString(), rows = new Map<number, ExchangeFundingHistory['rows'][number]>();
    const legs = (['left', 'right'] as const).map((side, index) => {
      const result = results[index], symbol = definition[side];
      const previousRecords = (old?.rows ?? []).filter(row => row[`${side}Rate`] !== null).map(row => ({ time: row.time, rate: row[`${side}Rate`]! }));
      const merged = new Map(previousRecords.map(row => [row.time, row]));
      if (result.status === 'fulfilled') for (const row of result.value) merged.set(row.time, row);
      const records = normalizeSettledFunding([...merged.values()], startedAt);
      for (const record of records) {
        const row = rows.get(record.time) ?? { time: record.time, leftRate: null, rightRate: null };
        row[`${side}Rate`] = record.rate; rows.set(record.time, row);
      }
      const previousCoverage = old?.[side].coverage;
      // Expired rows were pruned above, so their former coverage cannot be claimed.
      const retainedCoverage = previousCoverage && previousCoverage.to >= coverage.from ? { from: Math.max(previousCoverage.from, coverage.from), to: previousCoverage.to } : null;
      return { symbol, fetchedAt: result.status === 'fulfilled' ? fetchedAt : old?.[side].fetchedAt ?? null, error: result.status === 'fulfilled' ? '' : '本合约历史结算费率暂时读取失败，保留上次成功记录。', coverage: result.status === 'fulfilled' ? coverage : retainedCoverage };
    });
    return validateExchangeFundingHistory({ exchange, monitorId: 'oil', currency: definition.currency, fetchedAt, status: 'live', availability: 'supported', reason: legs.some(leg => leg.error) ? '部分合约更新失败，请查看各合约采集时间。' : '', left: legs[0], right: legs[1], rows: [...rows.values()] }, exchange);
  };
}

export const readExchangeFundingHistory = createExchangeFundingReader();
