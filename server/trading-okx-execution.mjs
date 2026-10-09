import { createHash } from 'node:crypto';
import { compareDecimals } from './trading-decimal.mjs';
import {
  OKX_SYMBOLS, OkxProtocolError, createOkxProtocol, fail, object, requireObject, list, one, amount,
  optionalPrice, id, iso, instrumentId, validateConfig, positionSize, multiply, multiple, checkAbort,
} from './trading-okx-common.mjs';

// Native ordinary PostOnly orders with in-place price amendment. No market,
// close-position, mode-setting, leverage-setting or algo-write route exists.
// A create/amend/cancel ACK is never a fill or cancellation confirmation.
// https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-place-order
// https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-amend-order
// https://www.okx.com/docs-v5/log_en/#2026-08-20
const ALGO_TYPES = Object.freeze(['conditional,oco', 'trigger', 'move_order_stop', 'iceberg', 'twap', 'chase', 'smart_iceberg']);
const POSITION_SIDES = Object.freeze({ BOTH: 'net', LONG: 'long', SHORT: 'short' });
const TERMINAL = new Set(['filled', 'canceled', 'mmp_canceled']);
const MAX_PAGES = 40;
const MAX_ROWS = 2000;
const QUOTE_MAX_AGE = 10_000;
const hedgeClose = (side, positionSide) => positionSide === 'LONG' && side === 'sell' || positionSide === 'SHORT' && side === 'buy';
const clientIdFor = value => 'ox' + createHash('sha256').update(value).digest('hex').slice(0, 30);

export function createOkxExecutionClient({ ErrorClass, ...options } = {}) {
  if (typeof ErrorClass !== 'function') throw new TypeError('ExecutionExchangeError is required');
  function convert(error) {
    // Lease failures originate in the execution service and must remain its
    // original NotSubmittedError, rather than becoming ambiguous venue errors.
    if (!(error instanceof OkxProtocolError)) return error;
    const result = new ErrorClass(error.code, { uncertain: error.uncertain, notFound: error.notFound, providerCode: error.providerCode });
    result.message = error.message;
    return result;
  }
  let protocol;
  try { protocol = createOkxProtocol(options); } catch (error) { throw convert(error); }
  let amendSequence = 0;
  const wrapped = fn => async (...args) => { try { return await fn(...args); } catch (error) { throw convert(error); } };
  function modeOf(value) { const mode = value ?? 'cross'; if (!['cross', 'isolated'].includes(mode)) fail('account_mode'); return mode; }
  function specOf(value, requireId = false) {
    if (!object(value) || !OKX_SYMBOLS.includes(value.symbol) || !['buy', 'sell'].includes(value.side)
      || !Object.hasOwn(POSITION_SIDES, value.positionSide) || typeof value.reduceOnly !== 'boolean'
      || typeof value.clientId !== 'string' || !/^[.A-Z:/a-z0-9_-]{1,32}$/.test(value.clientId)) fail('input');
    let quantity, stopPrice;
    try { quantity = amount(value.quantity, { positive: true }); stopPrice = amount(value.stopPrice, { positive: true }); } catch { fail('input'); }
    if (value.positionSide !== 'BOTH' && value.reduceOnly !== hedgeClose(value.side, value.positionSide)) fail('input');
    let orderId = value.id ?? null;
    if (orderId !== null) { try { orderId = id(orderId); } catch { fail('input'); } }
    if (requireId && orderId === null) fail('input');
    let contractSize;
    if (value.contractSize !== undefined) { try { contractSize = amount(value.contractSize, { positive: true }); } catch { fail('input'); } }
    if (value.instrumentId !== undefined && value.instrumentId !== instrumentId(value.symbol)) fail('input');
    return { symbol: value.symbol, side: value.side, positionSide: value.positionSide, quantity, stopPrice,
      reduceOnly: value.reduceOnly, clientId: value.clientId, nativeClientId: clientIdFor(value.clientId), id: orderId,
      ...(contractSize === undefined ? {} : { contractSize }), ...(value.instrumentId === undefined ? {} : { instrumentId: value.instrumentId }) };
  }
  async function permissionSnapshot(credentials, signal) {
    return validateConfig(one(await protocol.request('config', credentials, {}, { signal })), { execution: true });
  }
  function volume(row) {
    const quantity = amount(row.sz, { positive: true }), filledQuantity = amount(row.accFillSz, { nonnegative: true });
    if (compareDecimals(filledQuantity, quantity) > 0) fail();
    return { quantity, filledQuantity };
  }
  function positionSideOf(value) {
    const result = Object.keys(POSITION_SIDES).find(key => POSITION_SIDES[key] === value);
    if (!result) fail(); return result;
  }
  function parseOrder(row, spec, mode, { matchQuantity = true } = {}) {
    requireObject(row);
    const positionSide = positionSideOf(row.posSide), size = volume(row);
    if (row.instId !== instrumentId(spec.symbol) || row.instType !== 'SWAP' || row.tdMode !== mode
      || row.clOrdId !== spec.nativeClientId || row.ordType !== 'post_only' || !['buy', 'sell'].includes(row.side)
      || !['live', 'partially_filled', ...TERMINAL].includes(row.state) || !['true', 'false'].includes(row.reduceOnly)
      || row.algoId !== undefined && row.algoId !== '' || matchQuantity && row.attachAlgoOrds !== undefined && list(row.attachAlgoOrds).length !== 0
      || row.ccy !== undefined && row.ccy !== '' && row.ccy !== 'USDT') fail();
    const reduceOnly = row.reduceOnly === 'true' || hedgeClose(row.side, positionSide);
    const orderId = id(row.ordId), terminal = TERMINAL.has(row.state);
    if (spec.id && spec.id !== orderId || row.side !== spec.side || positionSide !== spec.positionSide || reduceOnly !== spec.reduceOnly
      || matchQuantity && size.quantity !== spec.quantity || row.state === 'filled' && size.quantity !== size.filledQuantity) fail();
    return { id: orderId, kind: 'order', status: terminal ? 'terminal' : 'working', ...size,
      price: optionalPrice(row.px), averagePrice: optionalPrice(row.avgPx), terminal, childrenSettled: terminal,
      symbol: spec.symbol, side: row.side, reduceOnly, positionSide, createdAt: iso(row.cTime),
    };
  }
  async function readOrder(credentials, spec, { accountMode, signal }, parseOptions) {
    const rows = list(await protocol.request('inspect', credentials, { instId: instrumentId(spec.symbol),
      ...(spec.id ? { ordId: spec.id } : { clOrdId: spec.nativeClientId }) }, { signal }), 1);
    if (rows.length === 0) fail('not_found', { notFound: true });
    return parseOrder(rows[0], spec, accountMode, parseOptions);
  }
  function ack(rows, spec, { reqId } = {}) {
    try {
      const row = one(rows), orderId = id(row.ordId);
      if (spec.id && spec.id !== orderId || row.clOrdId !== spec.nativeClientId || reqId && row.reqId !== reqId) fail();
      return { id: orderId, kind: 'order' };
    } catch { fail('invalid_data', { uncertain: true }); }
  }
  function assertMarket(market, spec) {
    const time = Date.parse(market.at), now = protocol.clock(), { rule } = market;
    if (!Number.isFinite(time) || now - time > QUOTE_MAX_AGE || time - now > 1000) fail('not_tradable');
    if (spec.contractSize !== undefined && spec.contractSize !== rule.contractSize
      || spec.instrumentId !== undefined && spec.instrumentId !== rule.instrumentId) fail('not_tradable');
    if (!multiple(spec.quantity, rule.quantityStep) || !multiple(spec.stopPrice, rule.tickSize)
      || compareDecimals(spec.quantity, rule.minQuantity) < 0 || compareDecimals(spec.quantity, rule.maxQuantity) > 0) fail('input');
    const price = spec.side === 'buy' ? market.bid : market.ask;
    if (spec.side === 'buy' ? compareDecimals(price, spec.stopPrice) >= 0 : compareDecimals(price, spec.stopPrice) <= 0) {
      const error = new OkxProtocolError('rejected'); error.message = 'OKX 盘口已触及追价停止价，本次委托未发送'; throw error;
    }
    if (rule.maxNotional !== null && compareDecimals(multiply(spec.quantity, rule.contractSize, price), rule.maxNotional) > 0) fail('input');
    return price;
  }
  function mutationGuard(market, spec, callback) {
    return () => { callback?.(); assertMarket(market, spec); };
  }
  async function ordinaryOrders(credentials, symbol, mode, signal) {
    const results = [], seen = new Set();
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = list(await protocol.request('orders', credentials, { instType: 'SWAP', instId: instrumentId(symbol), limit: '100', ...(after ? { after } : {}) }, { signal }));
      let previous = after;
      for (const row of rows) {
        requireObject(row);
        const orderId = id(row.ordId);
        if (previous !== null && BigInt(orderId) >= BigInt(previous) || seen.has(orderId)) fail('pagination');
        previous = orderId; seen.add(orderId);
        if (row.instId !== instrumentId(symbol) || row.instType !== 'SWAP' || !['live', 'partially_filled'].includes(row.state)
          || !['buy', 'sell'].includes(row.side)) fail();
        if (row.tdMode !== mode) fail('account_mode');
        results.push({ id: orderId, symbol, side: row.side, positionSide: positionSideOf(row.posSide), ...volume(row) });
        if (results.length > MAX_ROWS) fail('pagination');
      }
      if (rows.length < 100) return results;
      after = id(rows.at(-1).ordId);
    }
    fail('pagination');
  }
  const verify = wrapped(async (credentials, { accountMode, signal } = {}) => {
    modeOf(accountMode);
    const result = await permissionSnapshot(credentials, signal);
    return { identity: result.identity };
  });
  const account = wrapped(async (credentials, { accountMode, signal } = {}) => {
    const mode = modeOf(accountMode), config = await permissionSnapshot(credentials, signal);
    const positions = [], openOrders = [], modes = {}, seen = new Set();
    for (const symbol of OKX_SYMBOLS) {
      modes[symbol] = config.positionMode;
      for (const row of list(await protocol.request('positions', credentials, { instType: 'SWAP', instId: instrumentId(symbol) }, { signal }), 20)) {
        const size = positionSize(row, symbol, config.positionMode);
        if (!size) continue;
        if (row.mgnMode !== mode) {
          const error = new OkxProtocolError('account_mode');
          error.message = 'OKX 原油合约存在另一保证金模式的仓位，请先核对；系统不会切换模式或自动平仓'; throw error;
        }
        const key = `${symbol}:${row.posSide}`;
        if (seen.has(key)) fail(); seen.add(key);
        positions.push({ symbol, ...size });
      }
      const orders = await ordinaryOrders(credentials, symbol, mode, signal);
      for (const order of orders) if ((order.positionSide === 'BOTH') !== (config.positionMode === 'one-way')) fail('account_mode');
      openOrders.push(...orders);
      // Ordinary orders omit untriggered strategies. Every documented active
      // algorithm type is checked; no such order is owned by this adapter.
      for (const ordType of ALGO_TYPES) {
        const rows = list(await protocol.request('algos', credentials, { ordType, instType: 'SWAP', instId: instrumentId(symbol), limit: '100' }, { signal }));
        for (const row of rows) if (!object(row) || row.instId !== instrumentId(symbol)) fail();
        if (rows.length) fail('external_orders');
      }
    }
    checkAbort(signal);
    return { identity: config.identity, modes, positions, openOrders, strategies: [] };
  });
  const market = wrapped((symbol, options) => protocol.market(symbol, options));
  const create = wrapped(async (credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) => {
    const mode = modeOf(accountMode), spec = specOf(rawSpec);
    protocol.credentialsValid(credentials);
    const quote = await protocol.market(spec.symbol, { signal, refreshRule: true }), price = assertMarket(quote, spec);
    const rows = await protocol.request('create', credentials, {
      instId: instrumentId(spec.symbol), tdMode: mode, clOrdId: spec.nativeClientId,
      side: spec.side, posSide: POSITION_SIDES[spec.positionSide], ordType: 'post_only', px: price, sz: spec.quantity,
      ...(spec.positionSide === 'BOTH' ? { reduceOnly: spec.reduceOnly } : {}), pxAmendType: '0',
    }, { signal, beforeMutation: mutationGuard(quote, spec, beforeMutation) });
    return ack(rows, spec);
  });
  const inspect = wrapped(async (credentials, rawSpec, { accountMode, signal } = {}) => {
    return readOrder(credentials, specOf(rawSpec), { accountMode: modeOf(accountMode), signal });
  });
  const amend = wrapped(async (credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) => {
    const mode = modeOf(accountMode), spec = specOf(rawSpec, true), readOptions = { accountMode: mode, signal };
    const current = await readOrder(credentials, spec, readOptions);
    if (current.terminal) return current;
    const quote = await protocol.market(spec.symbol, { signal, refreshRule: true }), price = assertMarket(quote, spec);
    if (current.price === price) return current;
    const reqId = createHash('sha256').update(spec.nativeClientId + ':' + String(++amendSequence)).digest('hex').slice(0, 32);
    const rows = await protocol.request('amend', credentials, {
      instId: instrumentId(spec.symbol), ordId: spec.id, clOrdId: spec.nativeClientId, reqId,
      newPx: price, cxlOnFail: false, pxAmendType: '0',
      // Omit newSz: OKX defines it as the total, not the remainder. Keeping the
      // original quantity also prevents a system-trimmed reduce-only order
      // from being increased during a concurrent account change.
    }, { signal, beforeMutation: mutationGuard(quote, spec, beforeMutation) });
    ack(rows, spec, { reqId });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await readOrder(credentials, spec, readOptions);
        if (result.terminal || result.price === price) return result;
      }
      fail('upstream', { uncertain: true });
    } catch (error) {
      if (error instanceof OkxProtocolError) error.uncertain = true;
      throw error;
    }
  });
  const stop = wrapped(async (credentials, rawSpec, { accountMode, signal, beforeMutation } = {}) => {
    const mode = modeOf(accountMode), spec = specOf(rawSpec);
    // Quantity may have been reduced by the venue. We may still cancel our
    // strongly identified order, while ordinary inspection refuses to resume
    // an execution whose requested quantity no longer matches.
    const current = await readOrder(credentials, spec, { accountMode: mode, signal }, { matchQuantity: false });
    if (current.terminal) return;
    const rows = await protocol.request('stop', credentials, { instId: instrumentId(spec.symbol), ordId: current.id, clOrdId: spec.nativeClientId }, { signal, beforeMutation });
    ack(rows, { ...spec, id: current.id });
  });
  return Object.freeze({ verify, account, market, create, amend, inspect, stop });
}
