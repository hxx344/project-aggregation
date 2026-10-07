import { createTradingExchangeClient, TradingExchangeError } from './trading-exchanges.mjs';
import { decimal, addDecimals, negateDecimal, compareDecimals } from './trading-decimal.mjs';

const EXCHANGES = ['binance', 'bybit'];
const SYMBOLS = ['CLUSDT', 'BZUSDT'];
const NAMES = { binance: 'Binance', bybit: 'Bybit' };
const DAY = 86_400_000;
const POSITION_INTERVAL = 30_000, FUNDING_INTERVAL = 300_000;
const POSITION_STALE = 75_000, FUNDING_STALE = 900_000;
const iso = time => new Date(time).toISOString();
const timeOf = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export class TradingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function emptySnapshot(exchange) {
  return { version: 1, exchange,
    positions: { rows: [], fetchedAt: null, lastAttemptAt: null, error: null },
    funding: { events: [], coverage: [], fetchedAt: null, lastAttemptAt: null, requestedEnd: null, error: null } };
}
function exchangeOf(exchange) {
  if (!EXCHANGES.includes(exchange)) throw new TradingError(404, '交易所不存在');
  return exchange;
}
function revisionOf(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TradingError(400, '连接版本无效，请刷新后重试');
  return value;
}
function credentialsOf(body) {
  const valid = value => typeof value === 'string' && value.length >= 8 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
  if (!valid(body.apiKey) || !valid(body.apiSecret)) throw new TradingError(400, '请填写有效的 HMAC API Key 和 API Secret');
  return { apiKey: body.apiKey, apiSecret: body.apiSecret };
}
function safeError(error) {
  if (error instanceof TradingExchangeError) return error.message.slice(0, 240);
  if (error?.name === 'TimeoutError') return '交易所读取超时，已保留上次数据';
  return '交易所读取失败，请稍后重试';
}
function mergeCoverage(intervals) {
  const result = [];
  for (const item of intervals.slice().sort((a, b) => a.start - b.start)) {
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.start >= item.end) throw new Error('Invalid coverage');
    const last = result.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ start: item.start, end: item.end });
  }
  return result;
}
function covered(intervals, start, end) {
  return intervals.some(item => item.start <= start && item.end >= end);
}
function fundingStart(snapshot, end) {
  let gap = end - 30 * DAY;
  for (const item of snapshot.coverage) {
    if (item.start > gap) break;
    if (item.end > gap) gap = item.end;
  }
  return Math.max(end - 30 * DAY, Math.min(gap, end - DAY));
}
function normalizePositions(result, exchange, now) {
  if (!result || !Array.isArray(result.positions) || result.positions.length > 4 || timeOf(result.fetchedAt) === null || timeOf(result.fetchedAt) > now + 60_000) throw new Error('Invalid positions');
  const ids = new Set();
  const rows = result.positions.map(item => {
    if (!item || item.exchange !== exchange || !SYMBOLS.includes(item.symbol) || !['long', 'short'].includes(item.side) || !['one-way', 'hedge'].includes(item.mode)) throw new Error('Invalid position identity');
    const id = `${exchange}:${item.symbol}:${item.mode}:${item.side}`;
    if (ids.has(id)) throw new Error('Duplicate position'); ids.add(id);
    const optional = (value, nonnegative = false) => value == null ? null : decimal(value, { nonnegative });
    return { id, exchange, symbol: item.symbol, side: item.side, mode: item.mode,
      quantity: decimal(item.quantity, { positive: true }), entryPrice: optional(item.entryPrice, true), markPrice: optional(item.markPrice, true),
      notional: optional(item.notional, true), unrealizedPnl: optional(item.unrealizedPnl), leverage: optional(item.leverage, true),
      liquidationPrice: optional(item.liquidationPrice, true), sourceUpdatedAt: timeOf(item.sourceUpdatedAt) === null ? null : iso(timeOf(item.sourceUpdatedAt)) };
  });
  for (const symbol of SYMBOLS) {
    const positions = rows.filter(row => row.symbol === symbol);
    if (positions.some(row => row.mode === 'one-way') && positions.length > 1) throw new Error('Conflicting position modes');
  }
  return { rows, fetchedAt: iso(timeOf(result.fetchedAt)) };
}
function normalizeReceipts(events, exchange, start = 0, end = Infinity) {
  if (!Array.isArray(events) || events.length > 12000) throw new Error('Invalid funding events');
  const result = new Map();
  for (const item of events) {
    const time = timeOf(item?.time);
    if (!item || item.exchange !== exchange || !SYMBOLS.includes(item.symbol) || item.currency !== 'USDT' || typeof item.id !== 'string' || !item.id || item.id.length > 250 || /[\u0000-\u001f]/.test(item.id) || time === null || time < start || time >= end) throw new Error('Invalid funding receipt');
    const row = { id: item.id, exchange, symbol: item.symbol, time: iso(time), amount: decimal(item.amount), currency: 'USDT' };
    const previous = result.get(row.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting funding receipt');
    result.set(row.id, row);
  }
  return [...result.values()].sort((a, b) => timeOf(a.time) - timeOf(b.time) || a.id.localeCompare(b.id));
}
function parseSnapshot(row) {
  const fallback = emptySnapshot(row.exchange);
  if (!row.snapshot) return fallback;
  try {
    const value = JSON.parse(row.snapshot);
    if (value.version !== 1 || value.exchange !== row.exchange) throw new Error('Invalid snapshot');
    const positions = value.positions.fetchedAt ? normalizePositions({ positions: value.positions.rows, fetchedAt: value.positions.fetchedAt }, row.exchange, Date.now()) : { rows: [], fetchedAt: null };
    const events = normalizeReceipts(value.funding.events, row.exchange), coverage = mergeCoverage(value.funding.coverage);
    const safeStamp = value => timeOf(value) === null ? null : iso(timeOf(value));
    // Persist only application-owned diagnostics. Arbitrary disk strings never become API error text.
    return { ...fallback, positions: { ...positions, lastAttemptAt: safeStamp(value.positions.lastAttemptAt), error: value.positions.error ? '上次仓位读取失败，请刷新重试' : null },
      funding: { events, coverage, fetchedAt: safeStamp(value.funding.fetchedAt), lastAttemptAt: safeStamp(value.funding.lastAttemptAt),
        requestedEnd: Number.isSafeInteger(value.funding.requestedEnd) ? value.funding.requestedEnd : null, error: value.funding.error ? '上次资金费读取未完成，请刷新重试' : null } };
  } catch {
    fallback.positions.error = fallback.funding.error = '本地交易缓存无效，请刷新重新读取';
    return fallback;
  }
}
function readState(connected, data, now, staleMs) {
  if (!connected) return 'unconfigured';
  if (!data.fetchedAt) return data.error ? 'error' : 'loading';
  return data.error || now - timeOf(data.fetchedAt) > staleMs ? 'stale' : 'live';
}
function sumOrUnknown(positions, field, signed = false) {
  if (positions.some(row => row[field] === null)) return null;
  return addDecimals(positions.map(row => signed && row.side === 'short' ? negateDecimal(row[field]) : row[field]));
}
function cashTotals(events, known) {
  if (!known && !events.length) return { income: null, expense: null, net: null };
  const income = addDecimals(events.filter(row => compareDecimals(row.amount, '0') > 0).map(row => row.amount));
  const expense = negateDecimal(addDecimals(events.filter(row => compareDecimals(row.amount, '0') < 0).map(row => row.amount)));
  return { income, expense, net: addDecimals(events.map(row => row.amount)) };
}
function structure(legs) {
  if (legs.some(leg => leg.state !== 'live')) return { state: 'unknown', message: '等待两所最新仓位，暂不判断四腿结构' };
  if (legs.some(leg => leg.positions.length > 1)) return { state: 'mixed', message: '存在同一合约多空并存，请分别核对仓位；资金费按合约汇总' };
  if (legs.some(leg => !leg.positions.length)) return { state: 'incomplete', message: '当前未持齐四腿，空仓合约仍保留历史资金费' };
  const opposed = SYMBOLS.every(symbol => { const pair = legs.filter(leg => leg.symbol === symbol); return pair[0].positions[0].side !== pair[1].positions[0].side; });
  return opposed ? { state: 'opposed', message: 'CL、BZ 的跨所方向均相反；数量与名义金额按各腿实际仓位展示' } : { state: 'same-direction', message: '存在同品种跨所同向仓位，请核对四腿结构' };
}

/** Account reads only. This service deliberately has no exchange mutation operation. */
export function createTrading({ db, encrypt, decrypt, clientFactory = createTradingExchangeClient, now = Date.now, intervalMs = 1000, taskTimeoutMs = 60000, validationTimeoutMs = 35000 } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS trading_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, verified_at TEXT, snapshot TEXT)');
  for (const exchange of EXCHANGES) db.prepare('INSERT OR IGNORE INTO trading_accounts(exchange) VALUES (?)').run(exchange);
  const rowFor = exchange => db.prepare('SELECT * FROM trading_accounts WHERE exchange=?').get(exchangeOf(exchange));
  const cache = new Map(EXCHANGES.map(exchange => [exchange, parseSnapshot(rowFor(exchange))]));
  const clients = new Map(EXCHANGES.map(exchange => [exchange, clientFactory(exchange)]));
  const jobs = new Map(), validations = new Map();
  let closed = false;
  let fundingBatchEnd = Math.max(0, ...EXCHANGES.map(exchange => cache.get(exchange).funding.requestedEnd || 0));
  function write(exchange, revision, change) {
    if (closed || rowFor(exchange).revision !== revision) return false;
    const next = change(cache.get(exchange));
    db.prepare('UPDATE trading_accounts SET snapshot=? WHERE exchange=? AND revision=?').run(JSON.stringify(next), exchange, revision);
    cache.set(exchange, next); return true;
  }
  async function deadline(controller, timeoutMs, work) {
    const timer = setTimeout(() => controller.abort(new DOMException('Read timed out', 'TimeoutError')), timeoutMs); timer.unref?.();
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(controller.signal.reason); if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true }); });
    try { return await Promise.race([cancelled, Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); })]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
  }
  function cancel(exchange) {
    for (const [key, job] of jobs) if (key.startsWith(`${exchange}:`)) { job.controller.abort(); jobs.delete(key); }
  }
  function privateCredentials(row) {
    const value = decrypt(row.credentials);
    if (!value || value.exchange !== row.exchange) throw new Error('Invalid credential identity');
    return credentialsOf(value);
  }
  function run(exchange, kind, { force = false, end = now() } = {}) {
    if (closed) return Promise.resolve();
    const row = rowFor(exchange), key = `${exchange}:${kind}`;
    if (!row.credentials) return Promise.resolve();
    if (jobs.has(key)) return jobs.get(key).promise;
    const previous = cache.get(exchange)[kind];
    const newFundingBatch = kind === 'funding' && (previous.requestedEnd || 0) < end;
    const cooldown = force || newFundingBatch ? 5000 : kind === 'positions' ? POSITION_INTERVAL : FUNDING_INTERVAL;
    if (previous.lastAttemptAt && now() - timeOf(previous.lastAttemptAt) < cooldown) return Promise.resolve();
    const controller = new AbortController();
    const start = kind === 'funding' ? fundingStart(previous, end) : null;
    write(exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], lastAttemptAt: iso(now()), ...(kind === 'funding' ? { requestedEnd: end } : {}) } }));
    const promise = (async () => {
      try {
        const credentials = privateCredentials(row);
        const result = await deadline(controller, taskTimeoutMs, signal => kind === 'positions' ? clients.get(exchange).positions(credentials, { signal }) : clients.get(exchange).funding(credentials, { start, end, signal }));
        if (controller.signal.aborted || closed || rowFor(exchange).revision !== row.revision) return;
        if (kind === 'positions') {
          const value = normalizePositions(result, exchange, now());
          write(exchange, row.revision, snapshot => ({ ...snapshot, positions: { ...snapshot.positions, ...value, error: null } }));
        } else {
          if (timeOf(result?.fetchedAt) === null || timeOf(result.fetchedAt) > now() + 60000 || typeof result.complete !== 'boolean' || !Array.isArray(result.coverage)) throw new Error('Invalid funding response');
          const added = normalizeReceipts(result.events, exchange, start, end);
          const incomingCoverage = mergeCoverage(result.coverage);
          if (incomingCoverage.some(item => item.start < start || item.end > end) || result.complete && !covered(incomingCoverage, start, end)) throw new Error('Invalid funding coverage');
          write(exchange, row.revision, snapshot => {
            const events = normalizeReceipts([...snapshot.funding.events, ...added], exchange).filter(item => timeOf(item.time) >= end - 31 * DAY);
            const coverage = mergeCoverage([...snapshot.funding.coverage, ...incomingCoverage]).filter(item => item.end > end - 31 * DAY).map(item => ({ start: Math.max(item.start, end - 31 * DAY), end: item.end }));
            return { ...snapshot, funding: { ...snapshot.funding, events, coverage, fetchedAt: result.fetchedAt,
              error: result.complete ? null : '资金费记录未取全，当前仅显示已获取记录，请刷新重试' } };
          });
        }
      } catch (error) {
        if (closed || rowFor(exchange).revision !== row.revision || controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
        write(exchange, row.revision, snapshot => ({ ...snapshot, [kind]: { ...snapshot[kind], error: safeError(error) } }));
      }
    })().finally(() => { if (jobs.get(key)?.promise === promise) jobs.delete(key); });
    jobs.set(key, { controller, promise }); return promise;
  }
  function refresh({ force = false } = {}) {
    const current = now();
    if (!fundingBatchEnd || current - fundingBatchEnd >= (force ? 5000 : FUNDING_INTERVAL)) fundingBatchEnd = current;
    return Promise.allSettled(EXCHANGES.flatMap(exchange => ['positions', 'funding'].map(kind => run(exchange, kind, { force, end: kind === 'funding' ? fundingBatchEnd : current }))));
  }
  function state(days = 7) {
    if (![7, 30].includes(days)) throw new TradingError(400, '资金费区间仅支持 7 天或 30 天');
    const current = now();
    const entries = EXCHANGES.map(exchange => ({ row: rowFor(exchange), snapshot: cache.get(exchange) }));
    const ends = entries.filter(({ row }) => row.credentials).map(({ snapshot }) => snapshot.funding.requestedEnd).filter(value => Number.isSafeInteger(value));
    const end = ends.length ? Math.max(...ends) : current, start = end - days * DAY;
    const accounts = entries.map(({ row, snapshot }) => {
      const connected = !!row.credentials;
      const fundingState = readState(connected, snapshot.funding, current, FUNDING_STALE);
      return { exchange: row.exchange, name: NAMES[row.exchange], connected, revision: row.revision, verifiedAt: row.verified_at,
        refreshing: [...jobs.keys()].some(key => key.startsWith(`${row.exchange}:`)),
        positions: { state: readState(connected, snapshot.positions, current, POSITION_STALE), fetchedAt: snapshot.positions.fetchedAt, error: snapshot.positions.error },
        funding: { state: fundingState, fetchedAt: snapshot.funding.fetchedAt, error: snapshot.funding.error,
          coverageStart: snapshot.funding.coverage.length ? iso(snapshot.funding.coverage[0].start) : null,
          coverageEnd: snapshot.funding.coverage.length ? iso(snapshot.funding.coverage.at(-1).end) : null,
          complete: fundingState === 'live' && covered(snapshot.funding.coverage, start, end) } };
    });
    const events = entries.filter(({ row }) => row.credentials).flatMap(({ snapshot }) => snapshot.funding.events).filter(item => timeOf(item.time) >= start && timeOf(item.time) < end).sort((a, b) => timeOf(b.time) - timeOf(a.time) || a.id.localeCompare(b.id));
    const complete = accounts.every(account => account.funding.complete);
    const totals = cashTotals(events, complete);
    const legs = EXCHANGES.flatMap(exchange => SYMBOLS.map(symbol => {
      const account = accounts.find(item => item.exchange === exchange), snapshot = cache.get(exchange);
      const positions = account.connected ? snapshot.positions.rows.filter(row => row.symbol === symbol) : [];
      const receipts = events.filter(item => item.exchange === exchange && item.symbol === symbol);
      const known = !!account.positions.fetchedAt;
      return { id: `${exchange}:${symbol}`, exchange, symbol, name: symbol === 'CLUSDT' ? 'CL · WTI' : 'BZ · 布伦特',
        state: account.positions.state, fetchedAt: account.positions.fetchedAt, positions,
        grossNotional: known ? sumOrUnknown(positions, 'notional') : null, netNotional: known ? sumOrUnknown(positions, 'notional', true) : null,
        unrealizedPnl: known ? sumOrUnknown(positions, 'unrealizedPnl') : null,
        fundingNet: cashTotals(receipts, account.funding.complete).net, fundingComplete: account.funding.complete };
    }));
    const daily = [];
    // The first and last Beijing dates may be partial calendar days; both are clipped to the displayed interval.
    for (let day = Math.floor((start + 8 * 3600000) / DAY) * DAY - 8 * 3600000; day < end; day += DAY) {
      const from = Math.max(day, start), to = Math.min(day + DAY, end);
      const dayComplete = entries.every(({ row, snapshot }) => !!row.credentials && readState(true, snapshot.funding, current, FUNDING_STALE) === 'live' && covered(snapshot.funding.coverage, from, to));
      const rows = events.filter(item => timeOf(item.time) >= from && timeOf(item.time) < to);
      daily.push({ date: iso(day + 8 * 3600000).slice(0, 10), ...cashTotals(rows, dayComplete), complete: dayComplete });
    }
    return { mode: 'read-only', strategy: { id: 'oil-four-leg', name: '原油四腿资金费套利' }, generatedAt: iso(current), period: { days, start: iso(start), end: iso(end) },
      accounts, legs, structure: structure(legs), funding: { complete, ...totals, currency: 'USDT', events, daily } };
  }
  async function connect(exchange, body, { credentialReader, beforeSave, signal: externalSignal, timeoutMs = validationTimeoutMs } = {}) {
    exchangeOf(exchange); const revision = revisionOf(body.revision);
    let credentials = credentialReader ? null : credentialsOf(body);
    if (closed) throw new TradingError(503, '交易模块正在关闭');
    if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，请刷新后重试');
    if (validations.has(exchange)) throw new TradingError(409, '此交易所正在验证连接，请稍候');
    const controller = new AbortController(); validations.set(exchange, controller);
    const abort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abort(); else externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await deadline(controller, timeoutMs, async signal => {
        if (credentialReader) credentials = credentialsOf(await credentialReader(signal));
        signal.throwIfAborted();
        return clients.get(exchange).verify(credentials, { signal });
      });
      controller.signal.throwIfAborted();
      if (closed) throw new TradingError(503, '交易模块正在关闭');
      if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，本次验证结果未保存');
      beforeSave?.();
      const positions = normalizePositions(result, exchange, now()), snapshot = emptySnapshot(exchange);
      snapshot.positions = { ...snapshot.positions, ...positions, lastAttemptAt: iso(now()) };
      const encrypted = encrypt({ exchange, ...credentials });
      db.prepare('UPDATE trading_accounts SET revision=revision+1,credentials=?,verified_at=?,snapshot=? WHERE exchange=? AND revision=?').run(encrypted, iso(now()), JSON.stringify(snapshot), exchange, revision);
      cancel(exchange); cache.set(exchange, snapshot);
      if (!fundingBatchEnd || now() - fundingBatchEnd >= FUNDING_INTERVAL) fundingBatchEnd = now();
      void run(exchange, 'funding', { end: fundingBatchEnd }).catch(() => {});
    } catch (error) {
      if (error instanceof TradingError) throw error;
      throw new TradingError(400, controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError' ? '连接验证已取消' : safeError(error));
    } finally { externalSignal?.removeEventListener('abort', abort); if (validations.get(exchange) === controller) validations.delete(exchange); }
  }
  function disconnect(exchange, revision) {
    exchangeOf(exchange); revisionOf(revision);
    if (rowFor(exchange).revision !== revision) throw new TradingError(409, '连接已被更新，请刷新后重试');
    db.prepare('UPDATE trading_accounts SET revision=revision+1,credentials=NULL,verified_at=NULL,snapshot=NULL WHERE exchange=? AND revision=?').run(exchange, revision);
    validations.get(exchange)?.abort(); cancel(exchange); cache.set(exchange, emptySnapshot(exchange));
  }
  const timer = intervalMs > 0 ? setInterval(() => { if (!closed) void refresh(); }, intervalMs) : null; timer?.unref();
  const first = intervalMs > 0 ? setTimeout(() => { if (!closed) void refresh(); }, 100) : null; first?.unref();
  return { state, refresh, connect, disconnect,
    async close() { closed = true; clearInterval(timer); clearTimeout(first); for (const controller of validations.values()) controller.abort(); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); jobs.clear(); validations.clear(); },
  };
}
