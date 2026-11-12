import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicJson } from '../atomic-json.mjs';
import { HttpError } from '../http-common.mjs';
import { compareDecimals, decimal, decimalUnits as units, formatDecimalUnits as fmt } from '../trading-decimal.mjs';
import { createOndoClient, OndoError, ONDO_MARKET } from '../trading-ondo-client.mjs';
import { createOndoStream } from '../trading-ondo-stream.mjs';
import { assessQuote, closeMoves, closePrice, floorStep, notional, planQuote, quoteSize, withoutOrders } from '../trading-ondo-quote.mjs';

const FILE_LIMIT = 64 * 1024;
// Every order of this module carries this client-id prefix; orders without it are never touched.
const PREFIX = 'omm-';
const SIDES = ['buy', 'sell'];
const MAX_MARKETS = 10;
const EVENT_LIMIT = 200, EVENT_VIEW = 60;
// Snapshots arrive about four a second; a quote 4 bps out must not be steered by an older book.
const BOOK_MAX_AGE_MS = 1500, SOURCE_MAX_AGE_MS = 10_000;
const RULES_REFRESH_MS = 60_000, RULES_MAX_AGE_MS = 300_000;
const SYNC_MS = 5000, SYNC_GAP_MS = 1000, SYNC_MAX_AGE_MS = 15_000;
const MIN_REST_MS = 1000;
const UNKNOWN_CHECKS = 3, UNKNOWN_GAP_MS = 2000, UNKNOWN_MISSES = 5;
const MAX_BACKOFF_MS = 60_000;
const STRAY_CANCELS = 5;
// A stop waits this long for the withdrawal to be confirmed, then keeps trying in the background.
const STOP_WAIT_MS = 20_000, PREPARE_WAIT_MS = 45_000, CLOSE_WAIT_MS = 3000, STOP_PAUSE_MS = 250, STOP_ROUNDS = 400;
const CLEANUP_ATTEMPTS = 3, CLEANUP_PAUSE_MS = 10_000;
// Reasons that also withdraw reduce-only closes: nothing of this module may rest.
const CANCEL_ALL = new Set(['stopping', 'maintenance', 'admission', 'auth_failed']);
const GONE = new Set(['order_not_found', 'order_already_canceled', 'order_already_cancelled', 'order_already_fully_filled', 'order_already_filled']);
const QUIET = new Set(['rate_limited', 'local_backlog', 'closed', 'timeout', 'network']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abs = value => (value < 0n ? -value : value);

export const ONDO_MM_DEFAULTS = Object.freeze({ mode: 'observe', markets: Object.freeze(['NVDA-USD.P']), orderUsd: '100', targetBps: '4', minBps: '3', maxBps: '4.8',
  wallEnabled: true, wallUsd: '5000', maxPositionUsd: '100', maxTotalUsd: '500', dwellMs: 1500, rps: 4 });
const CONFIG_KEYS = Object.keys(ONDO_MM_DEFAULTS);

function number(value, name, min, max) {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,4})?$/.test(value)) throw new Error(`${name}格式不正确`);
  const text = decimal(value);
  if (compareDecimals(text, min) < 0 || compareDecimals(text, max) > 0) throw new Error(`${name}需在 ${min} 至 ${max} 之间`);
  return text;
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}需为 ${min} 至 ${max} 的整数`);
  return value;
}
export function validateOndoMmConfig(value) {
  if (!object(value) || Object.keys(value).some(key => !CONFIG_KEYS.includes(key)) || CONFIG_KEYS.some(key => !Object.hasOwn(value, key))) throw new Error('配置字段不完整或包含未知字段');
  if (!['observe', 'live'].includes(value.mode)) throw new Error('运行模式无效');
  if (!Array.isArray(value.markets) || value.markets.length < 1 || value.markets.length > MAX_MARKETS
    || value.markets.some(market => typeof market !== 'string' || !ONDO_MARKET.test(market)) || new Set(value.markets).size !== value.markets.length) throw new Error(`市场需为 1 至 ${MAX_MARKETS} 个不重复的永续合约（如 NVDA-USD.P）`);
  if (typeof value.wallEnabled !== 'boolean') throw new Error('大单保护开关无效');
  const next = { mode: value.mode, markets: [...value.markets], orderUsd: number(value.orderUsd, '每单金额', '1', '1000000'),
    targetBps: number(value.targetBps, '目标距离', '0.5', '25'), minBps: number(value.minBps, '最近距离', '0.1', '25'), maxBps: number(value.maxBps, '最远距离', '0.5', '25'),
    wallEnabled: value.wallEnabled, wallUsd: number(value.wallUsd, '大单阈值', '0', '100000000'),
    maxPositionUsd: number(value.maxPositionUsd, '单市场最大持仓', '1', '100000000'), maxTotalUsd: number(value.maxTotalUsd, '总名义上限', '1', '1000000000'),
    dwellMs: integer(value.dwellMs, '改价确认时间', 0, 60_000), rps: integer(value.rps, '每秒请求上限', 1, 10) };
  if (compareDecimals(next.minBps, next.targetBps) >= 0 || compareDecimals(next.targetBps, next.maxBps) >= 0) throw new Error('距离需满足 最近 < 目标 < 最远');
  if (compareDecimals(next.maxPositionUsd, next.orderUsd) < 0) throw new Error('单市场最大持仓不能小于每单金额');
  if (compareDecimals(next.maxTotalUsd, next.orderUsd) < 0) throw new Error('总名义上限不能小于每单金额');
  return next;
}
function validateCredentials(value) {
  const ok = (text, min) => typeof text === 'string' && text.length >= min && text.length <= 300 && /^[\x21-\x7e]+$/.test(text);
  if (!object(value) || !ok(value.keyId, 8) || !ok(value.secret, 16)) throw new Error('API Key ID 或 Secret 格式不正确');
  return { keyId: value.keyId, secret: value.secret };
}
function readBounded(file) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT) throw new Error('invalid_ondo_mm_file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Two-sided resting quotes on Ondo Perps that follow the book to stay inside
// the liquidity-reward band, behind a large resting order where one exists.
// Inside a wide spread a quote can itself be the best price.
//
// Per market and side there is at most one post-only order. A quote is
// withdrawn at once when it gets closer than minBps, when the book is stale or
// one-sided, when the market stops trading, when the account can no longer be
// read, while the venue rate-limits this client, during update maintenance or
// quarantine recovery, and on stop. A fill
// leaves a position: the side that would add to it is quoted only within
// maxPositionUsd, the other side carries a reduce-only post-only close at the
// touch. The account (open orders, then positions) is read over REST; socket
// messages only hint that it changed. Nothing is placed in a market whose
// account view is not current. A position that exists before a live start is
// closed the same way, so the start refuses it unless the caller adopts it.
// After a stop the positions still held are reported; nothing closes them.
//
// External calls (all through createOndoClient: 5 s timeout, no automatic
// resend, 429 cooldown): a placement with an unknown outcome is looked up by
// client id until the venue has said UNKNOWN_CHECKS times that it has none, or
// UNKNOWN_MISSES account reads have not listed it, and is never sent again; a refused placement backs its side off exponentially to 60 s; a failed
// cancel is retried each second. A restart never resumes a live session; it
// only withdraws what the previous one left.
export function createOndoMarketMaker({ dataDir, encrypt, decrypt, readMaintenance = () => false, readAdmission = () => true, admit = operation => operation(),
  log = console, now = Date.now, intervalMs = 250, fetchImpl, WebSocketImpl, clientFactory = createOndoClient, streamFactory = createOndoStream,
  sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  const directory = path.join(dataDir, 'ondo-mm');
  const configPath = path.join(directory, 'config.json'), credentialsPath = path.join(directory, 'credentials.json'), sessionPath = path.join(directory, 'session.json');
  let config = structuredClone(ONDO_MM_DEFAULTS), revision = 0, loadError = null;
  let keyHint = null, keyError = null;
  let session = null, recovery = null, cleaning = null, timer = null, closed = false, cooldownUntil = 0, events = [], lastError = null, leftPositions = [], starting = null;

  function event(market, kind, text) {
    events.unshift({ at: new Date(now()).toISOString(), market, kind, text });
    if (events.length > EVENT_LIMIT) events.length = EVENT_LIMIT;
  }
  function gate() {
    try { return readMaintenance() ? 'maintenance' : !readAdmission() ? 'admission' : null; } catch { return 'maintenance'; }
  }
  const gateText = reason => (reason === 'maintenance' ? '工作台正在更新维护，实盘挂单暂停' : '账户写入处于隔离恢复状态，实盘挂单暂停');
  function credentials() {
    const saved = readBounded(credentialsPath);
    if (!saved) throw new HttpError(409, '请先保存 Ondo API Key');
    return validateCredentials(decrypt(saved.value));
  }
  const failure = error => (error instanceof OndoError ? error.code : 'internal');
  const clientOptions = extra => ({ ...(fetchImpl ? { fetchImpl } : {}), now, cooldownUntil, ...extra });

  function markDirty(market) { market.dirty = true; market.dirtySeq += 1; }
  function markAllDirty(current) { for (const market of current.markets.values()) markDirty(market); }
  function denied(current, error) {
    if (error instanceof OndoError && (error.status === 401 || error.status === 403) && !current.halt) {
      current.halt = 'auth_failed'; lastError = `Ondo 拒绝了凭据或访问（${error.code}），已停止挂单`;
      event(null, 'error', lastError);
    }
  }

  // --- account -------------------------------------------------------------
  function hint(current, channel, data) {
    const zero = value => value === undefined || (typeof value === 'string' && /^0(?:\.0+)?$/.test(value));
    for (const row of Array.isArray(data) ? data : [data]) {
      const market = object(row) ? current.markets.get(row.market) : null;
      if (!market) { if (!object(row) || typeof row.market !== 'string') markAllDirty(current); continue; }
      if (channel === 'fillsPerps') {
        markDirty(market); current.totals.fills += 1;
        const safe = SIDES.includes(row.side) && [row.size, row.price].every(value => typeof value === 'string' && /^[0-9.]{1,24}$/.test(value));
        event(market.name, 'fill', safe ? `成交：${row.side === 'buy' ? '买入' : '卖出'} ${row.size} @ ${row.price}` : '收到成交通知');
      } else if (channel === 'ordersPerps') {
        const plain = zero(row.filledSize) && (row.status === 'open' || (row.status === 'canceled' && !row.cancelReason));
        if (!plain) markDirty(market);
      } else {
        let size = null;
        try { size = units(String(row.netQuantity).replace(/^-/, '')) * (row.direction === 'short' ? -1n : 1n); } catch { /* reread */ }
        if (size === null || !market.positionKnown || size !== market.position) markDirty(market);
      }
    }
  }
  // Orders are read before positions: a fill between the two reads then shows
  // as a position whose order still looks open, never as a vanished order
  // without its position, which would let the filled side be quoted again.
  async function sync(current) {
    if (current.syncing) return;
    current.syncing = true; current.syncAttemptAt = now();
    const started = now(), seqs = new Map([...current.markets.values()].map(market => [market, market.dirtySeq]));
    try {
      const open = await current.client.openOrders();
      const positions = await current.client.positions();
      if (session !== current) return;
      const strays = [];
      let remote = 0;
      for (const order of open) {
        const ours = order.clientId?.startsWith(PREFIX) === true;
        if (ours) remote += 1;
        if (ours && !current.markets.has(order.market)) strays.push(order);
      }
      for (const market of current.markets.values()) {
        const listed = open.filter(order => order.market === market.name), seen = new Set();
        market.foreign = [];
        for (const order of listed) {
          const size = units(order.size), remaining = size - units(order.filled);
          if (order.clientId?.startsWith(PREFIX) !== true) { if (remaining > 0n) market.foreign.push({ side: order.side, price: units(order.price), remaining }); continue; }
          seen.add(order.clientId);
          const tracked = market.orders.get(order.clientId);
          if (!tracked) {
            market.orders.set(order.clientId, { clientId: order.clientId, id: order.id, side: order.side, role: order.reduceOnly ? 'close' : 'quote', price: units(order.price),
              size, remaining, state: 'open', since: started, attempts: 0, nextCheckAt: 0, nextCancelAt: 0, mode: null });
            event(market.name, 'adopt', `接管已有挂单：${order.side === 'buy' ? '买' : '卖'} ${order.price}`);
          } else if (tracked.state !== 'sending') {
            if (tracked.state === 'unknown') { tracked.state = 'open'; tracked.id = order.id; }
            tracked.remaining = remaining;
          }
        }
        for (const tracked of [...market.orders.values()]) {
          // A placement whose lookup never answers is not left unknown forever: it is not resting.
          if (tracked.state === 'unknown' && !seen.has(tracked.clientId) && tracked.since < started && (tracked.missed = (tracked.missed ?? 0) + 1) >= UNKNOWN_MISSES) {
            market.orders.delete(tracked.clientId); markDirty(market);
            event(market.name, 'unknown', '多次读取账户都没有该订单，按未下单处理');
            continue;
          }
          if (seen.has(tracked.clientId) || !['open', 'canceling'].includes(tracked.state) || tracked.since >= started) continue;
          market.orders.delete(tracked.clientId);
          event(market.name, 'gone', `挂单已不在盘口（成交或被撤）：${tracked.side === 'buy' ? '买' : '卖'} ${fmt(tracked.price)}`);
        }
        const position = units(positions.get(market.name) ?? '0');
        if (market.positionKnown && position !== market.position) event(market.name, 'position', `持仓 ${fmt(market.position)} → ${fmt(position)}`);
        market.position = position; market.positionKnown = true;
        if (market.dirtySeq === seqs.get(market)) market.dirty = false;
      }
      current.remoteOurs = remote; current.verifiedAt = started; current.syncOkAt = now(); current.syncError = null;
      for (const order of strays.slice(0, STRAY_CANCELS)) {
        current.lastWriteAt = now();
        try { await current.client.cancel(order.id); event(order.market, 'cancel', '已撤销不在当前配置内的遗留挂单'); } catch (error) { denied(current, error); }
        current.lastWriteAt = now();
      }
    } catch (error) {
      current.syncError = failure(error); denied(current, error);
      if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 账户读取失败');
    } finally { current.syncing = false; }
  }
  async function refreshRules(current) {
    if (current.loadingRules) return;
    current.loadingRules = true; current.rulesAttemptAt = now();
    try {
      const rules = await current.client.markets();
      if (session !== current) return;
      for (const market of current.markets.values()) {
        const rule = rules.get(market.name);
        market.rules = rule ? { tick: units(rule.tick), step: units(rule.step), trading: rule.trading } : null;
        market.listed = !!rule;
      }
      current.rulesAt = now(); current.rulesError = null;
    } catch (error) { current.rulesError = failure(error); } finally { current.loadingRules = false; }
  }

  // --- orders --------------------------------------------------------------
  async function placeOrder(current, market, side, role, price, size, mode) {
    const clientId = `${current.prefix}${(current.seq++).toString(36)}`;
    const order = { clientId, id: null, side, role, price, size, remaining: size, state: 'sending', since: now(), attempts: 0, nextCheckAt: 0, nextCancelAt: 0, mode };
    market.orders.set(clientId, order); current.lastWriteAt = now();
    try {
      const placed = await current.client.place({ market: market.name, side, price: fmt(price), size: fmt(size), reduceOnly: role === 'close', clientOrderId: clientId });
      order.id = placed.id; order.since = now(); market.rejects[side] = 0; current.totals.placed += 1;
      const filled = units(placed.filled);
      if (!['open', 'pending'].includes(placed.status)) { market.orders.delete(clientId); markDirty(market); }
      else { order.state = 'open'; order.remaining = size - filled; if (filled > 0n) markDirty(market); }
    } catch (error) {
      if (error instanceof OndoError && error.uncertain) {
        order.state = 'unknown'; order.nextCheckAt = now() + SYNC_GAP_MS;
        event(market.name, 'unknown', `下单结果未知（${error.code}），正在按订单号核对，不会重发`);
      } else {
        market.orders.delete(clientId);
        const code = failure(error);
        if (code === 'post_only_has_match') { current.totals.postOnly += 1; market.backoff[side] = now() + 500; }
        else if (QUIET.has(code)) market.backoff[side] = now() + SYNC_GAP_MS;
        else {
          market.rejects[side] += 1; current.totals.rejected += 1;
          market.backoff[side] = now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(market.rejects[side], 10));
          event(market.name, 'reject', `${role === 'close' ? '平仓单' : '挂单'}被拒：${code}`);
          // The position or margin behind a refusal may have changed.
          markDirty(market); denied(current, error);
          if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 下单失败');
        }
      }
    } finally { current.lastWriteAt = now(); }
  }
  async function cancelOrder(current, market, order, reason) {
    if (order.state !== 'open' || now() < order.nextCancelAt) return;
    order.state = 'canceling'; current.lastWriteAt = now();
    try {
      const result = await current.client.cancel(order.id);
      market.orders.delete(order.clientId); current.totals.canceled += 1; market.lastCancel = reason;
      if (!result || units(result.filled) !== order.size - order.remaining) markDirty(market);
    } catch (error) {
      const code = failure(error);
      if (GONE.has(code)) { market.orders.delete(order.clientId); markDirty(market); }
      else {
        if (order.state === 'canceling') order.state = 'open';
        order.nextCancelAt = now() + SYNC_GAP_MS;
        if (error instanceof OndoError && error.uncertain) markDirty(market);
        denied(current, error);
        if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 撤单失败');
      }
    } finally { current.lastWriteAt = now(); }
  }
  // Bounded lookup of placements whose outcome was not read. A failed lookup is
  // not an answer and does not count toward the bound.
  async function resolveUnknown(current, market) {
    for (const order of [...market.orders.values()]) {
      if (order.state !== 'unknown' || now() < order.nextCheckAt) continue;
      order.nextCheckAt = now() + UNKNOWN_GAP_MS;
      let found;
      try { found = await current.client.orderByClientId(order.clientId); } catch (error) { denied(current, error); continue; }
      if (order.state !== 'unknown') continue;
      if (found?.status === 'open') { order.id = found.id; order.state = 'open'; order.since = now(); order.remaining = order.size - units(found.filled); if (order.remaining !== order.size) markDirty(market); }
      else if (found && ['fullyfilled', 'canceled'].includes(found.status)) { market.orders.delete(order.clientId); markDirty(market); }
      else if (!found && ++order.attempts >= UNKNOWN_CHECKS) {
        market.orders.delete(order.clientId); markDirty(market);
        event(market.name, 'unknown', '核对后交易所没有该订单，按未下单处理');
      }
    }
  }

  // --- decisions -----------------------------------------------------------
  function holdOf(current, market) {
    if (current.stopping) return 'stopping';
    if (current.live) { const reason = gate(); if (reason) return reason; }
    if (current.halt) return current.halt;
    if (now() < current.client.cooldownUntil()) return 'rate_limited';
    if (!current.rulesAt || now() - current.rulesAt > RULES_MAX_AGE_MS) return 'no_rules';
    if (!market.rules) return 'unknown_market';
    if (!market.rules.trading) return 'market_closed';
    if (current.live && !current.stream.status().privateReady) return 'private_stream';
    if (current.live && now() - current.syncOkAt > SYNC_MAX_AGE_MS) return 'account_unknown';
    const book = market.book;
    if (!book || !book.bids.length || !book.asks.length || now() - market.bookAt > BOOK_MAX_AGE_MS || now() - book.time > SOURCE_MAX_AGE_MS) return 'stale_book';
    if ([...market.orders.values()].some(order => order.state === 'unknown')) return 'unknown_order';
    return null;
  }
  // Resting quotes plus positions of the configured markets, or null when a
  // position is not known or has never had a price to value it with.
  function exposure(current) {
    let total = 0n;
    for (const market of current.markets.values()) {
      for (const order of market.orders.values()) if (order.role === 'quote') total += notional(order.price, order.remaining);
      if (!market.positionKnown) return null;
      if (market.position === 0n) continue;
      if (market.mid === null) return null;
      total += notional(market.mid, abs(market.position));
    }
    return total;
  }
  const bpsOf = (price, mid) => Number(abs(price - mid) * 10_000_000n / mid) / 1000;
  // What one side should do now: { type: 'keep'|'cancel'|'place'|'none', ... } with its page view.
  function decide(current, market, side) {
    const { book, rules: { tick, step } } = market, cfg = current.cfg, at = now();
    const mid = (book.bids[0][0] + book.asks[0][0]) / 2n;
    const mine = [...market.orders.values()].filter(order => order.side === side);
    const shown = order => ({ role: order.role, state: order.state, price: fmt(order.price), size: fmt(order.remaining), bps: bpsOf(order.price, mid), mode: order.mode });
    if (mine.some(order => order.state !== 'open')) return { type: 'none', view: { ...shown(mine.find(order => order.state !== 'open')), reason: 'in_flight' } };
    if (mine.length > 1) return { type: 'cancel', order: mine[1], reason: 'duplicate', view: { ...shown(mine[0]), reason: 'duplicate' } };
    const existing = mine[0] ?? null;
    const own = [...[...market.orders.values()].map(order => ({ side: order.side, price: order.price, remaining: order.remaining, ours: true })), ...market.foreign];
    const ext = withoutOrders(book, own), ref = withoutOrders(book, own.filter(order => order.ours && order.side === side));
    let limit;
    for (const order of own) if (order.side !== side && order.remaining > 0n && (limit === undefined || (side === 'buy' ? order.price < limit : order.price > limit))) limit = order.price;
    const fresh = !market.dirty && market.positionKnown, position = market.position;
    const role = (position > 0n && side === 'sell') || (position < 0n && side === 'buy') ? 'close' : 'quote';
    const none = reason => ({ type: 'none', view: { role, state: 'none', reason } });
    // Until the account view is current an existing order is judged as what it is.
    const actual = existing && !fresh ? existing.role : role;
    if (existing && existing.role !== actual) return { type: 'cancel', order: existing, reason: 'role_change', view: { ...shown(existing), reason: 'role_change' } };
    if (actual === 'quote') {
      const held = notional(mid, abs(position));
      if (existing) {
        const view = shown(existing);
        if (fresh && (held + notional(existing.price, existing.remaining)) * 100n > cfg.maxPosition * 105n) return { type: 'cancel', order: existing, reason: 'position_cap', view: { ...view, reason: 'position_cap' } };
        const verdict = assessQuote(side, existing.price, ref, ext, tick, cfg, limit);
        if (verdict.keep) { market.pending[side] = null; return { type: 'keep', view: { ...view, bps: verdict.bps, protection: fmt(verdict.protection) } }; }
        if (!verdict.urgent) {
          market.pending[side] ??= at;
          if (at - market.pending[side] < current.config.dwellMs || at - existing.since < MIN_REST_MS) return { type: 'keep', view: { ...view, reason: verdict.reason } };
        }
        market.pending[side] = null;
        return { type: 'cancel', order: existing, reason: verdict.reason, view: { ...view, reason: verdict.reason } };
      }
      if (!fresh) return none('syncing');
      if (at < market.backoff[side]) return none('backoff');
      if (held + cfg.orderUsd > cfg.maxPosition) return none('position_cap');
      const plan = planQuote(side, ref, ext, tick, cfg, limit);
      if (plan.price === null) return none(plan.reason);
      const size = quoteSize(cfg.orderUsd, plan.price, step);
      if (size <= 0n) return none('size_too_small');
      const total = exposure(current);
      if (total === null) return none('total_unknown');
      if (total + notional(plan.price, size) > cfg.maxTotal) return none('total_cap');
      return { type: 'place', role: 'quote', price: plan.price, size, mode: plan.mode,
        view: { role: 'quote', state: 'planned', price: fmt(plan.price), size: fmt(size), bps: plan.bps, mode: plan.mode, protection: fmt(plan.protection) } };
    }
    if (existing && !fresh) return { type: 'keep', view: shown(existing) };
    const size = floorStep(abs(position), step);
    let price = closePrice(side, ext, tick);
    // A close must not reach this account's own resting order on the other side.
    if (price !== null && limit !== undefined && (side === 'sell' ? price <= limit : price >= limit)) price = side === 'sell' ? limit + tick : limit - tick;
    if (existing) {
      const view = shown(existing);
      if (existing.remaining !== size) return { type: 'cancel', order: existing, reason: 'close_size', view: { ...view, reason: 'close_size' } };
      if (price !== null && closeMoves(side, existing.price, price) && at - existing.since >= MIN_REST_MS) return { type: 'cancel', order: existing, reason: 'close_follow', view: { ...view, reason: 'close_follow' } };
      return { type: 'keep', view };
    }
    if (!fresh) return none('syncing');
    if (size <= 0n) return none('dust_position');
    if (price === null || price <= 0n) return none('no_price');
    if (at < market.backoff[side]) return none('backoff');
    return { type: 'place', role: 'close', price, size, mode: 'close', view: { role: 'close', state: 'planned', price: fmt(price), size: fmt(size), bps: bpsOf(price, mid), mode: 'close' } };
  }
  function restingView(market, reason) {
    for (const side of SIDES) {
      const order = [...market.orders.values()].find(item => item.side === side);
      market.view[side] = order ? { role: order.role, state: order.state, price: fmt(order.price), size: fmt(order.remaining), mode: order.mode, reason } : { role: 'quote', state: 'none', reason };
    }
  }
  async function run(current, market) {
    if (current.live) await resolveUnknown(current, market);
    if (session !== current) return;
    const hold = holdOf(current, market);
    market.hold = hold;
    if (hold) {
      if (current.live) {
        const all = CANCEL_ALL.has(hold);
        for (const order of [...market.orders.values()]) if (all || order.role === 'quote') await cancelOrder(current, market, order, hold);
      }
      restingView(market, hold);
      return;
    }
    // Withdrawals of both sides go out before either side's new order.
    if (current.live) for (const side of SIDES) {
      const action = decide(current, market, side);
      if (action.type !== 'cancel') continue;
      await cancelOrder(current, market, action.order, action.reason);
      if (session !== current || holdOf(current, market)) return;
    }
    for (const side of SIDES) {
      let action = decide(current, market, side);
      if (action.type === 'cancel' && current.live) {
        await cancelOrder(current, market, action.order, action.reason);
        if (session !== current || holdOf(current, market)) return;
        action = decide(current, market, side);
      }
      if (action.type === 'place' && current.live) {
        await placeOrder(current, market, side, action.role, action.price, action.size, action.mode);
        if (session !== current || holdOf(current, market)) return;
        action = decide(current, market, side);
        if (action.type !== 'keep') action = { type: 'none', view: action.view };
      }
      market.view[side] = action.view;
    }
  }
  async function step(current, market) {
    if (market.busy) return;
    market.busy = true;
    try { await run(current, market); }
    catch (error) { market.error = failure(error); log.warn({ err: error, type: 'ondo-mm', market: market.name }, 'Ondo 挂单循环出错'); }
    finally { market.busy = false; }
  }

  // --- session -------------------------------------------------------------
  function finish(current) {
    if (session !== current) return;
    cooldownUntil = Math.max(cooldownUntil, current.client.cooldownUntil());
    current.stream.close(); current.client.close();
    session = null;
    if (current.live) { try { rmSync(sessionPath, { force: true }); } catch (error) { log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 会话记录未能删除'); } }
    leftPositions = current.live ? [...current.markets.values()].filter(market => market.position !== 0n).map(market => ({ market: market.name, position: fmt(market.position) })) : [];
    event(null, 'session', !current.live ? '观察已停止' : leftPositions.length
      ? `实盘挂单已停止，挂单已确认撤销；仍有持仓未平：${leftPositions.map(item => `${item.market} ${item.position}`).join('、')}`
      : '实盘挂单已停止，全部挂单已确认撤销，没有持仓');
  }
  // A live session ends only when nothing of it is in flight or tracked and an
  // account read begun after its last write lists no order with its prefix.
  function settled(current) {
    return [...current.markets.values()].every(market => market.orders.size === 0 && !market.busy)
      && !current.syncing && current.remoteOurs === 0 && current.verifiedAt > current.lastWriteAt;
  }
  async function tick() {
    const current = session;
    if (!current || closed) return;
    const at = now(), work = [];
    if (!current.rulesAttemptAt || at - current.rulesAttemptAt >= RULES_REFRESH_MS) work.push(refreshRules(current));
    if (current.live) {
      if (current.stopping) markAllDirty(current);
      const dirty = [...current.markets.values()].some(market => market.dirty);
      if (at - current.syncAttemptAt >= SYNC_GAP_MS && (dirty || at - current.syncOkAt >= SYNC_MS) && at >= current.client.cooldownUntil()) work.push(sync(current));
    }
    for (const market of current.markets.values()) work.push(step(current, market));
    await Promise.all(work);
    if (session === current && current.stopping && settled(current)) finish(current);
  }
  function open(live, keys) {
    const tag = randomBytes(4).toString('hex');
    const current = { live, config: structuredClone(config), prefix: `${PREFIX}${tag}-`, seq: 0, startedAt: now(), stopping: false, halt: null,
      cfg: { target: units(config.targetBps), min: units(config.minBps), max: units(config.maxBps), wallEnabled: config.wallEnabled, wallMin: units(config.wallUsd),
        orderUsd: units(config.orderUsd), maxPosition: units(config.maxPositionUsd), maxTotal: units(config.maxTotalUsd) },
      markets: new Map(config.markets.map(name => [name, { name, rules: null, listed: false, book: null, bookAt: 0, mid: null, orders: new Map(), foreign: [], position: 0n, positionKnown: !live,
        dirty: live, dirtySeq: 0, pending: { buy: null, sell: null }, backoff: { buy: 0, sell: 0 }, rejects: { buy: 0, sell: 0 },
        view: { buy: { role: 'quote', state: 'none', reason: 'starting' }, sell: { role: 'quote', state: 'none', reason: 'starting' } }, hold: 'starting', busy: false, error: null, lastCancel: null }])),
      syncing: false, syncAttemptAt: 0, syncOkAt: now(), syncError: null, remoteOurs: null, verifiedAt: 0, lastWriteAt: now(),
      loadingRules: false, rulesAttemptAt: 0, rulesAt: 0, rulesError: null, totals: { placed: 0, canceled: 0, rejected: 0, postOnly: 0, fills: 0 }, client: null, stream: null };
    current.client = clientFactory(clientOptions({ credentials: keys, rps: config.rps }));
    current.stream = streamFactory({ markets: config.markets, credentials: keys, ...(WebSocketImpl ? { WebSocketImpl } : {}), now,
      onBook(name, book, at) {
        const market = current.markets.get(name);
        if (!market) return;
        market.book = book; market.bookAt = at;
        if (book?.bids.length && book.asks.length) market.mid = (book.bids[0][0] + book.asks[0][0]) / 2n;
      },
      onDown() { for (const market of current.markets.values()) market.book = null; if (current.live) markAllDirty(current); },
      onPrivate(channel, data) { if (session === current) hint(current, channel, data); } });
    return current;
  }
  async function halt(waitMs) {
    const current = session;
    if (!current) return;
    if (!current.live) { finish(current); return; }
    if (!current.stopping) { current.stopping = true; event(null, 'session', '正在停止：撤销全部挂单并核对'); }
    const begun = now();
    for (let round = 0; round < STOP_ROUNDS && session === current && !closed && now() - begun < waitMs; round++) {
      await tick();
      if (session !== current) return;
      await sleep(STOP_PAUSE_MS);
    }
  }
  // Withdraws what a previous process left resting. Cancels only orders with this module's prefix.
  async function cleanup(attempts) {
    if (cleaning) return cleaning;
    let keys;
    try { keys = credentials(); } catch { if (recovery) recovery = { ...recovery, error: 'no_credentials' }; return undefined; }
    const task = (async () => {
      let client = null;
      try {
        client = clientFactory(clientOptions({ credentials: keys, rps: config.rps }));
        for (let attempt = 0; attempt < attempts && recovery && !session && !closed; attempt++) {
          if (attempt) await sleep(CLEANUP_PAUSE_MS);
          try {
            const left = (await client.openOrders()).filter(order => order.clientId?.startsWith(PREFIX));
            for (const order of left) { try { await client.cancel(order.id); } catch (error) { if (!GONE.has(failure(error))) throw error; } }
            if ((await client.openOrders()).some(order => order.clientId?.startsWith(PREFIX))) throw new OndoError('orders_remain');
            rmSync(sessionPath, { force: true }); recovery = null;
            event(null, 'session', left.length ? `已撤销上次实盘遗留的 ${left.length} 笔挂单` : '上次实盘没有遗留挂单');
          } catch (error) { recovery = { ...recovery, error: failure(error) }; }
        }
      } catch (error) { if (recovery) recovery = { ...recovery, error: failure(error) }; }
      finally { if (client) { cooldownUntil = Math.max(cooldownUntil, client.cooldownUntil()); client.close(); } if (cleaning === task) cleaning = null; }
    })();
    cleaning = task;
    return task;
  }

  function state() {
    const current = session, hold = gate();
    return { schema: 1, phase: !current ? 'stopped' : current.stopping ? 'stopping' : 'running', live: current?.live ?? false, startedAt: current ? new Date(current.startedAt).toISOString() : null,
      config: structuredClone(config), revision, activeConfig: current ? structuredClone(current.config) : null,
      credentials: { configured: !!keyHint, hint: keyHint, error: keyError },
      paused: hold !== null, pauseReason: hold ? gateText(hold) : null, halt: current?.halt ?? null, lastError,
      cooldownUntil: Math.max(cooldownUntil, current?.client.cooldownUntil() ?? 0) || null,
      stream: current ? current.stream.status() : null, syncError: current?.syncError ?? null, rulesError: current?.rulesError ?? null, totals: current ? { ...current.totals } : null,
      markets: current ? [...current.markets.values()].map(market => {
        const book = market.book, bid = book?.bids[0]?.[0], ask = book?.asks[0]?.[0];
        return { market: market.name, hold: market.hold, listed: market.listed, trading: market.rules?.trading ?? null, tick: market.rules ? fmt(market.rules.tick) : null,
          bid: bid === undefined ? null : fmt(bid), ask: ask === undefined ? null : fmt(ask), bookAt: market.bookAt || null,
          position: market.positionKnown ? fmt(market.position) : null, synced: !market.dirty, buy: market.view.buy, sell: market.view.sell, lastCancel: market.lastCancel, error: market.error };
      }) : [],
      leftPositions: current ? [] : leftPositions.map(item => ({ ...item })),
      recovery: recovery ? { startedAt: recovery.startedAt ?? null, error: recovery.error ?? null, cleaning: !!cleaning } : null,
      events: events.slice(0, EVENT_VIEW), loadError, serverNow: now() };
  }
  const checked = (validate, value) => { try { return validate(value); } catch (error) { throw new HttpError(400, error.message); } };

  return {
    state,
    tick,
    initialize() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { const saved = readBounded(configPath); if (saved) { config = validateOndoMmConfig(saved.config); revision = Number.isSafeInteger(saved.revision) ? saved.revision : 0; } }
      catch (error) { loadError = '已保存的挂单配置无法读取，已恢复默认值，保存后生效'; config = structuredClone(ONDO_MM_DEFAULTS); log.warn({ err: error, type: 'ondo-mm' }, loadError); }
      try { const saved = readBounded(credentialsPath); if (saved) keyHint = typeof saved.hint === 'string' ? saved.hint.slice(-4) : '****'; }
      catch { keyError = '已保存的 API Key 无法读取，请重新填写'; }
      // A session record that outlived its process means orders may still rest.
      try { const saved = readBounded(sessionPath); if (saved) recovery = { startedAt: typeof saved.startedAt === 'string' ? saved.startedAt : null, error: null }; }
      catch { recovery = { startedAt: null, error: null }; }
      if (recovery && keyHint) void cleanup(CLEANUP_ATTEMPTS);
      if (intervalMs > 0) { timer = setInterval(() => { void tick().catch(error => log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 挂单定时任务出错')); }, intervalMs); timer.unref?.(); }
    },
    save(value) {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '请先停止挂单再修改配置');
      const next = checked(validateOndoMmConfig, value);
      try { atomicJson(configPath, { revision: revision + 1, config: next }); }
      catch (error) { log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 挂单配置写入失败'); throw new HttpError(503, '配置无法保存，请恢复存储后重试'); }
      config = next; revision += 1; loadError = null;
      return state();
    },
    setKey(value) {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session?.live) throw new HttpError(409, '请先停止实盘挂单再更换 API Key');
      // Leftover orders belong to the saved key: it is replaced only when it cannot be read at all.
      if (recovery && keyHint && !keyError) throw new HttpError(409, '上次实盘的遗留挂单尚未确认撤销，更换 API Key 前请先完成清理');
      if (cleaning) throw new HttpError(409, '正在清理上次实盘的遗留挂单，请稍后再试');
      const next = checked(validateCredentials, value);
      try { atomicJson(credentialsPath, { hint: next.keyId.slice(-4), value: encrypt(next) }); }
      catch (error) {
        try { rmSync(`${credentialsPath}.tmp`, { force: true }); } catch { /* nothing was written */ }
        log.warn({ type: 'ondo-mm', code: error?.code }, 'Ondo API Key 写入失败');
        throw new HttpError(503, 'API Key 无法保存，请恢复存储后重试');
      }
      keyHint = next.keyId.slice(-4); keyError = null;
      return state();
    },
    clearKey() {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session?.live) throw new HttpError(409, '请先停止实盘挂单再清除 API Key');
      if (recovery) throw new HttpError(409, '上次实盘的遗留挂单尚未确认撤销，清除 API Key 前请先完成清理');
      rmSync(credentialsPath, { force: true }); keyHint = null; keyError = null;
      return state();
    },
    async start(input = {}, { signal } = {}) {
      if (closed) throw new HttpError(503, '服务正在关闭');
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '挂单已在运行');
      if (input.revision !== revision) throw new HttpError(409, '配置已变化，请刷新后重新确认');
      if (config.mode !== 'live') {
        session = open(false, null); lastError = null; leftPositions = [];
        event(null, 'session', '开始观察：只计算挂单位置，不下单');
        session.stream.start(); await tick();
        return state();
      }
      if (input.confirmLive !== true) throw new HttpError(400, '实盘挂单需要明确确认');
      if (input.adoptPositions !== undefined && typeof input.adoptPositions !== 'boolean') throw new HttpError(400, '已有持仓的确认无效');
      if (cleaning) throw new HttpError(409, '正在清理上次实盘的遗留挂单，请稍后再试');
      if (recovery) throw new HttpError(409, '上次实盘的遗留挂单尚未确认撤销，请先完成清理');
      const keys = credentials();
      // Held until the start is decided: the positions are read before the session exists.
      const attempt = starting = { cancelled: false };
      return Promise.resolve().then(() => admit(async () => {
        const hold = gate();
        if (hold) throw new HttpError(409, gateText(hold));
        if (session) throw new HttpError(409, '挂单已在运行');
        if (recovery || cleaning) throw new HttpError(409, '上次实盘的遗留挂单尚未确认撤销，请先完成清理');
        const current = open(true, keys);
        // A position in a configured market would be closed as if this module had opened it.
        let held;
        try {
          const positions = await current.client.positions();
          held = current.config.markets.filter(name => units(positions.get(name) ?? '0') !== 0n).map(name => `${name} ${positions.get(name)}`);
        } catch (error) {
          cooldownUntil = Math.max(cooldownUntil, current.client.cooldownUntil());
          current.stream.close(); current.client.close();
          if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 持仓读取失败');
          throw new HttpError(503, `无法读取 Ondo 持仓（${failure(error)}），未开始挂单`);
        }
        const refuse = (status, message) => { current.stream.close(); current.client.close(); throw new HttpError(status, message); };
        if (held.length && input.adoptPositions !== true) refuse(409, `账户在这些市场已有持仓：${held.join('、')}。启动后本模块会挂只减仓单把它们平掉；确认交给本模块处理请勾选「已有持仓交给本模块平掉」后再启动`);
        const later = gate();
        if (later) refuse(409, gateText(later));
        if (attempt.cancelled) refuse(409, '启动已被停止请求取消，未开始挂单');
        if (signal?.aborted) refuse(503, '请求已取消，未开始挂单');
        if (session || recovery || cleaning || closed) refuse(409, '挂单状态已变化，请刷新后重试');
        // The record is on disk before the first order, so a crash cannot leave unknown orders behind.
        try { atomicJson(sessionPath, { startedAt: new Date(current.startedAt).toISOString(), prefix: current.prefix }); }
        catch (error) { current.stream.close(); current.client.close(); log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 会话记录写入失败'); throw new HttpError(503, '会话记录无法保存，未开始挂单'); }
        session = current; lastError = null; leftPositions = [];
        event(null, 'session', `开始实盘挂单：${current.config.markets.join('、')}`);
        if (held.length) event(null, 'position', `按确认接管已有持仓：${held.join('、')}`);
        starting = null;
        current.stream.start(); await tick();
        return state();
      })).finally(() => { if (starting === attempt) starting = null; });
    },
    async stop() { if (starting) starting.cancelled = true; await halt(STOP_WAIT_MS); return state(); },
    async cleanup() {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '挂单运行中，无需清理');
      if (!recovery) return state();
      await cleanup(1);
      return state();
    },
    // The user has checked the venue by hand (the saved key may no longer work): forget the old session.
    discardRecovery() {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '挂单运行中，无需处理');
      if (cleaning) throw new HttpError(409, '正在清理上次实盘的遗留挂单，请稍后再试');
      if (recovery) {
        rmSync(sessionPath, { force: true }); recovery = null;
        event(null, 'session', '已按人工核对结果忽略上次实盘的遗留记录');
      }
      return state();
    },
    // Before an update stops the process: every order must be withdrawn and seen gone.
    async prepareStop() {
      if (starting) starting.cancelled = true;
      if (session?.live) await halt(PREPARE_WAIT_MS);
      else if (session) finish(session);
      if (session) throw new HttpError(409, 'Ondo 挂单尚未确认全部撤销，暂不能停机，请稍后重试');
      if (cleaning) await cleaning;
      if (recovery) throw new HttpError(409, 'Ondo 上次实盘的遗留挂单尚未确认撤销，暂不能停机，请先完成清理');
    },
    async close() {
      if (session?.live) await halt(CLOSE_WAIT_MS).catch(() => {});
      closed = true; clearInterval(timer);
      if (session) { session.stream.close(); session.client.close(); }
    },
  };
}
