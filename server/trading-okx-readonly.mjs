import {
  OKX_SYMBOLS, OkxProtocolError, createOkxProtocol, fail, requireObject, list, one, amount, optionalAmount,
  optionalPrice, id, milliseconds, iso, instrumentId, validateConfig, positionSize, multiply, checkAbort,
} from './trading-okx-common.mjs';
import { compareDecimals } from './trading-decimal.mjs';

// Account cash flows come exclusively from authenticated bills, never from
// public funding-rate history or the current position's cumulative fundingFee.
// https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-bills-details-last-3-months
const DAY = 86_400_000;
const MAX_REQUESTS = 240;
const MAX_EVENTS = 50_000;

export function createOkxTradingClient({ ErrorClass, ...options } = {}) {
  if (typeof ErrorClass !== 'function') throw new TypeError('TradingExchangeError is required');
  let protocol;
  function diagnostic(error, operation) {
    const code = error instanceof OkxProtocolError ? error.code : 'upstream';
    return { version: 1, exchange: 'okx', operation, accountMode: 'unified',
      code: ['rejected', 'timestamp'].includes(code) ? 'api' : code,
      ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
      ...(Number.isSafeInteger(error?.providerCode) ? { providerCode: error.providerCode } : {}),
    };
  }
  function convert(error, operation) {
    if (error?.code === 'aborted' || error?.name === 'AbortError') return new DOMException('读取已取消', 'AbortError');
    const detail = diagnostic(error, operation);
    const message = error instanceof OkxProtocolError ? error.message : 'OKX 读取失败';
    return new ErrorClass(message, detail.code, detail);
  }
  try { protocol = createOkxProtocol(options); } catch (error) { throw convert(error, 'account'); }
  const fetchedAt = () => iso(protocol.clock());
  function modeOf(value) { if (value !== undefined && value !== 'unified') fail('account_mode'); }
  async function permissions(credentials, signal, budget) {
    if (budget && ++budget.requests > MAX_REQUESTS) fail('page_limit');
    return validateConfig(one(await protocol.request('config', credentials, {}, { signal })));
  }
  async function readPositions(credentials, snapshot, signal) {
    const positions = [], seen = new Set();
    for (const symbol of OKX_SYMBOLS) {
      const [rows, rule] = await Promise.all([
        protocol.request('positions', credentials, { instType: 'SWAP', instId: instrumentId(symbol) }, { signal }),
        protocol.rule(symbol, signal),
      ]);
      for (const row of list(rows, 20)) {
        const size = positionSize(row, symbol, snapshot.positionMode);
        if (!size) continue;
        const identity = `okx:${symbol}:${row.mgnMode}:${row.posSide}`;
        if (seen.has(identity)) fail('duplicate');
        seen.add(identity);
        const markPrice = optionalPrice(row.markPx);
        positions.push({ id: identity, exchange: 'okx', symbol, side: size.side, mode: snapshot.positionMode,
          marginMode: row.mgnMode, quantity: size.quantity, instrumentId: rule.instrumentId, quantityUnit: rule.quantityUnit,
          contractSize: rule.contractSize, entryPrice: optionalPrice(row.avgPx), markPrice,
          notional: markPrice === null ? null : multiply(size.quantity, rule.contractSize, markPrice),
          unrealizedPnl: optionalAmount(row.upl), leverage: optionalAmount(row.lever, { positive: true }),
          liquidationPrice: optionalPrice(row.liqPx), sourceUpdatedAt: iso(row.uTime, true),
        });
      }
    }
    checkAbort(signal);
    return { fetchedAt: fetchedAt(), positions };
  }
  function receipt(row, { symbol, subType, start, end }) {
    requireObject(row);
    if (row.instId !== instrumentId(symbol) || row.instType !== 'SWAP' || row.subType !== subType) fail();
    if (row.ccy !== 'USDT') fail('currency');
    const time = milliseconds(row.ts);
    if (time < start || time >= end) fail('window_range');
    // pnl is the documented funding-payment field. Isolated funding may change
    // posBalChg instead of balChg; neither account balance delta nor fee replaces
    // this signed cash flow. A receipt's side never comes from today's position.
    const value = amount(row.pnl);
    if (subType === '173' && compareDecimals(value, '0') > 0 || subType === '174' && compareDecimals(value, '0') < 0) fail();
    return { id: `okx:${symbol}:FUNDING_FEE:${id(row.billId)}`, exchange: 'okx', symbol, time: iso(time), amount: value, currency: 'USDT' };
  }
  async function fundingPage(credentials, { symbol, subType, start, end, after, limit = 100, signal, budget }) {
    if (budget && ++budget.requests > MAX_REQUESTS) fail('page_limit');
    return list(await protocol.request('bills', credentials, {
      instType: 'SWAP', instId: instrumentId(symbol), ccy: 'USDT', ctType: 'linear', subType,
      begin: String(start), end: String(end - 1), limit: String(limit), ...(after ? { after } : {}),
    }, { signal }), limit);
  }
  async function verify(credentials, { signal, accountMode } = {}) {
    try { modeOf(accountMode); } catch (error) { throw convert(error, 'account'); }
    let snapshot;
    try { snapshot = await permissions(credentials, signal); } catch (error) { throw convert(error, 'permissions'); }
    let result;
    try { result = await readPositions(credentials, snapshot, signal); } catch (error) { throw convert(error, 'positions'); }
    const end = protocol.clock(), start = end - DAY;
    try {
      for (const symbol of OKX_SYMBOLS) for (const subType of ['173', '174']) {
        const rows = await fundingPage(credentials, { symbol, subType, start, end, limit: 1, signal });
        for (const row of rows) receipt(row, { symbol, subType, start, end });
      }
      checkAbort(signal);
    } catch (error) { throw convert(error, 'funding'); }
    return result;
  }
  async function positions(credentials, { signal, accountMode } = {}) {
    try { modeOf(accountMode); } catch (error) { throw convert(error, 'account'); }
    let snapshot;
    try { snapshot = await permissions(credentials, signal); } catch (error) { throw convert(error, 'permissions'); }
    try { return await readPositions(credentials, snapshot, signal); } catch (error) { throw convert(error, 'positions'); }
  }
  async function funding(credentials, { start, end, signal, accountMode, onProgress } = {}) {
    try {
      modeOf(accountMode); checkAbort(signal);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
        || end - start > 30 * DAY || end > protocol.clock() + 1000 || start < protocol.clock() - 31 * DAY) fail('range');
    } catch (error) { throw convert(error, 'funding'); }
    const receipts = new Map(), coverage = [], budget = { requests: 0 };
    let failure = null;
    function snapshot(complete) {
      return { fetchedAt: fetchedAt(), events: [...receipts.values()].map(row => ({ ...row })).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)),
        coverage: coverage.map(window => ({ ...window })), complete, error: failure?.message ?? null, diagnostic: failure?.diagnostic ?? null };
    }
    try {
      await permissions(credentials, signal, budget);
      for (let startWindow = start; startWindow < end; startWindow += 7 * DAY) {
        const endWindow = Math.min(startWindow + 7 * DAY, end);
        for (const symbol of OKX_SYMBOLS) for (const subType of ['173', '174']) {
          let after = null;
          const cursors = new Set();
          while (true) {
            const rows = await fundingPage(credentials, { symbol, subType, start: startWindow, end: endWindow, after, signal, budget });
            let previous = after;
            for (const row of rows) {
              const value = receipt(row, { symbol, subType, start: startWindow, end: endWindow });
              const billId = id(row.billId);
              if (previous !== null && BigInt(billId) >= BigInt(previous)) fail('pagination');
              previous = billId;
              const found = receipts.get(value.id);
              if (found && JSON.stringify(found) !== JSON.stringify(value)) fail('duplicate_conflict');
              if (!found && receipts.size >= MAX_EVENTS) fail('record_limit');
              receipts.set(value.id, value);
            }
            if (rows.length < 100) break;
            after = id(rows.at(-1).billId);
            if (cursors.has(after)) fail('pagination');
            cursors.add(after);
          }
        }
        coverage.push({ start: startWindow, end: endWindow });
        checkAbort(signal);
        if (onProgress) { await onProgress(snapshot(false)); checkAbort(signal); }
      }
    } catch (error) {
      if (signal?.aborted || error?.code === 'aborted' || error?.name === 'AbortError') throw new DOMException('读取已取消', 'AbortError');
      failure = convert(error, 'funding');
    }
    checkAbort(signal);
    return snapshot(failure === null);
  }
  return Object.freeze({ verify, positions, funding });
}
