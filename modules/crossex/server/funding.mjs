import { D } from './money.mjs';
import { settlement } from './model.mjs';

const HOUR = 3_600_000;
function number(value, nonnegative = false) {
  try { if (!['number', 'string'].includes(typeof value) || String(value).length > 100 || String(value).trim() === '') return null; const result = D(value); return nonnegative && result.lt(0) ? null : result; } catch { return null; }
}
const finiteTime = value => Number.isSafeInteger(value) && value >= 1e12;
function historicalFx(position, history, currency, at, amount, allowOld = false) {
  if (currency === 'USDT' || amount.isZero()) return D(1);
  const samples = [{ at: position.openedAt, fx: position.entryFx }, ...history].filter(row => row.at <= at && row.fx?.baseCurrency === 'USDT');
  let selected = null;
  for (const sample of samples) {
    const row = sample.fx.rates?.[currency], age = Math.min(180_000, sample.fx.staleAfterMs ?? 0);
    const bid = number(row?.bid), ask = number(row?.ask);
    if (!row || !finiteTime(row.at) || row.at > at || !bid?.gt(0) || !ask?.gte(bid) || typeof row.source !== 'string' || !row.source) continue;
    if (!allowOld && (!(age > 0) || at - row.at > age)) continue;
    if (!selected || row.at > selected.at) selected = { at: row.at, value: amount.gte(0) ? bid : ask };
  }
  return selected?.value ?? null;
}
function quantityAt(history, leg, at, before = true) {
  let quantity = D(0);
  for (const row of history) if (before ? row.at < at : row.at <= at) quantity = number(row[`${leg}Quantity`], true); else break;
  return quantity;
}

/**
 * Recompute, never increment, a deterministic public-data paper ledger.
 * Point settlements use (openedAt, closedAt]; an event at the settlement timestamp
 * takes effect immediately after that settlement. Kraken accruals integrate held time.
 * `known` is the confirmed subset, `confirmed` is null unless the whole range is exact.
 * `estimated` is a whole-range known+estimated total, never a missing-data-as-zero total.
 */
export function fundingLedger(position, reports = {}, now = Date.now()) {
  const result = { status: 'unknown', confirmed: null, known: 0, estimated: null, entries: [], through: null, current: { long: reports.long?.current ?? null, short: reports.short?.current ?? null } };
  if ((position.accountingVersion ?? 1) < 3) return { ...result, status: 'legacy', reason: '旧版模拟记录未采集完整资金费依据，保留原收益口径' };
  const end = Math.min(now, position.closedAt ?? now);
  if (!finiteTime(position.openedAt) || !finiteTime(end) || end < position.openedAt) return { ...result, reason: '持仓资金费时间范围无效' };
  const history = Array.isArray(position.quantityHistory) && position.quantityHistory.length
    ? position.quantityHistory.map(row => ({ ...row }))
    : [{ at: position.openedAt, longQuantity: String(position.quantity ?? ''), shortQuantity: String(position.quantity ?? ''), fx: position.entryFx }];
  if (history.length > 50_000 || history.some((row, i) => !finiteTime(row.at) || row.at < position.openedAt || i && row.at < history[i - 1].at || number(row.longQuantity, true) === null || number(row.shortQuantity, true) === null)) return { ...result, reason: '模拟成交数量历史不完整或无效' };
  if (end === position.openedAt) return { ...result, status: 'complete', confirmed: 0, estimated: 0, through: end };
  let covered = true, exact = true, canEstimate = true, known = D(0), estimated = D(0), through = end;
  const reasons = new Set(), seen = new Map();
  function add(leg, row, at, quantity, duration = null, accrualStart = null, pending = false) {
    if (!quantity?.gt(0)) return;
    const rate = number(row.rate), currency = settlement(position[leg]);
    if (rate === null || !['rate', 'per_base'].includes(row.unit)) { covered = false; reasons.add('结算费率或单位无效'); return; }
    const key = `${position.id}:${leg}:${accrualStart === null ? at : `${accrualStart}:${at}`}`;
    const signature = JSON.stringify([row.rate, row.unit, row.markPrice, quantity.toString(), duration]);
    if (seen.has(key)) { if (seen.get(key) !== signature) { covered = false; reasons.add('同一结算数据冲突'); } return; }
    seen.set(key, signature);
    const sign = leg === 'long' ? -1 : 1, mark = number(row.markPrice);
    let amount = row.unit === 'per_base' || rate.isZero() ? quantity.times(rate).times(sign)
      : mark?.gt(0) ? quantity.times(mark).times(rate).times(sign) : null;
    if (amount && duration !== null) amount = amount.times(duration).div(HOUR);
    let estimate = amount;
    if (!estimate) {
      const entry = number(position[`${leg}Fill`]?.price);
      if (entry?.gt(0)) { estimate = quantity.times(entry).times(rate).times(sign); if (duration !== null) estimate = estimate.times(duration).div(HOUR); }
    }
    const fx = amount ? historicalFx(position, history, currency, at, amount) : null;
    const amountUSDT = amount && fx && !pending ? amount.times(fx) : null;
    const estimateFx = estimate ? historicalFx(position, history, currency, at, estimate, true) : null;
    const estimateUSDT = amountUSDT === null && estimate && estimateFx ? estimate.times(estimateFx) : null;
    let quality = amountUSDT !== null ? 'confirmed' : pending ? 'accrued_unsettled' : amount === null ? fx ? 'estimated_price' : currency === 'USDT' ? 'estimated_price' : 'estimated_price_and_fx' : 'estimated_fx';
    if (amountUSDT === null && estimateUSDT === null) quality = 'unknown';
    const entry = { key, leg, at, rate: rate.toString(), unit: row.unit, quantity: quantity.toString(), amountNative: amount?.toString() ?? null, currency, amountUSDT: amountUSDT?.toString() ?? null, estimateUSDT: estimateUSDT?.toString() ?? null, quality, source: row.source || '', ...(accrualStart !== null ? { accrualStart, durationMs: duration } : {}) };
    result.entries.push(entry);
    if (amountUSDT !== null) { known = known.plus(amountUSDT); estimated = estimated.plus(amountUSDT); }
    else { exact = false; if (estimateUSDT !== null) estimated = estimated.plus(estimateUSDT); else canEstimate = false; }
  }
  for (const leg of ['long', 'short']) {
    const report = reports[leg], quote = position[leg];
    if (!report || report.exchange !== quote?.exchange || report.symbol !== quote?.symbol || !Array.isArray(report.settlements)) {
      covered = false; through = null; reasons.add(`${leg === 'long' ? '多' : '空'}腿资金费历史未取得`); continue;
    }
    if (!report.complete || !finiteTime(report.coveredFrom) || !finiteTime(report.coveredTo) || report.coveredFrom > position.openedAt || report.coveredTo < end || report.coveredTo > now) { covered = false; reasons.add(report.error || '资金费历史覆盖不足'); }
    if (through !== null) through = finiteTime(report.coveredFrom) && report.coveredFrom <= position.openedAt && finiteTime(report.coveredTo) ? Math.min(through, report.coveredTo) : null;
    if (quote.exchange === 'kraken') {
      const periods = Array.isArray(report.accruals) ? report.accruals : report.settlements.filter(row => row.accrualStart !== undefined);
      let periodThrough = position.openedAt;
      for (const row of [...periods].sort((a, b) => a.accrualStart - b.accrualStart)) {
        if (!finiteTime(row.accrualStart) || !finiteTime(row.accrualEnd) || row.accrualEnd - row.accrualStart !== HOUR || row.unit !== 'per_base') { covered = false; reasons.add('Kraken 原生小时累计区间无效'); continue; }
        const start = Math.max(position.openedAt, row.accrualStart), finish = Math.min(end, row.accrualEnd);
        if (finish <= start) continue;
        if (start > periodThrough) { covered = false; reasons.add('Kraken 连续资金费缺少小时费率'); }
        periodThrough = Math.max(periodThrough, finish);
        const changes = history.filter(item => item.at > start && !quantityAt(history, leg, item.at).eq(item[`${leg}Quantity`]));
        const breaks = [...new Set([...changes.filter(item => item.at < finish).map(item => item.at), finish])].sort((a, b) => a - b);
        let segment = start;
        for (const at of breaks) {
          const pending = at === end && end < row.accrualEnd && (!position.closedAt || position.closedAt > end) && !changes.some(item => item.at === at);
          add(leg, row, at, quantityAt(history, leg, segment, false), at - segment, segment, pending); segment = at;
        }
      }
      if (periodThrough < end) { covered = false; reasons.add('Kraken 连续资金费覆盖不完整'); }
    } else {
      if (report.settlements.length > 50_000) { covered = false; reasons.add('资金费历史过大'); continue; }
      for (const row of report.settlements) {
        if (!finiteTime(row.at)) { covered = false; reasons.add('资金费结算时间无效'); continue; }
        if (row.at <= position.openedAt || row.at > end) continue;
        // These venues settle on index/oracle prices; a mark price cannot prove the cash flow.
        add(leg, ['hyperliquid', 'lighter'].includes(quote.exchange) ? { ...row, markPrice: null } : row, row.at, quantityAt(history, leg, row.at));
      }
    }
  }
  result.entries.sort((a, b) => a.at - b.at || a.leg.localeCompare(b.leg));
  result.known = known.toNumber(); result.through = through;
  result.confirmed = covered && exact ? result.known : null;
  result.estimated = covered && canEstimate ? estimated.toNumber() : null;
  result.status = result.confirmed !== null ? 'complete' : result.entries.length ? 'partial' : 'unknown';
  if (!exact) reasons.add('缺少结算定价、当时汇率，或含尚未结算累计；预估不计入确认收益');
  if (reasons.size) result.reason = [...reasons].join('；');
  return result;
}
