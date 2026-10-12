import { randomUUID, createHash } from 'node:crypto';
import { AppError, partialFill, validateBooks, notionalUSDT, settlement, convert, storedNotional } from './model.mjs';
import { D } from './money.mjs';
import { fundingLedger } from './funding.mjs';

const done = e => ['completed', 'cancelled'].includes(e.state);
const qty = (p, leg) => D(p[`${leg}Quantity`] ?? p[`${leg}Fill`]?.quantity ?? p.quantity);
const target = p => p.quantityExact ?? p.quantity;
export function markedPnl(p, result) {
  const realized = D(p.realizedGross ?? 0), paid = D(p.paidExitFees ?? 0);
  const net = D(result.exact?.net ?? result.net).plus(realized).minus(paid);
  const gross = D(result.exact?.gross ?? result.gross).plus(realized), exitFees = D(result.exact?.exitFees ?? result.exitFees).plus(paid);
  const fxImpact = result.fxImpact === null || p.realizedFxImpact === null ? null : D(result.fxImpact ?? 0).plus(p.realizedFxImpact ?? 0).toNumber();
  return { ...result, gross: gross.toNumber(), exitFees: exitFees.toNumber(), net: net.toNumber(), priceOnlyNet: net.toNumber(), fxImpact, grossAtEntryFx: fxImpact === null ? null : gross.minus(fxImpact).toNumber(), exact: { ...result.exact, gross: gross.toString(), exitFees: exitFees.toString(), net: net.toString(), priceOnlyNet: net.toString() } };
}

// Only local simulation receipts are produced here. There is no exchange order transport.
export function createExecutionRunner(store, { clock, depthReader, fxReader, checkIdentity, checkEntry, calculate }) {
  function create(p, kind, c, reason = '') {
    const at = clock();
    const e = { id: randomUUID(), positionId: p.id, base: p.base, kind, reason, state: 'queued',
      scenario: c.executionScenario, seed: c.executionSeed, delayMs: c.executionDelayMs,
      clipNotional: c.clipNotional, partialFillPct: c.partialFillPct, repairAttempts: c.repairAttempts,
      createdAt: at, updatedAt: at, nextAt: at + c.executionDelayMs, attempts: 0,
      targetQuantity: p.quantity, targetQuantityExact: String(target(p)), longQuantity: qty(p, 'long').toNumber(), shortQuantity: qty(p, 'short').toNumber(),
      reservedNotional: kind === 'open' ? c.notionalPerLeg * 2 : 0, limitPerLeg: c.notionalPerLeg,
      repairCost: 0, orders: [], fills: [], unhedgedSince: null, maxUnhedgedMs: 0 };
    p.executionId = e.id;
    store.saveExecution(e); store.savePosition(p);
    return e;
  }
  function update(e, p) {
    const at = clock(); e.updatedAt = at; e.nextAt = at + e.delayMs;
    e.longQuantity = qty(p, 'long').toNumber(); e.shortQuantity = qty(p, 'short').toNumber();
    if (!qty(p, 'long').eq(qty(p, 'short'))) e.unhedgedSince ??= at;
    else { if (e.unhedgedSince !== null) e.maxUnhedgedMs = Math.max(e.maxUnhedgedMs, at - e.unhedgedSince); e.unhedgedSince = null; }
    e.reservedNotional = e.kind === 'open' && !done(e) ? Math.max(0, e.limitPerLeg * 2 - storedNotional(p.longFill) - storedNotional(p.shortFill)) : 0;
    store.savePosition(p); store.saveExecution(e);
  }
  function finish(e, p, cancelled = false) {
    e.state = cancelled ? 'cancelled' : 'completed'; e.error = null;
    if (cancelled) for (const order of e.orders) if (!['FILLED', 'REJECTED'].includes(order.state)) order.state = 'CANCELLED';
    if (qty(p, 'long').isZero() && qty(p, 'short').isZero()) {
      p.status = 'closed'; p.closedAt = clock(); p.reason = cancelled ? '撤销模拟任务，已成交部分另行处理' : e.reason || '分阶段模拟平仓';
      p.result = calculate(p, null, null, null); p.result.netWithFunding = null;
      p.funding = fundingLedger(p, p.fundingReports, p.closedAt);
      p.fundingPnl = p.funding.confirmed;
      if (p.funding.status === 'complete') p.result.netWithFunding = D(p.result.net).plus(p.funding.confirmed).toNumber();
    }
    update(e, p);
    store.event(clock(), `${p.base} 模拟${e.kind === 'open' ? '开仓' : '平仓'}任务${cancelled ? '已撤销' : '已完成'}${e.unhedgedSince !== null ? '；仍有单腿敞口，请继续处理持仓' : ''}`);
  }
  function applyReceipt(e, p, order) {
    // Position, booked flag and operation receipt are committed together. Restart cannot book twice.
    const r = order.receipt, leg = order.leg, f = r.fill, amount = D(f.exact.quantity);
    const feeRate = p.feeSnapshot?.[leg]?.[e.kind === 'open' ? 'entry' : 'exit']?.bps ?? p.feeBps;
    const usd = D(notionalUSDT(p[leg], f.notional, r.fx, r.at));
    const fee = usd.mul(feeRate).div(10000);
    if (e.kind === 'open') {
      const old = p[`${leg}Fill`], total = qty(p, leg).plus(amount);
      const native = D(old.exact?.notional ?? old.notional).plus(f.exact.notional);
      p[`${leg}Fill`] = { quantity: total.toNumber(), price: native.div(total).toNumber(), notional: native.toNumber(), notionalUSDT: D(old.notionalUSDT ?? 0).plus(usd).toNumber(), exact: { quantity: total.toString(), price: native.div(total).toString(), notional: native.toString() } };
      p[`${leg}Quantity`] = total.toString(); p.entryFeesExact = D(p.entryFeesExact ?? p.entryFees).plus(fee).toString(); p.entryFees = Number(p.entryFeesExact);
    } else {
      const native = D(f.exact.notional).minus(D(p[`${leg}Fill`].exact?.price ?? p[`${leg}Fill`].price).mul(amount)).mul(leg === 'long' ? 1 : -1);
      const gross = convert(native.toNumber(), settlement(p[leg]), r.fx, r.at);
      p.realizedGross = D(p.realizedGross ?? 0).plus(gross).toString(); p.paidExitFees = D(p.paidExitFees ?? 0).plus(fee).toString();
      try { const reference = convert(native.toNumber(), settlement(p[leg]), p.entryFx, p.openedAt); if (p.realizedFxImpact !== null) p.realizedFxImpact = D(p.realizedFxImpact ?? 0).plus(D(gross).minus(reference)).toString(); } catch { p.realizedFxImpact = null; }
      p[`${leg}Quantity`] = qty(p, leg).minus(amount).toString();
    }
    p.quantityHistory ??= [];
    p.quantityHistory.push({ at: r.at, longQuantity: qty(p, 'long').toString(), shortQuantity: qty(p, 'short').toString(), fx: r.fx });
    if (p.exitQuote) p.exitQuote = { ...p.exitQuote, stale: true, net: null, priceOnlyNet: null, reason: '成交数量已变化，等待新的退出深度估值' };
    const fillId = `${order.id}:${order.filledQuantityExact ?? order.filledQuantity}`;
    order.filledQuantityExact = D(order.filledQuantityExact ?? order.filledQuantity).plus(amount).toString(); order.filledQuantity = Number(order.filledQuantityExact);
    order.state = D(order.filledQuantityExact).eq(order.quantityExact ?? order.quantity) ? 'FILLED' : 'PARTIAL'; order.booked = true; order.price = f.price;
    const fill = { id: fillId, leg, side: order.side, quantity: amount.toNumber(), price: f.price, notional: usd.toNumber(), fee: fee.toNumber(), at: r.at, kind: e.kind === 'close' ? 'exit' : e.repairing ? 'repair' : 'entry' };
    e.fills.push(fill);
    if (e.repairing) {
      const adverse = D(f.price).minus(e.referencePrices?.[leg] ?? f.price).mul(order.side === 'buy' ? 1 : -1).mul(amount);
      const slippage = adverse.gt(0) ? notionalUSDT(p[leg], adverse.toNumber(), r.fx, r.at) : 0;
      e.repairFees = D(e.repairFees ?? 0).plus(fee).toNumber(); e.repairSlippage = D(e.repairSlippage ?? 0).plus(slippage).toNumber();
      e.repairCost = D(e.repairFees).plus(e.repairSlippage).toNumber();
    }
    e.attempts = 0; e.error = null; e.state = e.repairing ? 'repairing' : 'executing';
    // Receipts remain as the auditable source of truth, with a bounded order count.
    if (e.orders.length >= 2000) { e.state = 'blocked'; e.error = '任务达到 2000 笔分片上限，请撤销后平仓'; }
    update(e, p);
  }
  function confirmCancel(e, p) {
    if (e.scenario === 'cancel-reject' && !e.cancelRejected) {
      e.cancelRejected = true; e.state = 'blocked'; e.error = '情景注入：撤销失败，保留成交与敞口，等待重试撤销';
      update(e, p); store.event(clock(), `${p.base} ${e.error}`); return;
    }
    finish(e, p, true);
  }
  async function advance(id) {
    const e = store.findExecution(id); if (!e || done(e) || e.nextAt > clock()) return;
    const p = store.findPosition(e.positionId); if (!p || p.status !== 'open') return;
    const pending = e.orders.find(o => o.receipt && !o.booked);
    if (pending) {
      if (pending.state === 'UNKNOWN') { pending.state = 'PENDING_SUBMIT'; store.transaction(() => update(e, p)); return; }
      store.transaction(() => { applyReceipt(e, p, pending); if (e.cancelRequested) confirmCancel(e, p); });
      return;
    }
    if (e.state === 'blocked') return;
    if (e.cancelRequested) { store.transaction(() => confirmCancel(e, p)); return; }
    const complete = e.kind === 'open' ? ['long', 'short'].every(l => qty(p, l).eq(target(p))) : ['long', 'short'].every(l => qty(p, l).isZero());
    if (complete) { store.transaction(() => finish(e, p)); return; }
    if (e.automatic && !store.config().enabled) return;
    try {
      if (e.kind === 'open') await checkEntry(p);
      checkIdentity(p);
      const [books, fx] = await Promise.all([Promise.all([p.long, p.short].map(depthReader)), [p.long, p.short].every(q => settlement(q) === 'USDT') ? null : fxReader()]);
      if (e.kind === 'open') await checkEntry(p);
      checkIdentity(p); validateBooks(books, clock());
      const remaining = leg => e.kind === 'open' ? D(target(p)).minus(qty(p, leg)) : qty(p, leg);
      const leg = remaining('long').gte(remaining('short')) ? 'long' : 'short', i = leg === 'long' ? 0 : 1;
      const side = (leg === 'long') === (e.kind === 'open') ? 'buy' : 'sell';
      const levels = side === 'buy' ? books[i].asks : books[i].bids;
      e.referencePrices ??= { long: e.kind === 'open' ? books[0].asks[0][0] : books[0].bids[0][0], short: e.kind === 'open' ? books[1].bids[0][0] : books[1].asks[0][0] };
      const rule = p.executionRules?.[i], lot = D(rule?.lot_size ?? '0.00000001');
      const min = D(rule?.min_size ?? lot), minNotional = D(rule?.min_notional ?? 0);
      const reference = notionalUSDT(p[leg], levels[0][0], fx, clock());
      let amount = D(e.clipNotional).div(reference).div(lot).floor().mul(lot);
      if (amount.lt(min)) amount = min.div(lot).ceil().mul(lot);
      const minimumForNotional = minNotional.div(levels[0][0]).div(lot).ceil().mul(lot);
      if (amount.lt(minimumForNotional)) amount = minimumForNotional;
      const minimum = min.gt(minimumForNotional) ? min : minimumForNotional;
      const continuing = e.orders.find(o => o.leg === leg && o.state === 'PARTIAL');
      if (!continuing && remaining(leg).lt(minimum)) throw new AppError('剩余数量低于目录最小数量或名义额，保留敞口等待人工处理');
      if (amount.gt(remaining(leg))) amount = remaining(leg);
      if (remaining(leg).gt(amount) && remaining(leg).minus(amount).lt(minimum)) amount = remaining(leg);
      if (continuing) amount = D(continuing.quantityExact ?? continuing.quantity).minus(continuing.filledQuantityExact ?? continuing.filledQuantity);
      const attempt = e.orders.filter(o => o.leg === leg).length;
      const order = continuing ?? { id: `${e.id}:${e.orders.length}`, leg, side, state: 'PENDING_SUBMIT', quantity: amount.toNumber(), quantityExact: amount.toString(), filledQuantity: 0, filledQuantityExact: '0', at: clock() };
      // Fixed inputs give reproducible scenarios independent of random local task IDs.
      const draw = createHash('sha256').update(`${e.seed}:${p.base}:${e.kind}:${leg}:${attempt}:${order.filledQuantity}`).digest().readUInt32BE(0) / 0x100000000;
      if (e.scenario === 'reject-short' && leg === 'short' && attempt === 0) {
        order.state = 'REJECTED'; e.orders.push(order); e.repairing = true; throw new AppError('情景注入：空腿拒单，等待补腿');
      }
      let requested = amount;
      if (e.scenario === 'partial' && draw < 0.85) {
        requested = amount.mul(e.partialFillPct).div(100).div(lot).floor().mul(lot);
        if (requested.lt(lot)) requested = lot;
      }
      let filled = partialFill(levels, requested, side, p.slippageBps);
      const rounded = D(filled.exact.quantity).div(lot).floor().mul(lot);
      if (rounded.isZero()) throw new AppError('当前深度不足一个最小数量单位');
      filled = partialFill(levels, rounded, side, p.slippageBps);
      // A partial fill may be smaller than the order minimum; the submitted order may not.
      if (e.kind === 'open' && D(p[`${leg}Fill`].notionalUSDT ?? 0).plus(notionalUSDT(p[leg], filled.notional, fx, clock())).gt(e.limitPerLeg)) throw new AppError('分片成交将超过预留单腿额度，需撤销或处理已有持仓');
      filled.requestedQuantity = amount.toNumber(); filled.remaining = amount.minus(filled.exact.quantity).toNumber();
      order.receipt = { fill: filled, fx, at: clock() };
      order.booked = false; order.state = 'PENDING_SUBMIT';
      if (e.scenario === 'unknown-short' && leg === 'short' && attempt === 0) order.state = 'UNKNOWN';
      if (!continuing) e.orders.push(order); e.state = e.repairing ? 'repairing' : 'executing';
      store.transaction(() => update(e, p));
    } catch (error) {
      e.attempts++; e.repairing = true; e.state = e.attempts >= e.repairAttempts ? 'blocked' : 'repairing';
      e.error = error instanceof AppError ? error.message : '独立深度读取失败，等待重试';
      store.transaction(() => { update(e, p); store.event(clock(), `${p.base} 模拟任务：${e.error}`); });
    }
  }
  function action(id, action) {
    const e = store.findExecution(id); if (!e || done(e)) throw new AppError('任务已结束或不存在', 409);
    const p = store.findPosition(e.positionId);
    if (action === 'cancel') { e.cancelRequested = true; e.state = 'cancel_pending'; e.nextAt = clock() + (e.scenario === 'cancel-delay' ? Math.max(1000, e.delayMs * 3) : e.delayMs); }
    else if (action === 'retry' && e.state === 'blocked') { e.attempts = 0; e.state = 'repairing'; e.nextAt = clock(); e.error = null; }
    else throw new AppError('当前任务不支持此操作', 409);
    e.updatedAt = clock(); store.saveExecution(e); store.event(clock(), `${p.base} 模拟任务${action === 'cancel' ? '等待撤销及成交对账' : '开始重试'}`); return e;
  }
  return { create, advance, action, active: () => store.executions(true) };
}
