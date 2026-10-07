import { decimal } from './trading-decimal.mjs';

export const TRADING_VIEW_VERSION = 1;
const DAY = 86_400_000;
const EXCHANGES = ['binance', 'bybit'];
const LEG_IDS = EXCHANGES.flatMap(exchange => ['CLUSDT', 'BZUSDT'].map(symbol => `${exchange}:${symbol}`));
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('Invalid view integer');
  return value;
};
const money = value => value === null ? null : decimal(value);
const timestamp = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid view timestamp');
  return new Date(value).toISOString();
};
const optionalTime = value => value === null ? null : timestamp(value);
const boolean = value => { if (typeof value !== 'boolean') throw new Error('Invalid view boolean'); return value; };
const cash = value => ({ income: money(value.income), expense: money(value.expense), net: money(value.net) });

// Persist the expensive derived values only. Ledger rows already live in account
// snapshots; credentials, errors and arbitrary descriptive strings never belong here.
export function packTradingView(state) {
  return JSON.stringify({ generatedAt: state.generatedAt, period: state.period,
    accounts: state.accounts.map(account => ({ exchange: account.exchange, funding: {
      fetchedAt: account.funding.fetchedAt, coverageStart: account.funding.coverageStart, coverageEnd: account.funding.coverageEnd, complete: account.funding.complete,
    } })),
    legs: state.legs.map(leg => ({ id: leg.id, fundingNet: leg.fundingNet, fundingReceiptCount: leg.fundingReceiptCount })),
    funding: { complete: state.funding.complete, income: state.funding.income, expense: state.funding.expense, net: state.funding.net, daily: state.funding.daily }, pnl: state.pnl,
  });
}

export function unpackTradingView(serialized, days, current) {
  if (typeof serialized !== 'string' || serialized.length > 20_000_000) throw new Error('Invalid view size');
  const value = JSON.parse(serialized), generatedAt = timestamp(value.generatedAt);
  const start = timestamp(value.period.start), end = timestamp(value.period.end);
  if (value.period.days !== days || Date.parse(end) - Date.parse(start) !== days * DAY || Date.parse(generatedAt) > current + 60_000 || Date.parse(end) > current + 60_000) throw new Error('Invalid view period');
  const accounts = EXCHANGES.map(exchange => {
    const funding = value.accounts.find(account => account.exchange === exchange).funding;
    return { exchange, funding: { fetchedAt: optionalTime(funding.fetchedAt), coverageStart: optionalTime(funding.coverageStart), coverageEnd: optionalTime(funding.coverageEnd), complete: boolean(funding.complete) } };
  });
  const legs = LEG_IDS.map(id => {
    const leg = value.legs.find(leg => leg.id === id);
    return { id, fundingNet: money(leg.fundingNet), fundingReceiptCount: integer(leg.fundingReceiptCount, 100_000) };
  });
  if (!Array.isArray(value.funding.daily) || value.funding.daily.length > 31) throw new Error('Invalid view days');
  const daily = value.funding.daily.map(day => {
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw new Error('Invalid view date');
    return { date: day.date, ...cash(day), complete: boolean(day.complete), receiptCount: integer(day.receiptCount, 100_000) };
  });
  const source = value.pnl;
  if (source.currency !== 'USDT' || source.intervalMs !== 60000 || source.cumulativeStart !== Date.parse(start) || !Array.isArray(source.points) || source.points.length > 100_000 || !['ready', 'collecting', 'incomplete'].includes(source.status)) throw new Error('Invalid view PnL');
  const pnlEnd = integer(source.end);
  if (pnlEnd > current + 60000) throw new Error('Invalid PnL timestamp');
  const point = row => {
    const time = integer(row.time);
    if (time < Date.parse(start) || time > pnlEnd) throw new Error('Invalid PnL point');
    return { time, unrealizedPnl: money(row.unrealizedPnl), fundingPnl: money(row.fundingPnl), totalPnl: money(row.totalPnl) };
  };
  const points = source.points.map(point);
  if (points.some((row, index) => index > 0 && row.time <= points[index - 1].time)) throw new Error('Unordered PnL points');
  const pnl = { currency: 'USDT', intervalMs: 60000, cumulativeStart: Date.parse(start), end: pnlEnd,
    recordingStartedAt: source.recordingStartedAt === null ? null : integer(source.recordingStartedAt), pointCount: integer(source.pointCount, 100_000),
    points, latest: source.latest === null ? null : point(source.latest), status: source.status };
  return { generatedAt, period: { days, start, end }, accounts, legs, funding: { complete: boolean(value.funding.complete), ...cash(value.funding), currency: 'USDT', daily, events: [] }, pnl };
}
