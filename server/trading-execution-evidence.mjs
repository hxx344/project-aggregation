import { createStatementCache } from './db-cache.mjs';
import { decimal, addDecimals, compareDecimals } from './trading-decimal.mjs';

const text = value => typeof value === 'string' && value.length <= 200 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = value => text(value) && Number.isFinite(Date.parse(value)) ? value : null;
const amount = value => { try { return value == null ? null : decimal(value); } catch { return null; } };
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const SCALE = 10n ** 18n;
const units = value => { const [a, b = ''] = value.split('.'); return BigInt(a) * SCALE + BigInt(b.padEnd(18, '0')); };
const render = value => `${value / SCALE}.${String(value % SCALE).padStart(18, '0')}`.replace(/0+$/, '').replace(/\.$/, '');

/** Existing, account-verified attribution is the only admission proof. Never infer a pair from time. */
export function reductionCosts(job, data, orders = []) {
  if (job.plan?.market !== 'anthropic' || job.plan.action !== 'close' || !['completed', 'stopped'].includes(job.status)) return null;
  const batches = new Map(), seen = new Map(); let conflicts = 0;
  for (const source of data?.sources ?? []) for (const exchange of source.data?.exchanges ?? []) for (const account of exchange.accounts ?? []) {
    for (const scope of account.scopes ?? []) for (const fill of scope.fills ?? []) {
      if (fill.execution?.jobId !== job.id || count(fill.execution.phase) === null || count(fill.execution.batch) === null) continue;
      const identity = JSON.stringify([job.id, exchange.id, fill.symbol, fill.orderId, fill.id]);
      const signature = JSON.stringify([fill.orderId, fill.time, fill.quantity, fill.price, fill.priceCurrency, fill.fee, fill.feeCurrency, fill.execution]);
      if (seen.has(identity)) { if (seen.get(identity) !== signature) conflicts++; continue; }
      seen.set(identity, signature);
      const key = `${fill.execution.phase}:${fill.execution.batch}`;
      const batch = batches.get(key) ?? { phase: fill.execution.phase, batch: fill.execution.batch, legs: new Map() };
      const legKey = JSON.stringify([exchange.id, fill.symbol]);
      const leg = batch.legs.get(legKey) ?? { exchange: text(exchange.id), symbol: text(fill.symbol), fills: [], coverage: {
        start: time(scope.coverageStart), end: time(scope.coverageEnd), status: text(scope.status), truncated: scope.truncated === true } };
      leg.fills.push({ id: text(fill.id), orderId: text(fill.orderId), time: time(fill.time), quantity: amount(fill.quantity), price: amount(fill.price),
        priceCurrency: text(fill.priceCurrency), fee: amount(fill.fee), feeCurrency: text(fill.feeCurrency) });
      batch.legs.set(legKey, leg); batches.set(key, batch);
    }
  }
  const rows = [...batches.values()].sort((a, b) => a.phase - b.phase || a.batch - b.batch).map(batch => {
    const legs = [...batch.legs.values()].map(leg => {
      const currencies = new Set(leg.fills.map(fill => fill.priceCurrency));
      const valid = leg.fills.every(fill => fill.quantity !== null && fill.price !== null && compareDecimals(fill.quantity, '0') > 0 && compareDecimals(fill.price, '0') > 0);
      const quantity = valid ? addDecimals(leg.fills.map(fill => fill.quantity)) : null;
      const averagePrice = valid && currencies.size === 1 && !currencies.has(null)
        ? render(leg.fills.reduce((sum, fill) => sum + units(fill.quantity) * units(fill.price), 0n) / units(quantity)) : null;
      const fees = new Map(); let feesComplete = true;
      for (const fill of leg.fills) {
        if (fill.fee === null || !fill.feeCurrency) feesComplete = false;
        else fees.set(fill.feeCurrency, addDecimals([fees.get(fill.feeCurrency) ?? '0', fill.fee]));
      }
      const times = leg.fills.map(fill => fill.time === null ? null : Date.parse(fill.time));
      const expected = orders.filter(order => order.exchange === leg.exchange && (order.instrumentId ?? order.symbol) === leg.symbol
        && order.phase === batch.phase && order.batch === batch.batch);
      const coverageComplete = expected.length > 0 && !leg.coverage.truncated && ['live', 'ready'].includes(leg.coverage.status)
        && expected.every(order => !order.unknown && order.settled && order.remoteId && order.filledQuantity !== null
          && leg.coverage.start && leg.coverage.end && order.createdAt && order.lastCheckedAt
          && Date.parse(leg.coverage.start) <= Date.parse(order.createdAt) && Date.parse(leg.coverage.end) >= Date.parse(order.lastCheckedAt)
          && leg.fills.filter(fill => fill.orderId === order.remoteId).every(fill => fill.quantity !== null)
          && compareDecimals(addDecimals(leg.fills.filter(fill => fill.orderId === order.remoteId).map(fill => fill.quantity)), order.filledQuantity) === 0);
      return { ...leg, quantity, averagePrice, priceCurrency: currencies.size === 1 ? [...currencies][0] : null,
        fees: [...fees].map(([currency, value]) => ({ currency, value })), feesComplete: feesComplete && coverageComplete, observedFeesComplete: feesComplete, coverageComplete,
        lastFillAt: times.every(value => value !== null) ? new Date(Math.max(...times)).toISOString() : null,
        slippage: null, slippageReason: '未持久化本批触发盘口，无法计算滑点；未跨币种换算', fillCount: leg.fills.length,
        fills: leg.fills.slice(0, 200), evidenceTruncated: leg.fills.length > 200 };
    });
    return { phase: batch.phase, batch: batch.batch, legs,
      completionGapMs: legs.length === 2 && legs.every(leg => leg.lastFillAt !== null)
        ? Math.abs(Date.parse(legs[0].lastFillAt) - Date.parse(legs[1].lastFillAt)) : null };
  });
  return { source: 'verified-fill-cache', generatedAt: time(data?.generatedAt),
    note: '仅当前缓存内、通过账户与订单核验的成交；时差为最后可见成交时间差，历史不完整时不能证明双腿完成时差。',
    conflicts, batches: conflicts ? [] : rows.slice(0, 200), truncated: rows.length > 200,
    gaps: [...(!data ? ['尚未取得成交缓存证据'] : []), ...(conflicts ? ['同一成交存在冲突，成本汇总不可计算'] : []),
      ...(!rows.length ? ['没有可核对的已关联成交'] : []), '触发盘口未保留，滑点不可计算'] };
}

/** Strict scalar whitelist: no recursive copy of plans, payloads, credentials or arbitrary error text. */
export function createExecutionEvidence({ db, stmt = createStatementCache(db), now = Date.now, readFills = () => null, readOperations = () => null }) {
  return async function exportJob(jobId) {
    if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId)) return null;
    const job = parse(stmt.prepare('SELECT json FROM execution_jobs WHERE id=?').get(jobId)?.json);
    if (!job || job.id !== jobId) return null;
    const raw = stmt.prepare('SELECT json FROM execution_orders WHERE job_id=? ORDER BY rowid LIMIT 4001').all(jobId);
    const orders = raw.slice(0, 4000).map(row => parse(row.json)).filter(order => order?.jobId === jobId).map(order => ({
      localId: text(order.localId), remoteId: text(order.remoteId), legId: text(order.legId), exchange: text(order.exchange),
      phase: count(order.phase), batch: count(order.batch), symbol: text(order.spec?.symbol), instrumentId: text(order.spec?.instrumentId), side: text(order.spec?.side),
      quantity: amount(order.spec?.quantity), filledQuantity: order.unknown ? null : amount(order.filledQuantity),
      lastKnownFilledQuantity: amount(order.filledQuantity), state: text(order.state), unknown: order.unknown === true, settled: order.settled === true,
      createdAt: time(order.createdAt), lastCheckedAt: time(order.lastCheckedAt), cancelRequestedAt: time(order.cancelRequestedAt),
      amendCount: count(order.amendCount), cancelAttempt: count(order.cancelAttempt),
      operation: order.writerOperation ? { id: text(order.writerOperation.operationId), action: text(order.writerOperation.action), state: text(order.writerOperation.state) } : null,
    }));
    const events = (Array.isArray(job.events) ? job.events : []).slice(-200).map((event, index) => ({ sequence: index, time: time(event.time),
      // Runtime messages may embed upstream values; carry time and severity, not free-form text.
      level: ['info', 'warning', 'error'].includes(event.level) ? event.level : null }));
    let shared = null;
    try { shared = await readOperations(jobId, orders.map(order => order.localId).filter(Boolean)); } catch { /* Missing or replaced shared registry is an explicit evidence gap. */ }
    const attempts = (Array.isArray(shared?.attempts) ? shared.attempts : []).slice(0, 4000).map(row => ({ operationId: text(row.operationId),
      state: text(row.state), groupId: text(row.groupId), action: text(row.action), createdAt: count(row.createdAt), updatedAt: count(row.updatedAt) }));
    return { version: 1, exportedAt: new Date(now()).toISOString(), job: { id: jobId, market: text(job.plan?.market), action: text(job.plan?.action),
      status: text(job.status), phase: count(job.phase), batchIndex: count(job.batchIndex), createdAt: time(job.createdAt), updatedAt: time(job.updatedAt) },
      orders, events, attempts, attemptCoverage: shared?.available ? { candidateLimit: count(shared.candidateLimit), scannedCandidates: count(shared.scannedCandidates), ordersVisited: count(shared.ordersVisited), truncated: shared.truncated === true } : null,
      costs: reductionCosts(job, await readFills(), orders),
      gaps: ['仅导出本地保留的最近事件；共享操作保留其最后结算状态，无法还原已覆盖的中间观察', '自由文本、账户身份、凭据和签名载荷未导出',
        ...(!shared?.available ? ['共享操作历史不可用，仅有本地订单最后一次操作'] : []), ...(shared?.truncated ? ['共享操作候选或输出达到预算，证据已截断；未扫描部分不代表没有操作'] : []),
        ...(raw.length > 4000 ? ['委托超过 4000 条，导出已截断'] : []), ...(!orders.length ? ['没有保留的委托记录'] : [])] };
  };
}
