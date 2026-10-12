import { randomUUID, createHash } from 'node:crypto';
import { PERPETUAL_PAPER_LIMITS as limits, calculatePerpetualPaperPnl, perpetualPaperIdentity } from '../lib/perpetual-paper.ts';
import { resolveTakerFee, takerFeeVenues, validFeePercent } from '../lib/perpetual-fees.ts';
import { quoteIsFresh, quotePriceTime } from '../lib/perpetual-spreads.ts';
import { validatePerpetualExitPosition } from '../lib/perpetual-exit.ts';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const money = value => finite(value) && Math.abs(value) <= 1e9;
const nonnegative = value => money(value) && value >= 0;
const venueIds = new Set(takerFeeVenues.map(item => item.id));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const requestIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
export const initialPerpetualPaperState = () => ({ version: 1, revision: 0, positions: [] });
const sameIdentity = (position, long, short) => Boolean(long && short && long.base === position.base && short.base === position.base
  && long.exchange !== short.exchange && [long, short].every(quote => quote.quoteCurrency === 'USDT' && (!quote.collateralCurrency || quote.collateralCurrency === 'USDT') && quote.comparable !== false)
  && `${long.exchange}:${long.symbol}` === position.longKey && `${short.exchange}:${short.symbol}` === position.shortKey
  && position.identity === perpetualPaperIdentity(long, short));

function settings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('持仓参数无效。');
  const capital = input.capital ?? null, targetNetProfit = input.targetNetProfit ?? null, maxHoldingHours = input.maxHoldingHours ?? null;
  if (capital !== null && (!positive(capital) || capital > 1e9)) throw fail('占用资金必须大于 0 且不超过 10 亿 USDT。');
  if (targetNetProfit !== null && !money(targetNetProfit)) throw fail('目标净收益金额无效。');
  if (maxHoldingHours !== null && (!positive(maxHoldingHours) || maxHoldingHours > 8760)) throw fail('最长持有时间需大于 0 且不超过 8760 小时。');
  if (!money(input.settledFunding)) throw fail('已登记资金费须填写净额：收入为正，支出为负。');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 200)) throw fail('备注最多 200 字。');
  const takerOverrides = {};
  if (input.takerOverrides !== undefined && (!input.takerOverrides || typeof input.takerOverrides !== 'object' || Array.isArray(input.takerOverrides))) throw fail('手续费设置无效。');
  for (const [venue, fee] of Object.entries(input.takerOverrides ?? {})) {
    if (!venueIds.has(venue) || !validFeePercent(fee)) throw fail('账户 taker 费率无效。');
    takerOverrides[venue] = fee;
  }
  return { capital, targetNetProfit, maxHoldingHours, settledFunding: input.settledFunding, note: input.note ?? '', takerOverrides };
}

function fundingDeadline(long, short, now) {
  const upcoming = [long?.nextFundingAt, short?.nextFundingAt].filter(at => finite(at) && at > now);
  return upcoming.length ? Math.min(...upcoming) : null;
}

function requestFingerprint(draft) {
  const config = settings(draft);
  validatePerpetualExitPosition({ ...draft, capital: config.capital });
  return createHash('sha256').update(JSON.stringify({ mode: draft.mode ?? 'paper', base: draft.base, longKey: draft.longKey, shortKey: draft.shortKey, identity: draft.identity,
    quantity: draft.quantity, entryLongPrice: draft.entryLongPrice, entryShortPrice: draft.entryShortPrice, entryFeePaid: draft.entryFeePaid,
    openedAt: draft.openedAt, ...config, takerOverrides: Object.fromEntries(Object.entries(config.takerOverrides).sort(([a], [b]) => a.localeCompare(b))) })).digest('hex');
}

/** Reads existing normalized BBO only; no network calls or balance assumptions. */
export function evaluatePerpetualPaperPosition(position, getQuote, now, isVenueLive = () => true) {
  const long = getQuote(position.longKey), short = getQuote(position.shortKey);
  const fundingScheduleKnown = [long?.nextFundingAt, short?.nextFundingAt].every(at => finite(at) && at > position.fundingUpdatedAt);
  const fundingNeedsReview = !fundingScheduleKnown || position.nextFundingAt === null || now >= position.nextFundingAt && position.fundingUpdatedAt < position.nextFundingAt;
  const result = { at: now, valid: false, reason: '', sourceAt: null, longBid: null, shortAsk: null, pnl: null, fundingNeedsReview };
  if (!sameIdentity(position, long, short)) return { ...result, reason: '合约已下线、身份变更或缓存尚未就绪' };
  if ([long, short].some(quote => finite(quote.delistingAt) && quote.delistingAt <= now)) return { ...result, reason: '至少一腿已到下架时间，旧报价不再估值' };
  if (!isVenueLive(long.exchange) || !isVenueLive(short.exchange)) return { ...result, reason: '至少一腿平台连接未在线' };
  if (![long, short].every(quote => quoteIsFresh(quote, 'book', now, limits.quoteFreshMs) && positive(quote.bid) && positive(quote.ask) && quote.ask >= quote.bid)) return { ...result, reason: '一档报价过期或盘口不完整' };
  if (Math.abs(quotePriceTime(long, 'book') - quotePriceTime(short, 'book')) > 5000) return { ...result, reason: '双腿报价时间相差超过 5 秒' };
  result.sourceAt = Math.min(quotePriceTime(long, 'book'), quotePriceTime(short, 'book'));
  result.longBid = long.bid; result.shortAsk = short.ask;
  const longFee = resolveTakerFee(long, position.takerOverrides, now), shortFee = resolveTakerFee(short, position.takerOverrides, now);
  if (longFee.percent === null || shortFee.percent === null) return { ...result, reason: '平仓 taker 费率缺失或过期，无法估算净收益' };
  const closeFeePaid = position.quantity * (long.bid * longFee.percent + short.ask * shortFee.percent) / 100;
  const pnl = calculatePerpetualPaperPnl(position, { exitLongPrice: long.bid, exitShortPrice: short.ask, closeFeePaid });
  if (!pnl) return { ...result, reason: '收益计算超出有效范围' };
  return { ...result, valid: true, pnl, reason: !fundingScheduleKnown || position.nextFundingAt === null ? '一档估算；至少一腿资金费结算时间未知或尚未更新，请手工核对已登记净额' : fundingNeedsReview ? '一档估算；已跨资金费结算时点，请核对并更新已登记净额' : '一档估算；仅计已登记资金费，未检查平仓深度' };
}

function prune(state, now) {
  const active = state.positions.filter(item => item.status === 'active');
  const closed = state.positions.filter(item => item.status !== 'active' && item.close?.closedAt > now - limits.closedRetentionMs)
    .sort((a, b) => b.close.closedAt - a.close.closedAt).slice(0, limits.closed);
  state.positions = [...active, ...closed];
}

function sample(position, observation) {
  const bucket = Math.floor(observation.at / limits.sampleIntervalMs) * limits.sampleIntervalMs;
  const point = [bucket, observation.valid ? observation.pnl.netProfit : null];
  position.samples = position.samples.filter(([at]) => at > bucket - limits.samples * limits.sampleIntervalMs && at <= bucket);
  const last = position.samples.at(-1);
  if (!last || last[0] !== bucket) {
    if (last && bucket - last[0] > limits.sampleIntervalMs) position.samples.push([Math.max(last[0] + limits.sampleIntervalMs, bucket - limits.sampleIntervalMs), null]);
    position.samples.push(point);
  } else position.samples[position.samples.length - 1] = point;
  position.samples = position.samples.slice(-limits.samples);
}

/** At most twenty minute observations; state mutations serialize with atomic disk writes. */
export function createPerpetualPaperService({ store, unavailableReason = '', getQuote = () => undefined, isVenueLive = () => true, clock = Date.now } = {}) {
  let state = store?.get() ?? initialPerpetualPaperState(), queue = Promise.resolve(), running = false, storageError = '', lastCheck = null, nextCheck = null;
  const metrics = { observations: 0, writes: 0, writeFailures: 0 };
  const serial = work => { const task = queue.then(work); queue = task.catch(() => {}); return task; };
  const save = async next => {
    try { await store.save(next); state = next; storageError = ''; metrics.writes++; }
    catch { storageError = '持仓记录保存失败，保留最后成功保存的状态；请检查磁盘空间与目录权限。'; metrics.writeFailures++; throw fail(storageError, 503); }
  };
  const view = () => ({ available: Boolean(store), generatedAt: clock(), revision: state.revision, running, error: storageError || unavailableReason, limits,
    positions: structuredClone(state.positions).filter(position => position.status === 'active' || position.close.closedAt > clock() - limits.closedRetentionMs).map(position => ({ ...position,
      currentObservation: position.status === 'active' ? evaluatePerpetualPaperPosition(position, getQuote, clock(), isVenueLive) : null,
      holdingHours: Math.max(0, (position.close?.closedAt ?? clock()) - position.openedAt) / 3_600_000,
    })),
  });
  function observe(position, now) {
    // Capture newly available schedules, but never roll forward an unconfirmed settlement.
    const nextFundingAt = fundingDeadline(getQuote(position.longKey), getQuote(position.shortKey), now);
    if (position.nextFundingAt === null || nextFundingAt !== null && nextFundingAt < position.nextFundingAt) position.nextFundingAt = nextFundingAt;
    const observation = evaluatePerpetualPaperPosition(position, getQuote, now, isVenueLive);
    position.lastObservation = observation; position.observations++; metrics.observations++;
    if (position.maxHoldingHours !== null && now - position.openedAt >= position.maxHoldingHours * 3_600_000) position.timedOutAt ??= now;
    if (observation.valid) {
      position.validObservations++;
      position.worstObservedNetProfit = Math.min(position.worstObservedNetProfit ?? Infinity, observation.pnl.netProfit);
      if (position.targetNetProfit !== null && observation.pnl.netProfit >= position.targetNetProfit) position.targetReachedAt ??= now;
    }
    sample(position, observation);
  }
  return {
    view,
    check() {
      if (!running || !store || nextCheck) return nextCheck ?? Promise.resolve();
      const now = clock();
      if (lastCheck !== null && now >= lastCheck && now - lastCheck < limits.observationIntervalMs) return Promise.resolve();
      lastCheck = now;
      nextCheck = serial(async () => {
        const next = structuredClone(state), before = next.positions.length;
        prune(next, now);
        let changed = next.positions.length !== before;
        for (const position of next.positions) if (position.status === 'active') { observe(position, now); changed = true; }
        if (changed) await save(next);
      }).finally(() => { nextCheck = null; });
      return nextCheck;
    },
    update(input) {
      return serial(async () => {
        if (!store) throw fail(unavailableReason || 'Linux 持仓跟踪后台未连接。', 503);
        if (input?.action === 'create' && input.position?.requestId !== undefined) {
          if (typeof input.position.requestId !== 'string' || !requestIdPattern.test(input.position.requestId)) throw fail('登记请求编号须为最多 80 位的字母、数字、下划线或短横线。');
          const existing = state.positions.find(position => position.requestId === input.position.requestId && (position.status === 'active' || position.close.closedAt > clock() - limits.closedRetentionMs));
          // A lost response may retry an older revision. It must resolve to the exact
          // original request, even after funding edits, closure or a process restart.
          if (existing) {
            if (existing.requestFingerprint !== requestFingerprint(input.position)) throw fail('此登记请求编号已用于不同持仓参数，请重新登记。', 409);
            return view();
          }
        }
        if (!Number.isSafeInteger(input?.revision) || input.revision !== state.revision) throw fail('持仓记录已被另一页面修改，请重载后再保存。', 409);
        const now = clock(), next = structuredClone(state); prune(next, now);
        if (input.action === 'create') {
          if (next.positions.filter(item => item.status === 'active').length >= limits.active) throw fail('最多同时跟踪 20 个持仓，请先结束已有观察。');
          const draft = input.position, config = settings(draft);
          if (!['paper', 'manual'].includes(draft.mode ?? 'paper') || typeof draft.base !== 'string' || draft.base.length > 80 || typeof draft.identity !== 'string' || draft.identity.length > 1000
            || [draft.longKey, draft.shortKey].some(key => typeof key !== 'string' || key.length > 160)) throw fail('持仓组合身份无效。');
          validatePerpetualExitPosition({ ...draft, capital: config.capital });
          if (!finite(draft.openedAt) || draft.openedAt <= 0 || draft.openedAt > now) throw fail('开仓时间必须为过去或当前时间。');
          const long = getQuote(draft.longKey), short = getQuote(draft.shortKey);
          if (!sameIdentity(draft, long, short)) throw fail('仅支持已接入、身份一致、不同平台的同标的 USDT 线性合约；报价与保证金币种均须 USDT。');
          if ([long, short].some(quote => finite(quote.delistingAt) && quote.delistingAt <= now)) throw fail('至少一腿已到下架时间，不能新建观察。');
          const position = { id: randomUUID(), mode: draft.mode ?? 'paper', status: 'active', base: draft.base, longKey: draft.longKey, shortKey: draft.shortKey, identity: draft.identity,
            ...(draft.requestId ? { requestId: draft.requestId, requestFingerprint: requestFingerprint(draft) } : {}),
            quantity: draft.quantity, entryLongPrice: draft.entryLongPrice, entryShortPrice: draft.entryShortPrice, entryFeePaid: draft.entryFeePaid, ...config,
            openedAt: draft.openedAt, createdAt: now, updatedAt: now, fundingUpdatedAt: now, nextFundingAt: fundingDeadline(long, short, now), lastObservation: null,
            worstObservedNetProfit: null, targetReachedAt: null, timedOutAt: null, observations: 0, validObservations: 0, samples: [], close: null };
          observe(position, now); next.positions.unshift(position);
        } else {
          const position = next.positions.find(item => item.id === input.id);
          if (!position) throw fail('持仓记录不存在或已过保留期。', 404);
          if (input.action === 'delete') {
            if (position.status === 'active') throw fail('请先结束观察，再删除记录。');
            next.positions = next.positions.filter(item => item.id !== position.id);
          } else if (input.action === 'update') {
            if (position.status !== 'active') throw fail('已结束记录不可修改。');
            if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)
              || Object.keys(input.changes).some(key => !['settledFunding', 'capital', 'targetNetProfit', 'maxHoldingHours', 'note', 'takerOverrides'].includes(key))) throw fail('只能更新资金费、预算、目标、最长持有时间和备注。');
            const changes = settings({ ...position, ...input.changes });
            if (Object.hasOwn(input.changes, 'settledFunding')) { position.fundingUpdatedAt = now; position.nextFundingAt = fundingDeadline(getQuote(position.longKey), getQuote(position.shortKey), now); }
            if (changes.targetNetProfit !== position.targetNetProfit) position.targetReachedAt = null;
            if (changes.maxHoldingHours !== position.maxHoldingHours) position.timedOutAt = null;
            Object.assign(position, changes, { updatedAt: now });
          } else if (input.action === 'close') {
            if (position.status !== 'active') throw fail('该记录已结束。');
            const close = input.close;
            if (!close || !['realized', 'stop'].includes(close.kind)) throw fail('请选择登记平仓或结束观察。');
            const closedAt = close.closedAt ?? now;
            if (!finite(closedAt) || closedAt < position.openedAt || closedAt > now) throw fail('结束时间须介于开仓与当前时间之间。');
            let pnl = null;
            if (close.kind === 'realized') {
              if (![close.exitLongPrice, close.exitShortPrice].every(positive) || !nonnegative(close.closeFeePaid) || !money(close.settledFunding)) throw fail('平仓价格、平仓费用或已登记资金费无效。');
              pnl = calculatePerpetualPaperPnl({ ...position, settledFunding: close.settledFunding }, close);
              if (!pnl) throw fail('平仓收益计算无效。');
              position.settledFunding = close.settledFunding; position.fundingUpdatedAt = now;
            }
            position.close = { kind: close.kind, closedAt, exitLongPrice: close.kind === 'realized' ? close.exitLongPrice : null, exitShortPrice: close.kind === 'realized' ? close.exitShortPrice : null,
              closeFeePaid: close.kind === 'realized' ? close.closeFeePaid : null, settledFunding: position.settledFunding, pnl };
            position.status = close.kind === 'realized' ? 'closed' : 'stopped'; position.updatedAt = now;
            const stride = Math.max(1, Math.ceil(position.samples.length / (limits.closedSamples - 1)));
            position.samples = position.samples.filter((_, index, points) => index % stride === 0 || index === points.length - 1).slice(-limits.closedSamples);
            prune(next, now);
          } else throw fail('未知持仓操作。');
        }
        next.revision++; await save(next); return view();
      });
    },
    start() { running = true; },
    async stop() { running = false; await queue; },
    healthy: () => !storageError,
    metrics: () => ({ ...metrics, active: state.positions.filter(item => item.status === 'active').length, closed: state.positions.filter(item => item.status !== 'active').length,
      samplePoints: state.positions.reduce((sum, item) => sum + item.samples.length, 0), storageError: storageError || unavailableReason }),
  };
}
