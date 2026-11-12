// Stage 2.6a: contract probe of Bybit's native chase strategy against the real account
// (inventory item 25, second batch). It records what the executor's chase leg only assumes:
// the create receipt, the fields of a strategy and of its child orders, how soon a new strategy
// can be queried, the venue clock, what stop returns and how long children take to settle,
// which timestamp the ended-strategy window filters by, and how refusals are coded.
//
// Without `--live` every request is a read. With `--live --confirm <phrase>` it creates chase
// strategies of the smallest quantity whose limit sits `--passive-bps` below the best bid, so
// they are not expected to fill, and stops them. `--allow-fill` adds one strategy that is meant
// to fill. On the way out it stops every strategy it created and closes, with a reduce-only
// market order, exactly the quantity those strategies report as executed; it never resends a
// create whose outcome is unknown, and never touches a strategy it cannot tie to its own requests.
// Endpoints, parameters and signing follow server/trading-execution-exchanges.mjs, except the
// offset from the best bid: the first create tries its spellings in turn until one is accepted.
import { randomUUID } from 'node:crypto';
import { HttpFailure, NotSent, ProbeAbort, boundedInteger, createReport, environment, exchange, ignoreInterrupt, liveAllowed, positiveDecimal, readFlags, registerSecrets, reserveReport, safeText, saveReport, sleep, step, watchSignals } from './lib/common.ts';
import type { HttpResult, Report } from './lib/common.ts';
import { bybitHeaders } from './lib/bybit-sign.ts';
import { readWorkbenchAccounts } from './lib/workbench-accounts.ts';
import type { BybitCredentials as Credentials } from './lib/bybit-sign.ts';
import { add, cmp, floorToStep, fromUnits, isZero, mul, sub, units } from './lib/decimal.ts';

const BASE = 'https://api.bybit.com';
const SYMBOLS = ['CLUSDT', 'BZUSDT', 'SKHYUSDT', 'SKHYNIXUSDT'];
const RECV_WINDOW = '5000';
const TIMEOUT_MS = 12_000;
const MAX_NOTIONAL_CAP = '200';
/** Codes the old client treats as proof that a write did not execute; anything else stays uncertain there. */
const OLD_REJECTIONS = new Set([10001, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010, 10017, 10024, 10027, 10028, 100029,
  110003, 110004, 110007, 110009, 110012, 110016, 110017, 110020, 110021, 110022, 110032, 110094, 60063, 60064, 60066, 60067, 60069, 60070, 60075, 60077, 60078, 60079, 60081]);

type Row = Record<string, unknown>;
interface Reply { http: HttpResult; retCode: number | null; retMsg: unknown; result: Row | null }

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const amount = (value: unknown): string | null => { const raw = text(value); return raw !== null && /^\d+(\.\d{1,18})?$/.test(raw) ? raw : null; };

function loadCredentials(dataDir: string | undefined, env: Record<string, string>): Credentials {
  if (dataDir === undefined) {
    const apiKey = env.BYBIT_API_KEY ?? '', apiSecret = env.BYBIT_API_SECRET ?? '';
    if (!apiKey || !apiSecret) throw new ProbeAbort('缺少 BYBIT_API_KEY / BYBIT_API_SECRET（或用 --data-dir 读取工作台已保存的执行账户）');
    return { apiKey, apiSecret };
  }
  const [account] = readWorkbenchAccounts(dataDir, ['bybit']);
  return { apiKey: account.apiKey, apiSecret: account.apiSecret };
}

/** Venue clock minus local clock, from /v5/market/time. */
let clockOffsetMs = 0;

async function call(credentials: Credentials | null, method: 'GET' | 'POST', path: string, parameters: Record<string, string | number | boolean>, timestampShiftMs = 0): Promise<Reply> {
  const query = method === 'GET' ? new URLSearchParams(Object.entries(parameters).map(([key, value]): [string, string] => [key, String(value)])).toString() : '';
  const body = method === 'POST' ? JSON.stringify(parameters) : undefined;
  const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' };
  if (credentials) Object.assign(headers, bybitHeaders(credentials, String(Date.now() + clockOffsetMs + timestampShiftMs), RECV_WINDOW, body ?? query));
  const http = await exchange(BASE + path + (query ? '?' + query : ''), { method, headers, ...(body === undefined ? {} : { body }) }, TIMEOUT_MS);
  if ([403, 429].includes(http.status)) throw new ProbeAbort(`Bybit 返回 HTTP ${http.status}（限流或网关拦截），已停止后续请求`);
  const data = isRow(http.body) ? http.body : null;
  return { http, retCode: data && typeof data.retCode === 'number' ? data.retCode : null, retMsg: data?.retMsg ?? http.body, result: data && isRow(data.result) ? data.result : null };
}

function ok(reply: Reply, what: string): Row {
  if (reply.http.status !== 200 || reply.retCode !== 0 || !reply.result) throw new ProbeAbort(`${what} 读取失败：HTTP ${reply.http.status}，retCode ${reply.retCode}，${JSON.stringify(reply.retMsg).slice(0, 160)}`);
  return reply.result;
}

interface Listing { retCode: number | null; retMsg: unknown; rows: Row[]; pages: number; resultKeys: string[]; complete: boolean }

/** Reads every page of a list endpoint; reports the venue's code instead of throwing so "not found" can be observed. */
async function pages(credentials: Credentials, path: string, parameters: Record<string, string>, cursorField: string): Promise<Listing> {
  const rows: Row[] = [], keys = new Set<string>();
  let cursor = '';
  for (let page = 1; page <= 10; page++) {
    const reply = await call(credentials, 'GET', path, { ...parameters, ...(cursor ? { cursor } : {}) });
    if (reply.http.status !== 200 || reply.retCode !== 0 || !reply.result) return { retCode: reply.retCode === 0 ? null : reply.retCode, retMsg: reply.retMsg, rows, pages: page, resultKeys: [...keys], complete: false };
    for (const key of Object.keys(reply.result)) keys.add(key);
    const list = Array.isArray(reply.result.list) ? reply.result.list.filter(isRow) : [];
    rows.push(...list);
    const next = reply.result[cursorField];
    if (typeof next !== 'string' || !next) return { retCode: 0, retMsg: reply.retMsg, rows, pages: page, resultKeys: [...keys], complete: typeof next === 'string' };
    if (!list.length) break;
    cursor = next;
  }
  return { retCode: 0, retMsg: null, rows, pages: 10, resultKeys: [...keys], complete: false };
}

const strategyQuery = (symbol: string): Record<string, string> => ({ category: 'UTA_USDT', symbol, strategyType: 'chaseOrder', pageSize: '50' });
const listStrategies = (credentials: Credentials, symbol: string, extra: Record<string, string>): Promise<Listing> => pages(credentials, '/v5/strategy/list', { ...strategyQuery(symbol), ...extra }, 'nextCursor');
const childOrders = (credentials: Credentials, symbol: string, strategyId: string): Promise<Listing> => pages(credentials, '/v5/strategy/order-list', { strategyId, symbol, strategyType: 'chaseOrder', pageSize: '50' }, 'nextCursor');
const openOrders = (credentials: Credentials, symbol: string): Promise<Listing> => pages(credentials, '/v5/order/realtime', { category: 'linear', symbol }, 'nextPageCursor');

async function positions(credentials: Credentials, symbol: string): Promise<Row[]> {
  // One symbol has at most three position rows, so one page is complete and its cursor is not
  // followed: a page returned twice would count the same position twice.
  const reply = await call(credentials, 'GET', '/v5/position/list', { category: 'linear', symbol, limit: '200' });
  if (reply.http.status !== 200 || reply.retCode !== 0 || !reply.result || !Array.isArray(reply.result.list)) throw new ProbeAbort(`持仓读取失败：HTTP ${reply.http.status} retCode ${reply.retCode}`);
  return reply.result.list.filter(isRow);
}
const positionSize = (rows: Row[]): string => add('0', ...rows.map(row => amount(row.size) ?? '0'));

/** `unlisted`: the venue answered with a code the old client does not count as proof of non-execution. */
interface WriteResult { outcome: 'accepted' | 'rejected' | 'unlisted' | 'unknown'; preparedAt: number; sentAt: number; receivedAt: number | null; status: number | null; retCode: number | null; retMsg: unknown; inOldRejectionList: boolean | null; result: Row | null; id: string | null }

async function write(report: Report, credentials: Credentials, name: string, path: string, parameters: Record<string, string | number | boolean>, idField: string, timestampShiftMs = 0): Promise<WriteResult> {
  const entry = { name, at: new Date().toISOString(), outcome: 'sending' };
  report.writes.push(entry);
  const preparedAt = Date.now();
  let reply: Reply;
  try { reply = await call(credentials, 'POST', path, parameters, timestampShiftMs); }
  catch (error) {
    entry.outcome = error instanceof NotSent ? 'not-sent' : 'unknown';
    if (!(error instanceof HttpFailure)) throw error;
    return { outcome: 'unknown', preparedAt, sentAt: preparedAt, receivedAt: null, status: null, retCode: null, retMsg: error.message, inOldRejectionList: null, result: null, id: null };
  }
  const id = reply.result ? text(reply.result[idField]) : null;
  const refused = reply.http.status < 500 && reply.retCode !== null && reply.retCode !== 0;
  const outcome = reply.http.status === 200 && reply.retCode === 0 && id !== null ? 'accepted' : !refused ? 'unknown' : OLD_REJECTIONS.has(reply.retCode!) || reply.retCode === 10002 ? 'rejected' : 'unlisted';
  entry.outcome = outcome;
  return { outcome, preparedAt, sentAt: reply.http.sentAt, receivedAt: reply.http.receivedAt, status: reply.http.status, retCode: reply.retCode, retMsg: reply.retMsg,
    inOldRejectionList: reply.retCode === null || reply.retCode === 0 ? null : OLD_REJECTIONS.has(reply.retCode), result: reply.result, id };
}

const TERMINAL = new Set(['3', '4']);
const CHILD_OPEN = new Set(['2', '4']);
interface Watch { reachedAfterMs: number | null; waitedMs: number; lastStrategy: Row | null; lastChildren: Row[]; transitions: { afterMs: number; strategyStatus: string | null; executedSize: string | null; children: string[] }[] }

/** Polls one strategy and its children every 500 ms until `done` holds, recording each change of state. */
async function watch(credentials: Credentials, symbol: string, strategyId: string, origin: number, limitMs: number, done: (strategy: Row | null, children: Row[]) => boolean): Promise<Watch> {
  const result: Watch = { reachedAfterMs: null, waitedMs: 0, lastStrategy: null, lastChildren: [], transitions: [] };
  let previous = '';
  for (;;) {
    const strategies = await listStrategies(credentials, symbol, { strategyId }), children = await childOrders(credentials, symbol, strategyId);
    const strategy = strategies.rows.length === 1 ? strategies.rows[0]! : null, afterMs = Date.now() - origin;
    const state = { strategyStatus: strategy ? text(strategy.status) : null, executedSize: strategy ? text(strategy.executedSize) : null,
      children: children.rows.map(child => `${text(child.orderId)}:${text(child.status)}:${text(child.executedSize)}/${text(child.size)}`) };
    if (JSON.stringify(state) !== previous) { previous = JSON.stringify(state); result.transitions.push({ afterMs, ...state }); }
    result.lastStrategy = strategy; result.lastChildren = children.rows; result.waitedMs = afterMs;
    if (done(strategy, children.rows)) { result.reachedAfterMs = afterMs; return result; }
    if (afterMs >= limitMs) return result;
    await sleep(500);
  }
}

const settled = (strategy: Row | null, children: Row[]): boolean => strategy !== null && TERMINAL.has(String(strategy.status))
  && children.every(child => !CHILD_OPEN.has(String(child.status)))
  && cmp(add('0', ...children.map(child => amount(child.executedSize) ?? '0')), amount(strategy.executedSize) ?? '0') === 0;

/** Smallest multiple of `step` not below value / price. */
function quantityFor(notional: string, price: string, step: string): string {
  const scale = units('1'), raw = fromUnits(units(notional) * scale / units(price)), floor = floorToStep(raw, step);
  return cmp(floor, raw) === 0 ? floor : add(floor, step);
}

async function main(): Promise<number> {
  const flags = readFlags(process.argv.slice(2), ['env-file', 'data-dir', 'symbol', 'max-notional', 'passive-bps', 'settle-timeout-s', 'out', 'confirm'], ['live', 'allow-fill', 'help']);
  if (flags.help) {
    process.stdout.write('用法：node server/contract-probes/bybit-chase.ts --symbol <CLUSDT|BZUSDT|SKHYUSDT|SKHYNIXUSDT> (--data-dir <工作台数据目录> | --env-file <文件>)\n'
      + '      [--max-notional 50] [--passive-bps 200] [--settle-timeout-s 60] [--live --confirm <短语>] [--allow-fill] [--out 报告.json]\n'
      + '不带 --live 只读取；确认短语由只读运行打印。凭据也可用环境变量 BYBIT_API_KEY / BYBIT_API_SECRET。\n');
    return 0;
  }
  const symbol = flags.symbol as string | undefined;
  if (symbol === undefined || !SYMBOLS.includes(symbol)) throw new ProbeAbort(`--symbol 必须是 ${SYMBOLS.join('、')} 之一`);
  const maxNotional = positiveDecimal((flags['max-notional'] as string | undefined) ?? '50', '--max-notional', 2);
  if (cmp(maxNotional, MAX_NOTIONAL_CAP) > 0) throw new ProbeAbort(`--max-notional 不能超过 ${MAX_NOTIONAL_CAP} USDT`);
  const passiveBps = boundedInteger(flags['passive-bps'] as string | undefined, '--passive-bps', 200, 50, 2000);
  const settleLimitMs = boundedInteger(flags['settle-timeout-s'] as string | undefined, '--settle-timeout-s', 60, 10, 300) * 1000;
  const allowFill = flags['allow-fill'] === true;
  if (flags['data-dir'] !== undefined && flags['env-file'] !== undefined) throw new ProbeAbort('--data-dir 与 --env-file 只能选一个');
  const credentials = loadCredentials(flags['data-dir'] as string | undefined, environment(flags['env-file'] as string | undefined));
  registerSecrets(credentials.apiKey, credentials.apiSecret);
  const report = createReport('bybit-chase', flags.live === true ? 'live' : 'read-only', { symbol, maxNotional, passiveBps, settleLimitMs, allowFill });
  const out = (flags.out as string | undefined) ?? `contract-bybit-chase-${report.startedAt.replace(/[:.]/g, '-')}.json`;
  reserveReport(out);
  watchSignals();
  const startedAt = Date.now();
  /** Every strategy this run created, with its quantity, and those not yet seen settled. */
  const created = new Map<string, string>(), unsettled = new Set<string>();
  /** Creates without a usable receipt: quantity and the local-clock span in which the request could have landed. */
  const unconfirmed: { size: string; from: number; until: number }[] = [];
  let lostReplies = 0, exitCode = 1, armed = false, positionIdx = 0;

  const sweep = async (): Promise<void> => {
    if (!armed) return;
    ignoreInterrupt();
    let readsComplete = true;
    const running = async (): Promise<Row[]> => {
      const rows: Row[] = [];
      for (const status of ['2', '5', '6']) {
        const listing = await listStrategies(credentials, symbol, { status });
        if (listing.retCode !== 0 || !listing.complete) readsComplete = false;
        rows.push(...listing.rows);
      }
      return rows;
    };
    // A create whose reply was lost or unclear left no id. Only then is a running strategy taken over, and only one
    // that matches such a request: a buy that opens, of the same quantity, created while that request could have landed.
    // A strategy can take a while to show in the list, so the scan repeats until 10 s after the last such request could have landed.
    const adopted: string[] = [];
    if (unconfirmed.length) for (const scanUntil = Math.max(...unconfirmed.map(request => request.until)) + 10_000; ;) {
      for (const row of await running()) {
        const id = text(row.strategyId), size = amount(row.size), createdLocal = Number(text(row.createdTimeE3)) - clockOffsetMs;
        if (id === null || size === null || created.has(id) || row.side !== 'Buy' || row.reduceOnly !== false) continue;
        if (unconfirmed.some(request => cmp(request.size, size) === 0 && createdLocal >= request.from - 5_000 && createdLocal <= request.until + 5_000)) { created.set(id, size); unsettled.add(id); adopted.push(id); }
      }
      if (Date.now() >= scanUntil) break;
      await sleep(1_000);
    }
    const stops = [];
    for (const id of [...unsettled]) {
      const current = await listStrategies(credentials, symbol, { strategyId: id });
      if (current.retCode !== 0) readsComplete = false;
      if (current.rows[0] && TERMINAL.has(String(current.rows[0].status))) continue;
      const stop = await write(report, credentials, `收尾停止 ${id}`, '/v5/strategy/stop', { strategyId: id }, 'strategyId');
      const after = await watch(credentials, symbol, id, Date.now(), Math.min(30_000, settleLimitMs), settled);
      stops.push({ id, stop: stop.outcome, retCode: stop.retCode, settledAfterMs: after.reachedAfterMs });
    }
    // Only what this run's own strategies report as executed is closed, never more than the position holds.
    let ownExecuted: string | null = '0';
    for (const id of created.keys()) {
      const current = await listStrategies(credentials, symbol, { strategyId: id }), executed = current.rows.length === 1 ? amount(current.rows[0]!.executedSize) : null;
      if (current.retCode !== 0 || executed === null) { ownExecuted = null; readsComplete = false; break; }
      ownExecuted = add(ownExecuted, executed);
    }
    let size = positionSize(await positions(credentials, symbol)), flatten: unknown = null;
    if (!isZero(size) && ownExecuted !== null && !isZero(ownExecuted)) {
      const quantity = cmp(size, ownExecuted) < 0 ? size : ownExecuted, target = sub(size, quantity);
      const order = await write(report, credentials, '平掉本次追价成交的数量（只减仓市价）', '/v5/order/create',
        { category: 'linear', symbol, side: 'Sell', orderType: 'Market', qty: quantity, positionIdx, reduceOnly: true, orderLinkId: 'pc26a' + Date.now() }, 'orderId');
      for (let waited = 0; waited < 15_000 && cmp(size, target) > 0; waited += 500) { await sleep(500); size = positionSize(await positions(credentials, symbol)); }
      flatten = { quantity, outcome: order.outcome, retCode: order.retCode, retMsg: order.retMsg };
    }
    const orders = await openOrders(credentials, symbol), stillRunning = (await running()).map(row => text(row.strategyId));
    const clean = readsComplete && isZero(size) && orders.retCode === 0 && orders.complete && orders.rows.length === 0 && stillRunning.length === 0;
    step(report, '收尾核对', { adopted, stops, ownExecuted, flatten, positionSize: size, openOrders: orders.rows.length, runningStrategies: stillRunning, readsComplete, clean });
    report.findings.cleanup = { clean, readsComplete, positionSize: size, openOrders: orders.rows.length, runningStrategies: stillRunning.length };
    if (!clean) { exitCode = 2; report.outcome += `；收尾后未能确认无残留（持仓 ${size}、挂单 ${orders.rows.length}、运行中策略 ${stillRunning.length}${readsComplete ? '' : '、有读取失败'}），请在交易所处理`; }
    else if (lostReplies) { exitCode = 2; report.outcome += `；有 ${lostReplies} 笔创建的结果未知（应答丢失、被网关拦截或返回清单外错误码），收尾时未见残留，请在交易所再确认一次`; }
  };
  try {
    const timeReply = await call(null, 'GET', '/v5/market/time', {});
    const nano = text(ok(timeReply, '服务器时间').timeNano);
    if (nano === null || !/^\d{16,25}$/.test(nano)) throw new ProbeAbort('服务器时间应答无效');
    clockOffsetMs = Math.round(Number(BigInt(nano) / 1_000_000n) - (timeReply.http.sentAt + timeReply.http.receivedAt) / 2);
    step(report, '服务器时间', { exchangeMinusLocalMs: clockOffsetMs, roundTripMs: timeReply.http.receivedAt - timeReply.http.sentAt });
    report.findings.clock = { exchangeMinusLocalMs: clockOffsetMs, roundTripMs: timeReply.http.receivedAt - timeReply.http.sentAt, adoptSkewMsAssumed: 5000 };

    const key = ok(await call(credentials, 'GET', '/v5/user/query-api', {}), '密钥权限'), account = ok(await call(credentials, 'GET', '/v5/account/info', {}), '账户信息');
    step(report, '密钥与账户', { readOnly: key.readOnly, permissions: key.permissions, unifiedMarginStatus: account.unifiedMarginStatus, keyFields: Object.keys(key), accountFields: Object.keys(account) });
    if (key.readOnly !== 0) step(report, '提示', '密钥为只读：只读检查可以继续，--live 会被交易所拒绝');

    const rules = ok(await call(null, 'GET', '/v5/market/instruments-info', { category: 'linear', symbol }), '交易规则');
    const rule = Array.isArray(rules.list) && rules.list.length === 1 && isRow(rules.list[0]) ? rules.list[0] : null;
    const lot = rule && isRow(rule.lotSizeFilter) ? rule.lotSizeFilter : null, priceFilter = rule && isRow(rule.priceFilter) ? rule.priceFilter : null;
    const minQuantity = amount(lot?.minOrderQty), quantityStep = amount(lot?.qtyStep), tick = amount(priceFilter?.tickSize), minNotional = amount(lot?.minNotionalValue) ?? '0';
    if (!rule || rule.status !== 'Trading' || minQuantity === null || quantityStep === null || tick === null) throw new ProbeAbort(`${symbol} 的交易规则无效或当前不可交易`);
    const book = ok(await call(null, 'GET', '/v5/market/orderbook', { category: 'linear', symbol, limit: 1 }), '盘口');
    const bid = Array.isArray(book.b) && Array.isArray(book.b[0]) ? amount(book.b[0][0]) : null, ask = Array.isArray(book.a) && Array.isArray(book.a[0]) ? amount(book.a[0][0]) : null;
    if (bid === null || ask === null) throw new ProbeAbort('盘口为空');
    const passivePrice = floorToStep(mul(bid, fromUnits(units('1') * BigInt(10_000 - passiveBps) / 10_000n)), tick);
    if (isZero(passivePrice)) throw new ProbeAbort('被动价格取整后为零');
    // Sized at the resting price, plus one step, so the passive order itself clears the minimum notional.
    const byNotional = isZero(minNotional) ? minQuantity : add(quantityFor(minNotional, passivePrice, quantityStep), quantityStep);
    const quantity = cmp(byNotional, minQuantity) > 0 ? byNotional : minQuantity, notional = mul(quantity, ask);
    const fillPrice = add(floorToStep(mul(ask, '1.005'), tick), tick);
    step(report, '规则与盘口', { minOrderQty: minQuantity, qtyStep: quantityStep, tickSize: tick, minNotionalValue: minNotional, bid, ask, quantity, notional, passivePrice, fillPrice });
    // Two resting strategies exist at once (A and its duplicate), so the cap covers twice the quantity.
    if (cmp(mul(notional, '2'), maxNotional) > 0) throw new ProbeAbort(`最小可下数量 ${quantity} 的名义金额约 ${notional} USDT，同时最多两笔，超过 --max-notional ${maxNotional}`);

    const held = await positions(credentials, symbol), hedge = held.some(row => row.positionIdx === 1 || row.positionIdx === 2);
    positionIdx = hedge ? 1 : 0;
    const orders = await openOrders(credentials, symbol), buckets: Record<string, Listing> = {};
    for (const status of ['2', '4', '5', '6']) buckets[status] = await listStrategies(credentials, symbol, { status });
    const ended = await listStrategies(credentials, symbol, { status: '3', beginTimeE0: String(Math.floor((startedAt - 3_600_000) / 1000)), endTimeE0: String(Math.ceil(startedAt / 1000)) });
    const unknownId = randomUUID(), missing = await listStrategies(credentials, symbol, { strategyId: unknownId });
    step(report, '账户现状', { positionMode: hedge ? 'hedge' : 'one-way', positions: held.map(row => ({ positionIdx: row.positionIdx, side: row.side, size: row.size })), openOrders: orders.rows.length,
      strategiesByStatus: Object.fromEntries(Object.entries(buckets).map(([status, listing]) => [status, { retCode: listing.retCode, rows: listing.rows.length, pages: listing.pages, resultKeys: listing.resultKeys }])),
      endedLastHour: { retCode: ended.retCode, rows: ended.rows.length, sample: ended.rows[0] ?? null }, strategyRowSample: Object.values(buckets).flatMap(listing => listing.rows)[0] ?? null });
    report.findings.unknownStrategyQuery = { retCode: missing.retCode, retMsg: missing.retMsg, rows: missing.rows.length };
    step(report, '按不存在的编号查询', report.findings.unknownStrategyQuery);

    const phrase = `bybit-chase-${symbol}-${quantity}-bps${passiveBps}${allowFill ? '-fill' : ''}`;
    const live = liveAllowed(flags, phrase);
    if (!live) {
      report.outcome = 'read-only-complete';
      process.stdout.write(`\n只读检查完成，未发送任何委托。真实追价需加：--live --confirm ${phrase}${allowFill ? '' : '（加 --allow-fill 会另发一笔预期成交的追价并随后平仓，确认短语随之变化）'}\n`);
      exitCode = 0;
      return exitCode;
    }
    const busy = !isZero(positionSize(held)) || orders.retCode !== 0 || !orders.complete || orders.rows.length > 0 || ['2', '5', '6'].some(status => buckets[status]!.retCode !== 0 || buckets[status]!.rows.length > 0);
    if (busy) throw new ProbeAbort(`${symbol} 上已有持仓、挂单或运行中的追价策略（或读取失败）：为避免与现有任务混淆，不发送任何委托`);
    armed = true;

    const base = { category: 'UTA_USDT', symbol, side: 'Buy', strategyType: 'chaseOrder', positionIdx, reduceOnly: false };
    // How "no offset from the best bid" is written. On 2026-11-12 the venue accepted chasePercentE4 0 (what the
    // workbench sends) and refused chaseDistance "0" (10001, chase_distance params error); the first accepted spelling is kept.
    const OFFSETS: [string, Record<string, string | number>][] = [['chasePercentE4 0', { chasePercentE4: 0 }], ['不带偏移参数', {}], ['chaseDistance "0"', { chaseDistance: '0' }]];
    let offset: Record<string, string | number> = OFFSETS[0]![1];
    const create = async (name: string, size: string, maxChasePrice: string, timestampShiftMs = 0): Promise<WriteResult> => {
      const preparedAt = Date.now();
      let result: WriteResult;
      try { result = await write(report, credentials, name, '/v5/strategy/create', { ...base, ...offset, size, maxChasePrice }, 'strategyId', timestampShiftMs); }
      // A gateway block (403/429) on the create says nothing about whether it ran.
      catch (error) { if (!(error instanceof NotSent)) { unconfirmed.push({ size, from: preparedAt, until: Date.now() }); lostReplies++; } throw error; }
      if (result.id !== null) { created.set(result.id, size); unsettled.add(result.id); }
      else if (result.outcome === 'unknown' || result.outcome === 'unlisted') {
        unconfirmed.push({ size, from: result.preparedAt, until: result.receivedAt ?? result.preparedAt + TIMEOUT_MS });
        lostReplies++;
      }
      return result;
    };
    const stopAndSettle = async (name: string, id: string): Promise<{ stop: WriteResult; after: Watch }> => {
      const stop = await write(report, credentials, name, '/v5/strategy/stop', { strategyId: id }, 'strategyId');
      const after = await watch(credentials, symbol, id, stop.receivedAt ?? stop.sentAt, settleLimitMs, settled);
      // Later steps create more strategies; one that may still be running would add to the exposure the cap was checked for.
      if (after.reachedAfterMs === null) throw new ProbeAbort(`${name}：${settleLimitMs / 1000} 秒内未确认策略已结束且子单结清（停止结果 ${stop.outcome}），不再继续`);
      unsettled.delete(id);
      return { stop, after };
    };

    // A: a strategy that should rest below the book.
    // A parameter refusal (10001) is a definite "not created", so the next spelling may be tried; any other answer ends the run.
    let first!: WriteResult;
    const spellings: Row[] = [];
    for (const [label, parameters] of OFFSETS) {
      offset = parameters;
      first = await create(`创建追价 A（低于买一，不预期成交；${label}）`, quantity, passivePrice);
      spellings.push({ spelling: label, outcome: first.outcome, retCode: first.retCode, retMsg: first.retMsg });
      if (first.outcome !== 'rejected' || first.retCode !== 10001 || !/chase/i.test(String(first.retMsg))) break;
    }
    report.findings.offsetSpelling = { tried: spellings, accepted: first.outcome === 'accepted' ? spellings.at(-1)!.spelling : null };
    step(report, '创建 A：回执', { ...first, offsetSpelling: report.findings.offsetSpelling });
    if (first.outcome !== 'accepted' || first.id === null) throw new ProbeAbort(`创建 A 未被接受（${first.outcome}，retCode ${first.retCode}）`);
    const firstId = first.id, ackAt = first.receivedAt ?? first.sentAt;
    let visible: Listing | null = null, emptyPolls = 0, lastEmptyAfterMs: number | null = null;
    const emptyCodes = new Set<number | null>();
    while (Date.now() - ackAt < 10_000) {
      const listing = await listStrategies(credentials, symbol, { strategyId: firstId });
      if (listing.rows.length === 1) { visible = listing; break; }
      emptyPolls++; emptyCodes.add(listing.retCode); lastEmptyAfterMs = Date.now() - ackAt;
      await sleep(300);
    }
    const visibleAfterMs = visible ? Date.now() - ackAt : null, row = visible?.rows[0] ?? null;
    const createdE3 = row ? Number(text(row.createdTimeE3)) : NaN;
    report.findings.create = {
      receiptKeys: first.result ? Object.keys(first.result) : [], strategyIdIsUuid: /^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(firstId), receiptHasNullResult: first.result ? first.result.result === null : null,
      queryableAfterAckMs: visibleAfterMs, lastEmptyPollAfterAckMs: lastEmptyAfterMs, emptyPollsBeforeVisible: emptyPolls, codesWhileNotVisible: [...emptyCodes],
      strategyRowKeys: row ? Object.keys(row) : [], hasPositionIdx: row ? 'positionIdx' in row : null, hasMaxChasePrice: row ? 'maxChasePrice' in row : null,
      maxChasePrice: row?.maxChasePrice ?? null, chaseOrderPrice: row?.chaseOrderPrice ?? null, status: row?.status ?? null, executedAvgPriceWhenUnfilled: row?.executedAvgPrice ?? null,
      // Venue creation time against this host's send and receipt times moved onto the venue clock.
      createdMinusSendMs: Number.isFinite(createdE3) ? createdE3 - (first.sentAt + clockOffsetMs) : null, createdMinusAckMs: Number.isFinite(createdE3) ? createdE3 - (ackAt + clockOffsetMs) : null,
      // The executor compares the venue's creation time with this host's clock as it is: the same differences without the offset.
      createdMinusLocalPrepareMs: Number.isFinite(createdE3) ? createdE3 - first.preparedAt : null, createdMinusLocalAckMs: Number.isFinite(createdE3) ? createdE3 - ackAt : null,
    };
    step(report, '创建 A：按编号查询', { row, ...(report.findings.create as Row) });
    if (!row) throw new ProbeAbort('创建 A 后 10 秒内按编号查不到该策略');
    // A is meant to rest at its cap, below the book. If the venue rests it higher it can fill, which only --allow-fill agreed to.
    const capped = async (price: unknown, executed: unknown): Promise<void> => {
      const restingAt = amount(price);
      if (allowFill || isZero(amount(executed) ?? '0') && (restingAt === null || cmp(restingAt, passivePrice) <= 0)) return;
      step(report, '停止 A（未停在最高追价）', await stopAndSettle('停止 A（未停在最高追价）', firstId));
      throw new ProbeAbort(`A 没有停在最高追价 ${passivePrice}（挂单价 ${text(price)}，已成交 ${text(executed)}）：可能成交，已停止。如接受成交，请勾选成交测试后重新运行`);
    };
    await capped(row.chaseOrderPrice, row.executedSize);

    await sleep(2_000);
    const firstChildren = await childOrders(credentials, symbol, firstId), resting = await openOrders(credentials, symbol);
    report.findings.children = { childRowKeys: [...new Set(firstChildren.rows.flatMap(child => Object.keys(child)))], childCount: firstChildren.rows.length,
      // The workbench refuses a list whose reply lacks a string cursor, so the envelope is recorded for both lists.
      childListKeys: firstChildren.resultKeys, childListComplete: firstChildren.complete, openOrderListKeys: resting.resultKeys, openOrderListComplete: resting.complete,
      openOrders: resting.rows.map(order => ({ orderId: order.orderId, orderLinkId: order.orderLinkId, price: order.price, qty: order.qty, orderType: order.orderType, timeInForce: order.timeInForce, positionIdx: order.positionIdx, reduceOnly: order.reduceOnly, orderStatus: order.orderStatus, createType: order.createType })),
      childIdsAppearInOpenOrders: firstChildren.rows.length > 0 && firstChildren.rows.every(child => resting.rows.some(order => text(order.orderId) === text(child.orderId))) };
    step(report, '创建 A：子单与账户挂单', { children: firstChildren.rows, ...(report.findings.children as Row) });
    // The strategy row can lag its first child order; the order book side of it is checked as well.
    for (const order of resting.rows) await capped(order.price, order.cumExecQty ?? '0');

    const createdSecond = Math.floor(createdE3 / 1000), activeStatus = String(row.status);
    const window = async (status: string, name: string, begin: number, end: number): Promise<unknown> => {
      const listing = await listStrategies(credentials, symbol, { status, beginTimeE0: String(begin), endTimeE0: String(end) });
      return { window: name, retCode: listing.retCode, rows: listing.rows.length, includesA: listing.rows.some(item => text(item.strategyId) === firstId) };
    };
    const activeWindows = [await window(activeStatus, '创建时刻 ±10 秒', createdSecond - 10, createdSecond + 10), await window(activeStatus, '创建前 2 小时到前 1 小时', createdSecond - 7200, createdSecond - 3600),
      await window(activeStatus, '创建后 1 小时到后 2 小时', createdSecond + 3600, createdSecond + 7200)];
    const inBucket = await listStrategies(credentials, symbol, { status: activeStatus });
    report.findings.runningList = { status: activeStatus, includesA: inBucket.rows.some(item => text(item.strategyId) === firstId), resultKeys: inBucket.resultKeys, completeCursor: inBucket.complete, timeWindowOnRunning: activeWindows };
    step(report, '运行中策略的列表与时间窗', report.findings.runningList);

    // B: the same request again. The venue takes no client id, so nothing should deduplicate it.
    const second = await create('重复创建（与 A 参数相同）', quantity, passivePrice);
    report.findings.duplicateCreate = { outcome: second.outcome, retCode: second.retCode, retMsg: second.retMsg, distinctId: second.id !== null && second.id !== firstId };
    step(report, '重复创建', report.findings.duplicateCreate);

    // Stop at least 20 s after creation so the two instants fall in different whole-second windows.
    await sleep(Math.max(0, 20_000 - (Date.now() - ackAt)));
    const stopped = await stopAndSettle('停止 A', firstId), stopAt = stopped.stop.receivedAt ?? stopped.stop.sentAt;
    report.findings.stop = { outcome: stopped.stop.outcome, receiptKeys: stopped.stop.result ? Object.keys(stopped.stop.result) : [], receiptEchoesId: stopped.stop.id === firstId,
      settledAfterStopAckMs: stopped.after.reachedAfterMs, transitions: stopped.after.transitions, finalStatus: stopped.after.lastStrategy?.status ?? null,
      executedSize: stopped.after.lastStrategy?.executedSize ?? null, childStatuses: stopped.after.lastChildren.map(child => child.status) };
    step(report, '停止 A', { receipt: stopped.stop, ...(report.findings.stop as Row), lastStrategy: stopped.after.lastStrategy, lastChildren: stopped.after.lastChildren });
    if (second.id !== null) step(report, '停止重复创建的策略', await stopAndSettle('停止重复创建的策略', second.id));

    const endedStatus = String(stopped.after.lastStrategy?.status ?? '3'), stopSecond = Math.floor((stopAt + clockOffsetMs) / 1000);
    const updatedE3 = Number(text(stopped.after.lastStrategy?.updatedTimeE3)), updatedSecond = Number.isFinite(updatedE3) ? Math.floor(updatedE3 / 1000) : null;
    report.findings.endedWindow = { status: endedStatus, createdSecond, stopSecond, updatedSecond, windows: [
      ...(updatedSecond === null ? [] : [await window(endedStatus, '只含策略记录的更新时刻（±5 秒）', updatedSecond - 5, updatedSecond + 5)]), await window(endedStatus, '只含创建时刻（±5 秒）', createdSecond - 5, createdSecond + 5),
      await window(endedStatus, '只含停止时刻（±5 秒）', stopSecond - 5, stopSecond + 5), await window(endedStatus, '起止都等于创建所在的那一秒', createdSecond, createdSecond),
      await window(endedStatus, '创建到停止', createdSecond, stopSecond + 1)] };
    step(report, '已结束策略的时间窗按哪个时刻过滤', report.findings.endedWindow);

    const again = await write(report, credentials, '再次停止已结束的 A', '/v5/strategy/stop', { strategyId: firstId }, 'strategyId');
    const stray = await write(report, credentials, '停止不存在的编号', '/v5/strategy/stop', { strategyId: unknownId }, 'strategyId');
    report.findings.stopRefusals = { endedStrategy: { outcome: again.outcome, retCode: again.retCode, retMsg: again.retMsg, inOldRejectionList: again.inOldRejectionList },
      unknownStrategy: { outcome: stray.outcome, retCode: stray.retCode, retMsg: stray.retMsg, inOldRejectionList: stray.inOldRejectionList } };
    step(report, '停止的拒绝码', report.findings.stopRefusals);

    const refusals: Record<string, unknown> = {};
    if (cmp(minQuantity, quantityStep) > 0) {
      const small = await create('创建：数量低于最小下单量', sub(minQuantity, quantityStep), passivePrice);
      refusals.belowMinimum = { outcome: small.outcome, retCode: small.retCode, retMsg: small.retMsg, inOldRejectionList: small.inOldRejectionList };
      if (small.id !== null) await stopAndSettle('停止低于最小量却被接受的策略', small.id);
    } else refusals.belowMinimum = { skipped: '最小下单量等于数量步长' };
    // Signed 10 s in the past against a 5 s window: shows what the venue answers and that nothing is created.
    const stale = await create('创建：时间戳早 10 秒', quantity, passivePrice, -10_000);
    refusals.staleTimestamp = { outcome: stale.outcome, retCode: stale.retCode, retMsg: stale.retMsg, inOldRejectionList: stale.inOldRejectionList };
    if (stale.id !== null) await stopAndSettle('停止过期时间戳却被接受的策略', stale.id);
    report.findings.createRefusals = refusals;
    step(report, '创建的拒绝码', refusals);

    if (allowFill) {
      const taker = await create('创建追价 C（上限高于卖一，预期成交）', quantity, fillPrice);
      step(report, '创建 C：回执', taker);
      if (taker.id !== null) {
        const takerId = taker.id, origin = taker.receivedAt ?? taker.sentAt;
        let strategyFilledAfterMs: number | null = null;
        const filled = await watch(credentials, symbol, takerId, origin, settleLimitMs, (strategy, children) => {
          if (strategyFilledAfterMs === null && strategy && cmp(amount(strategy.executedSize) ?? '0', quantity) === 0) strategyFilledAfterMs = Date.now() - origin;
          return settled(strategy, children);
        });
        if (filled.reachedAfterMs === null) await stopAndSettle('停止未在限时内结清的 C', takerId); else unsettled.delete(takerId);
        const filledList = await childOrders(credentials, symbol, takerId);
        report.findings.fill = { childListKeys: filledList.resultKeys, childListComplete: filledList.complete, strategyFilledAfterAckMs: strategyFilledAfterMs, settledAfterAckMs: filled.reachedAfterMs, transitions: filled.transitions, finalStrategy: filled.lastStrategy, finalChildren: filled.lastChildren };
        step(report, '创建 C：成交与子单结清', report.findings.fill);
      }
    }
    report.outcome = 'complete';
    exitCode = 0;
    return exitCode;
  } catch (error) {
    report.outcome = safeText(error);
    exitCode = report.writes.some(entry => entry.outcome !== 'not-sent') ? 2 : 1;
    throw error;
  } finally {
    try { await sweep(); }
    catch (error) { exitCode = 2; report.outcome += '；收尾失败：' + safeText(error) + '。请在交易所确认没有残留的追价策略、挂单与持仓'; }
    process.exitCode = exitCode;
    process.stdout.write(`\n结果：${safeText(report.outcome)}\n报告已写入 ${saveReport(report, out)}（已隐去密钥、签名与账户编号）\n`);
  }
}

main().then(code => { process.exitCode = process.exitCode || code; }, error => {
  process.stderr.write((error instanceof ProbeAbort ? '已中止：' : '运行失败：') + safeText(error) + '\n');
  process.exitCode = process.exitCode || 1;
});
