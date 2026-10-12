import { GOLD_OIL_EXCHANGES, GOLD_OIL_INSTRUMENTS, GOLD_OIL_SYMBOLS, goldOilLegValue, validateGoldOilIdentity, type GoldOilQuote, type GoldOilType, type GoldOilExchange, type GoldOilSource } from './gold-oil.ts';

export const HOUR = 3_600_000;
export type FundingEvent = { time: number; oil: number | null; cl?: number | null; xau: number | null };
export type GoldOilFundingHistory = { oilType: GoldOilType; source: GoldOilSource; fetchedAt: string; status: 'live' | 'snapshot'; coverageStart: number; coverageEnd: number; points: FundingEvent[] };
export function currentGoldOilFunding(quote: GoldOilQuote | null) {
  if (!quote?.funding) return null;
  const { xau, oil } = quote.funding;
  const hourlyRate = (xau.rate / xau.intervalHours - oil.rate / oil.intervalHours) / 2;
  return { hourlyRate, annualized: hourlyRate * 8760, cashPerHour: hourlyRate * 10_000 };
}

export function validateGoldOilFunding(input: unknown, expectedOil: GoldOilType = 'cl', expectedExchange: GoldOilExchange = 'binance'): GoldOilFundingHistory {
  const value = input as GoldOilFundingHistory;
  if (!value || !['live', 'snapshot'].includes(value.status) || !Number.isFinite(Date.parse(value.fetchedAt)) || !Number.isSafeInteger(value.coverageStart) || !Number.isSafeInteger(value.coverageEnd) || value.coverageStart <= 0 || value.coverageEnd <= value.coverageStart || value.coverageEnd > Date.parse(value.fetchedAt) + 1 || !Array.isArray(value.points) || value.points.length > 100_000) throw Error('Invalid gold/oil funding history');
  validateGoldOilIdentity(value, expectedOil, expectedExchange);
  let previous = 0;
  const points = value.points.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Invalid gold/oil funding event');
    const oil = goldOilLegValue(row, expectedOil) as number | null;
    if (!Number.isSafeInteger(row.time) || row.time <= previous || row.time < value.coverageStart || row.time >= value.coverageEnd || oil === null && row.xau === null) throw Error('Invalid gold/oil funding time');
    previous = row.time;
    for (const rate of [oil, row.xau]) if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1)) throw Error('Invalid settled funding rate');
    return { time: row.time, oil, ...(expectedOil === 'cl' ? { cl: oil } : {}), xau: row.xau };
  });
  return { oilType: expectedOil, source: GOLD_OIL_EXCHANGES[expectedExchange].name, fetchedAt: value.fetchedAt, status: value.status, coverageStart: value.coverageStart, coverageEnd: value.coverageEnd, points };
}

export function parseGoldOilFunding(oilInput: unknown, xauInput: unknown, start: number, end: number, now: number, previous: GoldOilFundingHistory | null = null, oilType: GoldOilType = 'cl') {
  if (previous) previous = validateGoldOilFunding(previous, oilType);
  const values = new Map<number, FundingEvent>((previous?.points ?? []).map(({ time, oil, xau }) => [time, { time, oil, xau }]));
  for (const [key, input, symbol] of [['oil', oilInput, GOLD_OIL_INSTRUMENTS[oilType].symbol], ['xau', xauInput, GOLD_OIL_SYMBOLS.xau]] as const) {
    if (!Array.isArray(input)) throw Error('Invalid Binance funding history');
    const seen = new Set<number>();
    for (const row of input) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Invalid Binance funding event');
      const time = row.fundingTime, rate = typeof row.fundingRate === 'string' && row.fundingRate.trim() ? Number(row.fundingRate) : row.fundingRate;
      if (row.symbol !== symbol || row.rateType !== undefined && row.rateType !== 'Regular' || !Number.isSafeInteger(time) || time < start || time >= end || seen.has(time) || typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1) throw Error('Invalid Binance funding event');
      seen.add(time);
      const event = values.get(time) ?? { time, oil: null, xau: null };
      event[key] = rate; values.set(time, event);
    }
  }
  return validateGoldOilFunding({ oilType, source: 'Binance', status: 'live', fetchedAt: new Date(now).toISOString(), coverageStart: Math.min(start, previous?.coverageStart ?? start), coverageEnd: end, points: [...values.values()].sort((a, b) => a.time - b.time) }, oilType);
}

/** Sum each leg's actual events, including settlements at different times or intervals. */
export function analyzeGoldOilFunding(history: GoldOilFundingHistory | null, start: number, end: number) {
  const covered = Boolean(history && start >= history.coverageStart && end <= history.coverageEnd && end > start);
  const events = history?.points.filter(row => row.time >= start && row.time < end) ?? [];
  const hasBoth = events.some(row => row.oil !== null) && events.some(row => row.xau !== null);
  const days = new Map<number, { time: number; short: number; oilCount: number; xauCount: number }>();
  for (const row of events) {
    const key = Math.floor(row.time / (24 * HOUR)) * 24 * HOUR;
    const day = days.get(key) ?? { time: row.time, short: 0, oilCount: 0, xauCount: 0 };
    // An absent leg has no returned event here; it is never presented as a zero fee.
    if (row.xau !== null) { day.short += row.xau / 2; day.xauCount++; }
    if (row.oil !== null) { day.short -= row.oil / 2; day.oilCount++; }
    day.time = row.time; days.set(key, day);
  }
  let sum = 0, previous = -Infinity;
  const points: { time: number; shortAnnualized: number | null; longAnnualized: number | null; shortRate: number | null; longRate: number | null }[] = [];
  for (const [dayStart, day] of days) {
    sum += day.short;
    if (dayStart - previous > 24 * HOUR && previous !== -Infinity) points.push({ time: previous + 24 * HOUR, shortAnnualized: null, longAnnualized: null, shortRate: null, longRate: null });
    previous = dayStart;
    const until = Math.min(end, dayStart + 24 * HOUR), elapsed = (until - start) / HOUR, dayHours = (until - Math.max(start, dayStart)) / HOUR;
    const annual = covered && hasBoth && elapsed > 0 ? sum / elapsed * 8760 : null, rate = covered && hasBoth && dayHours > 0 ? day.short / dayHours : null;
    points.push({ time: day.time, shortAnnualized: annual, longAnnualized: annual === null ? null : -annual, shortRate: rate, longRate: rate === null ? null : -rate });
  }
  const annualized = covered && hasBoth ? sum / ((end - start) / HOUR) * 8760 : null;
  const oilCount = events.filter(row => row.oil !== null).length;
  return { covered, points, events, shortCumulative: events.length ? sum : null, longCumulative: events.length ? -sum : null, shortAnnualized: annualized, longAnnualized: annualized === null ? null : -annualized, oilCount, ...(history?.oilType === 'cl' ? { clCount: oilCount } : {}), xauCount: events.filter(row => row.xau !== null).length };
}

/** Price candles can advance before the next funding poll. Analyze only the queried tail. */
export function analyzeAvailableGoldOilFunding(history: GoldOilFundingHistory | null, start: number, selectedEnd: number) {
  const end = Math.min(selectedEnd, history?.coverageEnd ?? selectedEnd);
  // Keep the selected start: a missing prefix must not silently become a shorter return period.
  const result = analyzeGoldOilFunding(history, start, end);
  return { ...result, start, end, selectedCovered: result.covered && end === selectedEnd };
}
