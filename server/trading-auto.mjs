import { randomUUID } from 'node:crypto';
import { decimal, compareDecimals } from './trading-decimal.mjs';
import { ExecutionError, WaitError, exactKeys, normalizeIntent, units, fromUnits, QUOTE_MAX_AGE, MAX_BATCHES } from './trading-execution-plan.mjs';
import { TRADING_EXCHANGES, TRADING_NAMES, EXECUTION_MARKETS } from './trading-markets.mjs';
import { createStatementCache } from './db-cache.mjs';
import { immediate } from './control/schema.mjs';

/**
 * Threshold rules that open and close a same-venue two-leg spread without a
 * person confirming each trade. Each rule watches one venue's executable
 * spread: oil BZ − CL in USDT per barrel, SK hynix ADR premium over
 * ordinary ÷ 10 in percent. Selling the spread sells the premium leg at its
 * bid and buys the base leg at its ask; buying the spread does the reverse.
 * A 'short' rule sells the spread when it reaches the open threshold and buys
 * it back at the close threshold; a 'long' rule does the opposite.
 *
 * Several rules may share a venue and market. Each one tracks and closes only
 * the legs its own job filled; the executor's symbol locks run their jobs one
 * at a time, and a rule whose symbols are busy waits instead of failing.
 *
 * The executor still checks every order. A job that ends in any state other
 * than completed (paused, stopped, attention) disables the rule and leaves it
 * in review: orders may have filled, so only a person can say what is held.
 */
export const SPREADS = Object.freeze({
  oil: Object.freeze({ premium: 'BZUSDT', base: 'CLUSDT', ratio: 1n, percent: false, unit: 'USDT/桶', label: 'BZ − CL' }),
  hynix: Object.freeze({ premium: 'SKHYUSDT', base: 'SKHYNIXUSDT', ratio: 10n, percent: true, unit: '%', label: 'ADR 相对正股 ÷ 10 溢价' }),
});
const ONE = units('1');
const MAX_RULES = 12, MAX_EVENTS = 30, FAILURE_LIMIT = 3, RETRY_MS = 30_000;
const ACTIVE_JOB = new Set(['queued', 'running', 'stopping']);
const CONFIG_KEYS = ['name', 'market', 'exchange', 'direction', 'openThreshold', 'closeThreshold', 'equalSize', 'orderType', 'confirmSamples', 'maxOpensPerDay', 'batchCount', 'batchIntervalMs', 'repriceIntervalMs', 'timeoutMs'];
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const iso = time => new Date(time).toISOString();
const FINAL_JOB = new Set(['completed', 'stopped']);
// Queued and running read the same so a waiting rule records one event per blocking job.
const JOB_STATUS = { queued: '执行中', running: '执行中', stopping: '停止中', paused: '已暂停，需在执行进度中处理', attention: '待核对，需在执行进度中处理' };
// The books read just before planning no longer meet the threshold: ordinary market movement, not a failure.
class ThresholdMovedError extends ExecutionError { constructor(message) { super(409, message); } }
// The rule changed or the service is stopping between the decision and the job: skip quietly, nothing was sent.
class SkippedError extends ExecutionError { constructor(message) { super(409, message); } }

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ExecutionError(400, `${name}须为 ${min} 至 ${max} 之间的整数`);
  return value;
}
function threshold(value, market, name) {
  let result;
  try { if (typeof value !== 'string' || value.length > 24) throw new Error(); result = decimal(value); } catch { throw new ExecutionError(400, `${name}须为十进制数值`); }
  const low = market === 'hynix' ? '-99' : '-1000', high = '1000';
  if (compareDecimals(result, low) < 0 || compareDecimals(result, high) > 0) throw new ExecutionError(400, `${name}须在 ${low} 至 ${high} 之间`);
  return result;
}
export function normalizeRuleConfig(value) {
  exactKeys(value, CONFIG_KEYS);
  const name = value.name === undefined ? '' : value.name;
  if (typeof name !== 'string' || name.trim().length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new ExecutionError(400, '规则名称最多 40 个字符');
  // hasOwn coerces its key, so an array like ['oil'] would pass without the type check.
  if (typeof value.market !== 'string' || !Object.hasOwn(SPREADS, value.market)) throw new ExecutionError(400, '请选择支持的交易品种');
  if (!TRADING_EXCHANGES.includes(value.exchange)) throw new ExecutionError(400, '请选择交易所');
  if (!['short', 'long'].includes(value.direction)) throw new ExecutionError(400, '请选择开仓方向');
  if (!['chase', 'market'].includes(value.orderType)) throw new ExecutionError(400, '下单方式只能是追价限价或市价');
  const openThreshold = threshold(value.openThreshold, value.market, '开仓阈值'), closeThreshold = threshold(value.closeThreshold, value.market, '平仓阈值');
  const order = compareDecimals(closeThreshold, openThreshold);
  if (value.direction === 'short' ? order >= 0 : order <= 0) throw new ExecutionError(400, value.direction === 'short' ? '做空价差时，平仓阈值须低于开仓阈值' : '做多价差时，平仓阈值须高于开仓阈值');
  let equalSize;
  try { if (typeof value.equalSize !== 'string' || value.equalSize.length > 48) throw new Error(); equalSize = decimal(value.equalSize, { positive: true }); } catch { throw new ExecutionError(400, value.market === 'oil' ? '每腿桶数须为正的十进制数值' : '每腿名义金额须为正的十进制数值'); }
  const config = { name: name.trim(), market: value.market, exchange: value.exchange, direction: value.direction, openThreshold, closeThreshold, equalSize, orderType: value.orderType,
    confirmSamples: integer(value.confirmSamples, 1, 30, '连续满足次数'), maxOpensPerDay: integer(value.maxOpensPerDay, 1, 50, '每日最多开仓次数'),
    batchCount: integer(value.batchCount, 1, MAX_BATCHES, '批次数'), batchIntervalMs: integer(value.batchIntervalMs, 0, 600_000, '批次间隔毫秒数'),
    repriceIntervalMs: integer(value.repriceIntervalMs, 1000, 60_000, '本地追价间隔毫秒数'), timeoutMs: integer(value.timeoutMs, 30_000, 3_600_000, '最长执行毫秒数') };
  normalizeIntent(intentFor(config, 'open'));
  return config;
}
/** Legs of the rule's position: 'short' holds the premium leg short and the base leg long. */
function legsFor(config) {
  const spread = SPREADS[config.market], premiumSide = config.direction === 'short' ? 'short' : 'long';
  return [{ exchange: config.exchange, symbol: spread.premium, side: premiumSide }, { exchange: config.exchange, symbol: spread.base, side: premiumSide === 'short' ? 'long' : 'short' }];
}
export function intentFor(config, action, held = null) {
  const legs = legsFor(config).map(leg => ({ ...leg, orderType: config.orderType, ...(action === 'close' ? { quantity: held.find(item => item.symbol === leg.symbol && item.side === leg.side)?.quantity } : {}) }));
  return { market: config.market, preset: 'same-exchange', action, legs, ...(action === 'open' ? { equalSize: config.equalSize } : {}),
    batchCount: config.batchCount, batchIntervalMs: config.batchIntervalMs, repriceIntervalMs: config.repriceIntervalMs, timeoutMs: config.timeoutMs };
}
function book(quotes, exchange, symbol, now) {
  const row = quotes?.books?.find(item => item.exchange === exchange && item.symbol === symbol);
  if (!row || row.error) return { error: `${symbol} ${row?.error ?? '未取得盘口'}` };
  try {
    const bid = decimal(row.bid, { positive: true }), ask = decimal(row.ask, { positive: true }), at = Date.parse(row.at);
    if (compareDecimals(bid, ask) >= 0 || !Number.isFinite(at)) throw new Error();
    if (now - at > QUOTE_MAX_AGE || at - now > 1000) return { error: `${symbol} 盘口已过期` };
    return { bid, ask, at: row.at };
  } catch { return { error: `${symbol} 盘口不完整` }; }
}
// Sign of (spread − limit) without floating point. Oil: premium − base.
// Hynix: (premium × ratio ÷ base − 1) × 100, compared as
// premium × ratio × 100 against (100 + limit) × base (base > 0).
function compareSpread(spread, premium, base, limit) {
  const left = spread.percent ? units(premium) * spread.ratio * 100n * ONE : units(premium) - units(base);
  const right = spread.percent ? (units(limit) + 100n * ONE) * units(base) : units(limit);
  return left > right ? 1 : left < right ? -1 : 0;
}
const displaySpread = (spread, premium, base) => spread.percent ? (Number(premium) * Number(spread.ratio) / Number(base) - 1) * 100 : Number(premium) - Number(base);
/**
 * The executable spread for the rule's next action and whether it meets the
 * threshold. Selling the spread is checked against bid(premium) − ask(base),
 * buying it against ask(premium) − bid(base).
 */
export function evaluateRule(config, action, quotes, now) {
  const spread = SPREADS[config.market], premium = book(quotes, config.exchange, spread.premium, now), base = book(quotes, config.exchange, spread.base, now);
  if (premium.error || base.error) return { error: premium.error || base.error };
  const sell = (config.direction === 'short') === (action === 'open');
  const premiumPrice = sell ? premium.bid : premium.ask, basePrice = sell ? base.ask : base.bid;
  const limit = action === 'open' ? config.openThreshold : config.closeThreshold;
  const sign = compareSpread(spread, premiumPrice, basePrice, limit);
  return { value: displaySpread(spread, premiumPrice, basePrice), met: sell ? sign >= 0 : sign <= 0, side: sell ? 'sell' : 'buy', sample: `${premium.at}|${base.at}`, at: [premium.at, base.at].sort()[0] };
}
const divCeil = (a, b) => (a + b - 1n) / b;
const floorTick = (value, tick) => value - value % tick;
const ceilTick = (value, tick) => value % tick ? value - value % tick + tick : value;
/**
 * Per-leg price limits for a batch whose executable spread met the threshold.
 * The slack beyond the threshold is split between the legs and each limit is
 * rounded toward safety on its tick, so any fill strictly better than both
 * limits still meets the threshold. Selling the spread: the premium leg sells
 * above its limit and the base leg buys below it; buying is the reverse.
 * Returns null when the books do not meet the threshold.
 */
export function boundsFor(config, action, premium, base) {
  const spread = SPREADS[config.market], sell = (config.direction === 'short') === (action === 'open');
  const limit = units(action === 'open' ? config.openThreshold : config.closeThreshold);
  const factor = limit + 100n * ONE, scale = 100n * spread.ratio * ONE;
  // Premium price at the threshold for a base price, and base price at the threshold for a premium price.
  const premiumAt = (b, up) => spread.percent ? (up ? divCeil(factor * b, scale) : factor * b / scale) : b + limit;
  const baseAt = (p, up) => spread.percent ? (up ? divCeil(p * scale, factor) : p * scale / factor) : p - limit;
  const pTick = units(premium.tickSize), bTick = units(base.tickSize);
  if (sell) {
    const bid = units(premium.bid), floor = premiumAt(units(base.ask), true);
    if (bid < floor) return null;
    // A sell limit is a minimum price: never below one tick, which only narrows what may fill.
    const premiumLimit = ceilTick(bid - (bid - floor) / 2n, pTick), clamped = premiumLimit < pTick ? pTick : premiumLimit;
    return { premium: fromUnits(clamped), base: fromUnits(floorTick(baseAt(clamped, false), bTick)) };
  }
  const ask = units(premium.ask), ceiling = premiumAt(units(base.bid), false);
  if (ask > ceiling) return null;
  const premiumLimit = floorTick(ask + (ceiling - ask) / 2n, pTick), baseLimit = ceilTick(baseAt(premiumLimit, true), bTick);
  return { premium: fromUnits(premiumLimit), base: fromUnits(baseLimit < bTick ? bTick : baseLimit) };
}const emptyState = () => ({ phase: 'idle', jobId: null, held: null, opens: { day: null, count: 0 }, failures: 0, retryAt: null, reason: null, events: [] });

export function createTradingAuto({ db, execution, admit = operation => operation(), readMaintenance = () => false, now = Date.now, intervalMs = 2000, log } = {}) {
  const stmt = createStatementCache(db);
  db.exec('CREATE TABLE IF NOT EXISTS execution_auto_rules (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL)');
  // Consecutive hits and the last reading are kept in memory only: after a
  // restart a rule must see its condition again on fresh books.
  const live = new Map();
  let closed = false, ticking = null;
  const day = () => dayFormat.format(now());
  const parse = row => row && { id: row.id, revision: row.revision, enabled: !!row.enabled, createdAt: row.created_at, config: JSON.parse(row.config), state: JSON.parse(row.state) };
  const rows = () => stmt.prepare('SELECT * FROM execution_auto_rules ORDER BY created_at, rowid').all().map(parse);
  const ruleFor = id => { const rule = parse(stmt.prepare('SELECT * FROM execution_auto_rules WHERE id=?').get(id)); if (!rule) throw new ExecutionError(404, '自动规则不存在'); return rule; };
  const opensToday = state => state.opens?.day === day() ? state.opens.count : 0;
  const event = (state, message) => { state.events = [...(state.events ?? []), { time: iso(now()), message }].slice(-MAX_EVENTS); };
  const saveState = (id, state) => stmt.prepare('UPDATE execution_auto_rules SET state=? WHERE id=?').run(JSON.stringify(state), id);
  // A disable by the engine bumps the revision so a form opened earlier cannot re-enable silently.
  const disable = (id, state) => stmt.prepare('UPDATE execution_auto_rules SET enabled=0,revision=revision+1,state=? WHERE id=?').run(JSON.stringify(state), id);
  const transaction = operation => immediate(db, operation);
  const title = config => config.name || `${TRADING_NAMES[config.exchange]} ${EXECUTION_MARKETS[config.market].name}${config.direction === 'short' ? '做空' : '做多'}价差`;

  function liveView(reading) {
    const stale = !reading.note && reading.at && now() - Date.parse(reading.at) > QUOTE_MAX_AGE;
    return stale ? { hits: 0, value: reading.value ?? null, met: false, side: reading.side ?? null, at: reading.at, note: '盘口超过 10 秒未更新，暂不判断' }
      : { hits: reading.hits, value: reading.value ?? null, met: !!reading.met, side: reading.side ?? null, at: reading.at ?? null, note: reading.note ?? null };
  }
  function publicRule(rule) {
    const reading = live.get(rule.id);
    return { id: rule.id, revision: rule.revision, enabled: rule.enabled, createdAt: rule.createdAt, title: title(rule.config), config: rule.config,
      spread: { label: SPREADS[rule.config.market].label, unit: SPREADS[rule.config.market].unit },
      state: { phase: rule.state.phase, jobId: rule.state.jobId, held: rule.state.held, opensToday: opensToday(rule.state), failures: rule.state.failures, retryAt: rule.state.retryAt, reason: rule.state.reason, events: rule.state.events },
      live: reading ? liveView(reading) : null };
  }
  function view() { return { generatedAt: iso(now()), maintenance: !!readMaintenance(), rules: rows().map(publicRule) }; }
  function checkRevision(rule, revision) { if (!Number.isSafeInteger(revision) || rule.revision !== revision) throw new ExecutionError(409, '规则已被更新，请刷新后重试'); }
  function checkLive(body) { if (body.confirmLive !== true) throw new ExecutionError(400, '启用前请确认规则会自动实盘下单'); }

  function create(body) {
    exactKeys(body, ['config', 'enabled', 'confirmLive']);
    const config = normalizeRuleConfig(body.config), enabled = body.enabled === true;
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new ExecutionError(400, '启用状态无效');
    if (enabled) checkLive(body);
    return transaction(() => {
      if (rows().length >= MAX_RULES) throw new ExecutionError(409, `最多保存 ${MAX_RULES} 条自动规则`);
      const state = emptyState(); event(state, enabled ? '规则已创建并启用' : '规则已创建，尚未启用');
      stmt.prepare('INSERT INTO execution_auto_rules(id,revision,enabled,created_at,config,state) VALUES (?,?,?,?,?,?)').run(randomUUID(), 0, enabled ? 1 : 0, iso(now()), JSON.stringify(config), JSON.stringify(state));
      return view();
    });
  }
  function update(id, body) {
    exactKeys(body, ['revision', 'config']);
    const config = normalizeRuleConfig(body.config);
    return transaction(() => {
      const rule = ruleFor(id); checkRevision(rule, body.revision);
      if (['opening', 'closing'].includes(rule.state.phase)) throw new ExecutionError(409, '自动任务执行中，结束后再修改规则');
      if (rule.state.phase !== 'idle' && ['market', 'exchange', 'direction'].some(key => config[key] !== rule.config[key])) throw new ExecutionError(409, '规则持有仓位或待核对时，不能更改品种、交易所或方向');
      const state = { ...rule.state, failures: 0, retryAt: null }; event(state, '规则参数已更新');
      stmt.prepare('UPDATE execution_auto_rules SET revision=revision+1,config=?,state=? WHERE id=?').run(JSON.stringify(config), JSON.stringify(state), id);
      live.delete(id);
      return view();
    });
  }
  function act(id, action, body) {
    if (action === 'enable') exactKeys(body, ['revision', 'confirmLive']);
    else if (action === 'reset') exactKeys(body, ['revision', 'acknowledge']);
    else exactKeys(body, ['revision']);
    return transaction(() => {
      const rule = ruleFor(id); checkRevision(rule, body.revision);
      const state = { ...rule.state };
      if (action === 'enable') {
        checkLive(body);
        if (rule.state.phase === 'review') throw new ExecutionError(409, '上次自动任务未正常结束，请先核对仓位并重置规则');
        Object.assign(state, { failures: 0, retryAt: null, reason: null }); event(state, '规则已启用');
        stmt.prepare('UPDATE execution_auto_rules SET revision=revision+1,enabled=1,state=? WHERE id=?').run(JSON.stringify(state), id);
      } else if (action === 'disable') {
        event(state, ['opening', 'closing'].includes(state.phase) ? '规则已停用；执行中的任务继续，可在执行进度中停止' : '规则已停用');
        stmt.prepare('UPDATE execution_auto_rules SET revision=revision+1,enabled=0,state=? WHERE id=?').run(JSON.stringify(state), id);
      } else if (action === 'reset') {
        if (body.acknowledge !== true) throw new ExecutionError(400, '请确认已自行核对并处理仓位');
        if (!['review', 'holding'].includes(state.phase)) throw new ExecutionError(409, '只有待核对或持仓中的规则可以重置');
        // A paused or attention job still holds its symbol locks and may hold orders; it must end first.
        if (state.jobId) {
          let job = null;
          try { job = execution.jobView(state.jobId); } catch (error) { if (error?.status !== 404) throw error; }
          if (job && !FINAL_JOB.has(job.status)) throw new ExecutionError(409, '关联的自动任务尚未结束，请先在执行进度中核对并停止该任务');
        }
        Object.assign(state, { phase: 'idle', jobId: null, held: null, account: null, failures: 0, retryAt: null, reason: null }); event(state, '已确认人工处理仓位，规则重置为等待开仓（未启用）');
        stmt.prepare('UPDATE execution_auto_rules SET revision=revision+1,enabled=0,state=? WHERE id=?').run(JSON.stringify(state), id);
      } else throw new ExecutionError(404, '自动规则操作不存在');
      live.delete(id);
      return view();
    });
  }
  function remove(id, body) {
    exactKeys(body, ['revision']);
    return transaction(() => {
      const rule = ruleFor(id); checkRevision(rule, body.revision);
      if (rule.state.phase !== 'idle') throw new ExecutionError(409, '规则持有仓位、执行中或待核对，不能删除；请先处理后重置');
      stmt.prepare('DELETE FROM execution_auto_rules WHERE id=?').run(id); live.delete(id);
      return view();
    });
  }

  // In-flight jobs are followed whether or not the rule is still enabled.
  function follow(rule) {
    let job;
    try { job = execution.jobView(rule.state.jobId); }
    catch (error) {
      if (error?.status !== 404) return;
      job = null;
    }
    if (job && ACTIVE_JOB.has(job.status)) return;
    transaction(() => {
      const current = ruleFor(rule.id);
      if (current.state.jobId !== rule.state.jobId || !['opening', 'closing'].includes(current.state.phase)) return;
      const state = { ...current.state }, opening = state.phase === 'opening';
      const held = job?.legs.map(leg => ({ exchange: leg.exchange, symbol: leg.symbol, side: leg.side, quantity: leg.filledQuantity }));
      if (job?.status === 'stopped' && job.auto?.unsent) {
        // Nothing was sent: the rule returns to where it was and the open does not count.
        if (opening) Object.assign(state, { phase: 'idle', jobId: null, opens: state.opens?.day === day() ? { day: state.opens.day, count: Math.max(0, state.opens.count - 1) } : state.opens });
        else Object.assign(state, { phase: 'holding', jobId: null });
        event(state, `${job.reason ?? '发送前复核未通过'}；继续等待${opening ? '开仓' : '平仓'}条件`); saveState(rule.id, state); live.delete(rule.id);
        return;
      }
      const account = opening && job ? execution.jobAccounts(job.id).find(row => row.exchange === current.config.exchange) : null;
      if (job?.status === 'completed' && (!opening || account && held.length === 2 && held.every(leg => compareDecimals(leg.quantity, '0') > 0))) {
        if (opening) { Object.assign(state, { phase: 'holding', held, account: { revision: account.revision, identity: account.identity }, jobId: null }); event(state, `开仓任务全部成交：${held.map(leg => `${leg.symbol} ${leg.side === 'long' ? '多' : '空'} ${leg.quantity}`).join('，')}；等待平仓条件`); }
        else { Object.assign(state, { phase: 'idle', held: null, account: null, jobId: null }); event(state, '平仓任务全部成交；重新等待开仓条件'); }
        saveState(rule.id, state);
      } else {
        const status = job ? { paused: '已暂停', stopped: '已停止', attention: '待核对', completed: '成交数量异常' }[job.status] ?? job.status : '记录不存在';
        Object.assign(state, { phase: 'review', reason: `${opening ? '开仓' : '平仓'}任务${status}${job?.reason ? '：' + job.reason : ''}。已停用规则；请在执行进度中核对成交与仓位，处理后重置规则` });
        event(state, state.reason); disable(rule.id, state);
      }
      live.delete(rule.id);
    });
  }
  function note(id, value) { live.set(id, { ...(live.get(id) ?? { hits: 0 }), ...value }); }
  // Waiting counts no failure, so its first sight is kept in the rule's events and the log instead.
  function recordWait(rule, message, warn) {
    // The tick re-reads each rule, so a repeat is skipped without opening a write transaction.
    if (rule.state.events?.at(-1)?.message === message) return;
    const recorded = transaction(() => {
      const current = ruleFor(rule.id);
      if (current.revision !== rule.revision || current.state.phase !== rule.state.phase || current.state.events?.at(-1)?.message === message) return false;
      const state = { ...current.state }; event(state, message); saveState(rule.id, state);
      return true;
    });
    if (recorded) log?.[warn ? 'warn' : 'info']?.({ type: 'execution-auto', ruleId: rule.id }, message);
  }
  function blocker(jobId) {
    let job = null;
    try { job = execution.jobView(jobId); } catch { /* A lock whose job cannot be read is still a lock. */ }
    const owner = job?.auto && rows().find(item => item.id === job.auto.ruleId);
    const who = !job ? '' : job.auto ? owner ? `规则「${title(owner.config)}」的${job.auto.action === 'open' ? '开仓' : '平仓'}` : '自动' : '手动执行';
    return { stuck: !job || ['paused', 'attention'].includes(job.status), text: `${who}任务 ${String(jobId).slice(0, 8)}${JOB_STATUS[job?.status] ? `（${JOB_STATUS[job.status]}）` : ''}` };
  }
  async function trigger(rule, action, reading) {
    const trigger = `${SPREADS[rule.config.market].label} 可成交价差 ${reading.value.toFixed(4)}${SPREADS[rule.config.market].unit === '%' ? '%' : ''}，${action === 'open' ? '开仓' : '平仓'}阈值 ${action === 'open' ? rule.config.openThreshold : rule.config.closeThreshold}，连续 ${rule.config.confirmSamples} 次满足`;
    try {
      const accounts = action === 'close' ? { [rule.config.exchange]: rule.state.account.revision } : null;
      await admit(() => execution.startAutomatic(intentFor(rule.config, action, rule.state.held), { auto: { ruleId: rule.id, action, trigger, guard: rule.config }, accounts, check: books => {
        const fresh = evaluateRule(rule.config, action, books, now());
        if (fresh.error || !fresh.met) throw new ThresholdMovedError(fresh.error ? `下单前复核盘口：${fresh.error}` : '下单前复核盘口：可成交价差已不满足阈值');
      }, commit: jobId => {
        if (closed) throw new SkippedError('服务正在停止，本次未触发');
        const current = ruleFor(rule.id);
        if (current.revision !== rule.revision || !current.enabled || current.state.phase !== rule.state.phase) throw new SkippedError('规则已变化，本次未触发');
        if (action === 'open' && opensToday(current.state) >= current.config.maxOpensPerDay) throw new ExecutionError(409, '今日开仓次数已达上限');
        const state = { ...current.state, phase: action === 'open' ? 'opening' : 'closing', jobId, failures: 0, retryAt: null, reason: null,
          ...(action === 'open' ? { opens: { day: day(), count: opensToday(current.state) + 1 } } : {}) };
        event(state, `触发${action === 'open' ? '开仓' : '平仓'}：${trigger}`); saveState(rule.id, state);
      } }));
      live.delete(rule.id);
    } catch (error) {
      const message = error instanceof ExecutionError || error?.status ? String(error.message).slice(0, 220) : '自动任务创建失败';
      if (error instanceof SkippedError) { live.delete(rule.id); return; }
      if (error instanceof ThresholdMovedError) { live.set(rule.id, { hits: 0, met: false, value: reading.value, side: reading.side, at: reading.at, note: message }); return; }
      // Another job or an opposite one-way position blocks the symbols: wait without counting a failure.
      if (error instanceof WaitError) {
        const current = ruleFor(rule.id);
        if (current.revision !== rule.revision || current.state.phase !== rule.state.phase) { live.delete(rule.id); return; }
        const text = `${action === 'open' ? '开仓' : '平仓'}等待：${message}；${RETRY_MS / 1000} 秒后重新判断`;
        live.set(rule.id, { hits: 0, met: false, value: reading.value, side: reading.side, at: reading.at, note: text, waitUntil: now() + RETRY_MS });
        recordWait(rule, text, true); return;
      }
      transaction(() => {
        const current = ruleFor(rule.id);
        if (current.revision !== rule.revision || current.state.phase !== rule.state.phase) return;
        const state = { ...current.state, failures: (current.state.failures || 0) + 1, retryAt: iso(now() + RETRY_MS), reason: `${action === 'open' ? '开仓' : '平仓'}未触发：${message}` };
        // Nothing was sent: no job exists. Repeated refusals stop the rule instead of retrying forever.
        if (state.failures >= FAILURE_LIMIT) { state.reason += `；连续 ${FAILURE_LIMIT} 次未能创建任务，已停用规则`; event(state, state.reason); disable(rule.id, state); }
        else { event(state, `${state.reason}；${RETRY_MS / 1000} 秒后重新判断`); saveState(rule.id, state); }
      });
      live.delete(rule.id);
      log?.warn?.({ type: 'execution-auto', ruleId: rule.id, action }, '自动规则未能创建执行任务');
    }
  }
  // The held legs belong to the connection that opened them. After a reconnect
  // (same or different account) only a person can say where they are.
  function toReview(rule, reason) {
    transaction(() => {
      const current = ruleFor(rule.id);
      if (current.revision !== rule.revision || current.state.phase !== rule.state.phase) return;
      const state = { ...current.state, phase: 'review', reason }; event(state, reason); disable(rule.id, state);
    });
    live.delete(rule.id);
  }
  async function evaluate(rule, quotes) {
    const action = rule.state.phase === 'idle' ? 'open' : 'close';
    if (action === 'close') {
      const connection = execution.connectionOf(rule.config.exchange);
      if (!rule.state.account || !connection.connected || connection.revision !== rule.state.account.revision) {
        toReview(rule, '开仓后实盘连接已更换或断开，本规则不会向当前连接平仓。已停用规则；请核对原账户仓位，处理后重置规则');
        return;
      }
    }
    if (rule.state.retryAt && now() < Date.parse(rule.state.retryAt)) { note(rule.id, { hits: 0, note: '上次未能创建任务，等待重新判断' }); return; }
    if (action === 'open' && opensToday(rule.state) >= rule.config.maxOpensPerDay) { note(rule.id, { hits: 0, met: false, note: '今日开仓次数已达上限' }); return; }
    if (now() < (live.get(rule.id)?.waitUntil ?? 0)) return;
    const owner = execution.lockOwner(legsFor(rule.config));
    if (owner) {
      const { stuck, text } = blocker(owner), message = `${action === 'open' ? '开仓' : '平仓'}等待：同合约有未结束的${text}，结束后再判断`;
      note(rule.id, { hits: 0, met: false, value: null, note: message }); recordWait(rule, message, stuck); return;
    }
    const reading = evaluateRule(rule.config, action, quotes, now());
    if (reading.error) { note(rule.id, { hits: 0, met: false, value: null, note: reading.error }); return; }
    const previous = live.get(rule.id);
    // A cached quote read counts once: hits need distinct book updates.
    const hits = !reading.met ? 0 : previous?.sample === reading.sample ? previous.hits : (previous?.met ? previous.hits : 0) + 1;
    live.set(rule.id, { hits, value: reading.value, met: reading.met, side: reading.side, at: reading.at, sample: reading.sample, note: null });
    if (reading.met && hits >= rule.config.confirmSamples) await trigger(rule, action, reading);
  }
  async function runTick() {
    if (closed) return;
    if (!execution.leading()) { live.clear(); return; }
    for (const rule of rows()) if (['opening', 'closing'].includes(rule.state.phase)) { try { follow(rule); } catch (error) { log?.warn?.({ err: error, type: 'execution-auto' }, '自动规则任务状态核对失败'); } }
    const armed = rows().filter(rule => rule.enabled && ['idle', 'holding'].includes(rule.state.phase));
    for (const id of live.keys()) if (!armed.some(rule => rule.id === id)) live.delete(id);
    if (!armed.length) return;
    // Maintenance outranks every trigger: nothing new is sent while an update is pending.
    if (readMaintenance()) { for (const rule of armed) note(rule.id, { hits: 0, met: false, note: '系统更新中，暂停自动触发' }); return; }
    let quotes;
    try { quotes = await execution.quotes(); } catch { for (const rule of armed) note(rule.id, { hits: 0, met: false, note: '盘口读取失败' }); return; }
    // One rule at a time, each re-read: an earlier trigger may have taken a lock or changed state.
    for (const { id } of armed) {
      if (closed) return;
      const rule = parse(stmt.prepare('SELECT * FROM execution_auto_rules WHERE id=?').get(id));
      if (rule?.enabled && ['idle', 'holding'].includes(rule.state.phase)) await evaluate(rule, quotes);
    }
  }
  function tick() {
    if (closed) return Promise.resolve();
    if (!ticking) ticking = runTick().catch(error => log?.warn?.({ err: error, type: 'execution-auto' }, '自动规则检查失败')).finally(() => { ticking = null; });
    return ticking;
  }
  const timer = intervalMs > 0 ? setInterval(() => { void tick(); }, intervalMs) : null;
  timer?.unref?.();
  // stop() is synchronous so shutdown can refuse new triggers before any service is awaited.
  function stop() { closed = true; clearInterval(timer); }
  return { state: view, create, update, act, remove, tick, stop, async close() { stop(); await ticking; } };
}
