import type { TradingExchange, TradingPair, TradingReadState, TradingState } from './trading-types';

export const DEFAULT_TRADING_PAIR: TradingPair = 'binance,bybit';
export function normalizeTradingPair(value: string | null | undefined): TradingPair {
  const exchanges = value?.split(',');
  if (!exchanges || exchanges.length !== 2 || new Set(exchanges).size !== 2) return DEFAULT_TRADING_PAIR;
  const pair = ['binance', 'bybit', 'okx'].filter(exchange => exchanges.includes(exchange)).join(',');
  return pair === 'binance,okx' || pair === 'bybit,okx' || pair === DEFAULT_TRADING_PAIR ? pair : DEFAULT_TRADING_PAIR;
}
export const pairExchanges = (pair: TradingPair) => pair.split(',') as [TradingExchange, TradingExchange];

export type TradingCacheEntry = { data: TradingState; receivedAt: number; requestId: number; failed: boolean };
type Request = { controller: AbortController; session: number; generation: number; id: number; kind: 'read' | 'mutation' | 'source'; pair: TradingPair };
const key = (days: 7 | 30, page: number, pair: TradingPair) => `${pair}:${days}:${page}`;
const MAX_PAGES = 12;

// The owner is one App login session. No account data or credentials enter browser storage.
export function createTradingCache() {
  const pages = new Map<string, TradingCacheEntry>();
  const requests = new Set<Request>();
  const listeners = new Set<() => void>();
  let session = 0, generation = 0, requestId = 0, version = 0;
  const latest = new Map<TradingPair, TradingCacheEntry>();
  let selection: { days: 7 | 30; page: number; pair: TradingPair } = { days: 7, page: 0, pair: DEFAULT_TRADING_PAIR };
  let latestAccounts: TradingState['accounts'] | undefined;
  let mutation: { request: Request; label: string } | null = null;
  const notify = () => { version++; listeners.forEach(listener => listener()); };
  const valid = (request: Request) => request.session === session && !request.controller.signal.aborted && (request.kind !== 'read' || request.generation === generation);
  const cancelReads = () => { for (const request of requests) if (request.kind === 'read') { request.controller.abort(); requests.delete(request); } };
  const invalidate = () => { generation++; cancelReads(); pages.clear(); latest.clear(); };
  const touch = (pageKey: string, entry: TradingCacheEntry) => { pages.delete(pageKey); pages.set(pageKey, entry); };
  const begin = (kind: Request['kind'], pair = DEFAULT_TRADING_PAIR): Request => {
    const request = { controller: new AbortController(), session, generation, id: ++requestId, kind, pair };
    requests.add(request); return request;
  };
  const accept = (request: Request, data: TradingState, replace = false) => {
    if (!valid(request)) return false;
    const responsePair = normalizeTradingPair(data.exchanges?.join(','));
    if (responsePair !== request.pair) return false;
    const previousAccounts = latestAccounts;
    // A delayed response from an older account revision cannot resurrect its positions.
    if (previousAccounts?.some(previous => data.accounts.some(account => account.exchange === previous.exchange && account.revision < previous.revision))) return false;
    const changed = previousAccounts?.some(previous => !data.accounts.some(account => account.exchange === previous.exchange && account.revision === previous.revision && account.connected === previous.connected));
    const pageKey = key(data.period.days, data.funding.pagination.page, responsePair);
    const previous = pages.get(pageKey);
    if (!replace && !changed && previous && request.id < previous.requestId) return false;
    if (replace || changed) invalidate();
    const entry = { data, receivedAt: performance.now(), requestId: request.id, failed: false };
    touch(pageKey, entry);
    // Keep both range landing pages; evict the least recently used other page.
    for (const candidate of pages.keys()) {
      if (pages.size <= MAX_PAGES) break;
      if (!candidate.endsWith(':7:0') && !candidate.endsWith(':30:0')) pages.delete(candidate);
    }
    latestAccounts = data.accounts;
    const latestEntry = latest.get(responsePair);
    if (!latestEntry || request.id >= latestEntry.requestId) latest.set(responsePair, entry);
    notify(); return true;
  };
  return {
    get(days: 7 | 30, page: number, pair = DEFAULT_TRADING_PAIR) {
      const pageKey = key(days, page, pair), entry = pages.get(pageKey);
      if (entry) touch(pageKey, entry);
      return entry ?? null;
    },
    latest: (pair = DEFAULT_TRADING_PAIR) => latest.get(pair) ?? null,
    selection: () => selection,
    select: (days: 7 | 30, page: number, pair = DEFAULT_TRADING_PAIR) => { selection = { days, page, pair }; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    busy: () => mutation?.label ?? null,
    valid,
    beginRead: (pair = DEFAULT_TRADING_PAIR) => begin('read', pair),
    beginSource: () => begin('source'),
    beginMutation(label: string, pair = DEFAULT_TRADING_PAIR) {
      if (mutation) return null;
      cancelReads(); mutation = { request: begin('mutation', pair), label }; notify(); return mutation.request;
    },
    accept,
    fail(request: Request, days: 7 | 30, page: number, pair = request.pair) {
      if (!valid(request)) return;
      const entry = pages.get(key(days, page, pair));
      if (entry) entry.failed = true;
      notify();
    },
    finish(request: Request) {
      requests.delete(request);
      if (mutation?.request === request) { mutation = null; notify(); }
    },
    clear() {
      session++; generation++;
      for (const request of requests) request.controller.abort();
      requests.clear(); pages.clear(); latest.clear(); latestAccounts = undefined; mutation = null; selection = { days: 7, page: 0, pair: DEFAULT_TRADING_PAIR }; notify();
    },
  };
}
export type TradingCache = ReturnType<typeof createTradingCache>;

export function tradingCacheNow(entry: TradingCacheEntry, now = performance.now()) {
  return Date.parse(entry.data.cache.servedAt) + Math.max(0, now - entry.receivedAt);
}

export function ageTradingData(entry: TradingCacheEntry, now: number, unavailable = false): TradingState {
  const age = (state: TradingReadState, fetchedAt: string | null, threshold: number): TradingReadState => state === 'live' && (unavailable || entry.failed || !fetchedAt || now - Date.parse(fetchedAt) > threshold) ? 'stale' : state;
  const data = entry.data;
  const accounts = data.accounts.map(account => {
    const fundingState = age(account.funding.state, account.funding.fetchedAt, 900_000);
    return { ...account,
      positions: { ...account.positions, state: age(account.positions.state, account.positions.fetchedAt, 75_000) },
      funding: { ...account.funding, state: fundingState, complete: account.funding.complete && fundingState === 'live' },
    };
  });
  const noReceipts = data.funding.pagination.total === 0;
  const selectedAccounts = accounts.filter(account => (data.exchanges ?? pairExchanges(DEFAULT_TRADING_PAIR)).includes(account.exchange));
  const legs = data.legs.map(leg => {
    const account = accounts.find(account => account.exchange === leg.exchange);
    const fundingComplete = leg.fundingComplete && !!account?.funding.complete;
    return { ...leg, state: age(leg.state, leg.fetchedAt, 75_000), fundingComplete,
      fundingNet: !fundingComplete && noReceipts ? null : leg.fundingNet };
  });
  const allFundingFresh = selectedAccounts.length === 2 && selectedAccounts.every(account => account.funding.state === 'live');
  const complete = data.funding.complete && selectedAccounts.length === 2 && selectedAccounts.every(account => account.funding.complete);
  const last = data.pnl?.latest;
  const expiredPnl = last && (unavailable || entry.failed || now - last.time > 75_000) && (last.unrealizedPnl !== null || last.totalPnl !== null);
  const gap = expiredPnl ? { time: Math.max(now, last.time + 1), unrealizedPnl: null, fundingPnl: null, totalPnl: null } : null;
  return {
    ...data, accounts, legs,
    structure: selectedAccounts.length !== 2 || selectedAccounts.some(account => account.positions.state !== 'live') || legs.some(leg => leg.state !== 'live')
      ? { state: 'unknown', message: '等待两所最新仓位，暂不判断四腿结构' } : data.structure,
    funding: { ...data.funding, complete,
      ...(!complete && noReceipts ? { income: null, expense: null, net: null } : {}),
      // A ledger page cannot tell us which day/leg has no receipts. Preserve known
      // amounts unless the total count proves that the entire range is empty.
      daily: data.funding.daily.map(day => ({ ...day, complete: day.complete && allFundingFresh,
        ...(!(day.complete && allFundingFresh) && noReceipts ? { income: null, expense: null, net: null } : {}),
      })),
    },
    pnl: gap ? { ...data.pnl, end: gap.time, points: [...data.pnl.points, gap], latest: gap, status: 'incomplete' } : data.pnl,
  };
}
