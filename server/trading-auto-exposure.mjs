import { createHash } from 'node:crypto';
import { addDecimals, compareDecimals, decimal } from './trading-decimal.mjs';
import { equalQuantity, ExecutionError, normalizeMarket, notional, QUOTE_MAX_AGE, subtract } from './trading-execution-plan.mjs';
import { intentFor } from './trading-auto.mjs';

const iso = time => new Date(time).toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const amount = value => { try { return decimal(value, { nonnegative: true }); } catch { return null; } };
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= QUOTE_MAX_AGE && Date.parse(at) - now <= 1000;
const contract = (exchange, symbol, rule) => {
  if (!rule || exchange === 'okx' && (!rule.instrumentId || !rule.contractSize || rule.quantityUnit !== '张')) return null;
  return { instrumentId: rule.instrumentId ?? symbol, unit: rule.quantityUnit ?? (['CLUSDT', 'BZUSDT'].includes(symbol) ? '桶' : '合约单位'),
    contractSize: decimal(rule.contractSize ?? '1', { positive: true }), quoteAsset: rule.quoteAsset ?? 'USDT', quantityStep: rule.quantityStep };
};
const sameContract = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b);
const emptyTotal = () => ({ values: [], unknownCount: 0 });
const total = (value, market, meta) => {
  const knownQuantity = addDecimals(value.values), quantity = value.unknownCount ? null : knownQuantity;
  return { quantity, knownQuantity, unknownCount: value.unknownCount, notional: quantity !== null && market && meta ? notional(quantity, market.bid, meta.contractSize) : null };
};

/** Pure projection. Values are never netted across sides or added across columns. */
export function projectAutoExposure(snapshot, evidence, now = Date.now()) {
  const groups = new Map(), current = new Map(), rules = snapshot.rules, globalGaps = [];
  if (evidence.jobsChanged) globalGaps.push('读取期间执行任务或委托状态改变，请重新刷新');
  for (const row of evidence.accounts) current.set(row.exchange, row);
  const marketFor = (exchange, symbol) => {
    const row = evidence.markets.find(item => item.exchange === exchange && item.symbol === symbol);
    try { return { market: normalizeMarket(row?.market, symbol, now, exchange), error: null }; }
    catch { return { market: null, error: row?.error ?? '盘口或原生合约元数据缺失、过期或无效' }; }
  };
  const ensure = (leg, historical = null) => {
    const account = current.get(leg.exchange), quote = marketFor(leg.exchange, leg.symbol);
    let meta = null, currentMeta = null;
    try { currentMeta = contract(leg.exchange, leg.symbol, quote.market?.rule); meta = historical?.meta ?? currentMeta; } catch { /* Invalid metadata remains unknown. */ }
    const compatibleMarket = sameContract(meta, currentMeta) ? quote.market : null;
    const identity = historical?.identity ?? account?.identity ?? null;
    const accountKey = identity ? digest([leg.exchange, identity]) : `unverified-${leg.exchange}`;
    const key = JSON.stringify([accountKey, meta?.instrumentId ?? leg.symbol, meta?.unit ?? null, meta?.contractSize ?? null, meta?.quoteAsset ?? null, meta?.quantityStep ?? null, leg.side, historical?.isolated ?? false]);
    if (groups.has(key)) return groups.get(key);
    const isCurrent = !historical?.isolated && !!identity && identity === account?.identity && !account?.error && !evidence.changed.includes(leg.exchange);
    const group = { id: digest(key), exchange: leg.exchange, symbol: leg.symbol, accountKey, accountLabel: identity ? `账户 ${accountKey.slice(0, 8)}` : '账户身份未核验',
      instrumentId: meta?.instrumentId ?? null, unit: meta?.unit ?? '单位未知', contractSize: meta?.contractSize ?? null, quoteAsset: meta?.quoteAsset ?? null,
      side: leg.side, currentAccount: isCurrent, accountAt: isCurrent ? account?.at ?? null : null, quoteAt: compatibleMarket?.at ?? null,
      rules: [], jobs: [], sharedRuleIds: [], gaps: [...globalGaps], target: emptyTotal(), held: emptyTotal(), actual: null,
      orders: { buyQuantity: null, sellQuantity: null, unknownCount: 0, items: [] }, _account: account, _market: compatibleMarket, _meta: meta, _key: key };
    if (!isCurrent) group.gaps.push(historical?.isolated ? '规则记录属于旧账户或旧合约，未读取该历史范围的真实仓位' : account?.error ?? '账户身份缺失或读取期间连接改变');
    if (!meta || quote.error) group.gaps.push(quote.error ?? '原生合约数量单位或乘数无法确认');
    if (historical?.meta && !compatibleMarket) group.gaps.push('记录合约缺少元数据一致的新鲜盘口，名义额未知');
    groups.set(key, group); return group;
  };
  // All configured targets are explicit, including observe/disabled rules. Their
  // enabled/mode fields remain visible; this is not a forecast of future fills.
  for (const rule of rules) {
    const intent = intentFor(rule.config, 'open');
    for (const leg of intent.legs) {
      const group = ensure(leg), row = { id: rule.id, title: rule.title, mode: rule.mode ?? 'live', enabled: !!rule.enabled, observing: !!rule.observing,
        phase: rule.state.phase, quantity: null, heldQuantity: null, waitingFor: [] };
      try {
        if (!group.currentAccount || !group._market || !group._meta) throw new Error('Incomplete evidence');
        row.quantity = equalQuantity(intent, { ...leg, orderSide: leg.side === 'long' ? 'buy' : 'sell' }, group._market);
        group.target.values.push(row.quantity);
      } catch { group.target.unknownCount++; group.gaps.push(`规则「${rule.title}」目标数量无法按当前合约步长换算`); }
      group.rules.push(row);
    }
    for (const held of rule.state.held ?? []) {
      const account = current.get(held.exchange), source = evidence.heldContracts.find(job => job.auto?.ruleId === rule.id);
      const original = source?.legs.find(leg => leg.exchange === held.exchange && leg.symbol === held.symbol && leg.side === held.side);
      const binding = source?.accounts.find(row => row.exchange === held.exchange);
      let oldMeta = null, newMeta = null;
      try { oldMeta = contract(held.exchange, held.symbol, original?.rule); newMeta = contract(held.exchange, held.symbol, marketFor(held.exchange, held.symbol).market?.rule); } catch { /* Explicit gap below. */ }
      const quantity = amount(held.quantity), recorded = amount(original?.filledQuantity);
      const proof = quantity !== null && recorded !== null && compareDecimals(quantity, recorded) === 0 && oldMeta && rule.state.account?.identity
        && binding?.identity === rule.state.account.identity && binding?.revision === rule.state.account.revision;
      const currentBinding = proof && account?.identity === binding.identity && account?.revision === binding.revision && sameContract(oldMeta, newMeta);
      const group = ensure(held, currentBinding ? null : { identity: rule.state.account?.identity ?? null, meta: oldMeta, isolated: true });
      let row = group.rules.find(item => item.id === rule.id);
      if (!row) { row = { id: rule.id, title: rule.title, mode: rule.mode ?? 'live', enabled: !!rule.enabled, observing: !!rule.observing, phase: rule.state.phase, quantity: null, heldQuantity: null, waitingFor: [] }; group.rules.push(row); }
      row.heldQuantity = quantity;
      if (proof) group.held.values.push(quantity);
      else { group.held.unknownCount++; group.gaps.push(`规则「${rule.title}」记录持仓缺少匹配的原开仓账户、成交数量或合约单位证据`); }
      if (!currentBinding) group.gaps.push('记录持仓与当前账户版本或合约元数据不一致，分别展示');
    }
  }
  // Always include the opposite side of every selected contract, so an actual
  // opposite position cannot disappear just because no rule targets that side.
  for (const group of [...groups.values()].filter(row => row.currentAccount)) ensure({ exchange: group.exchange, symbol: group.symbol, side: group.side === 'long' ? 'short' : 'long' });
  for (const group of groups.values()) {
    const account = group._account, data = account?.account, covered = group.currentAccount && fresh(account.at, now) && account.symbols.includes(group.symbol)
      && ['one-way', 'hedge'].includes(data?.modes?.[group.symbol]) && Array.isArray(data.positions);
    if (covered && group._meta && !evidence.jobsChanged) {
      const positions = data.positions.filter(position => position.symbol === group.symbol && position.side === group.side);
      const validPositions = data.positions.filter(position => position.symbol === group.symbol).every(position => ['long', 'short'].includes(position.side) && amount(position.quantity) !== null);
      if (validPositions && positions.length <= 1) group.actual = positions.length ? amount(positions[0].quantity) : '0';
    }
    if (group.actual === null) group.gaps.push('真实仓位范围、身份或时间未完整核验，不能确认零仓');
    const ordersComplete = covered && Array.isArray(data.openOrders) && Array.isArray(data.strategies) && !evidence.jobsChanged;
    if (ordersComplete) {
      const orders = [...data.openOrders.map(order => ({ ...order, kind: 'order' })), ...data.strategies.map(order => ({ ...order, kind: 'strategy' }))].filter(order => order.symbol === group.symbol);
      // Buy/sell represent instruction direction, not net exposure. BOTH orders
      // and strategies without positionSide cannot prove which position they close.
      const selected = orders.filter(order => order.positionSide === 'LONG' ? group.side === 'long' : order.positionSide === 'SHORT' ? group.side === 'short' : true);
      for (const order of selected) {
        const quantity = amount(order.quantity), filled = amount(order.filledQuantity);
        const remaining = !order.unknown && quantity !== null && filled !== null && compareDecimals(filled, quantity) <= 0 ? subtract(quantity, filled) : null;
        const unassigned = !['LONG', 'SHORT'].includes(order.positionSide);
        const uncertain = unassigned || remaining === null || !['buy', 'sell'].includes(order.side) || order.kind === 'strategy';
        if (unassigned) group.gaps.push('委托多空归属未确认；两方向明细为同一未归属委托，不能相加');
        if (uncertain) group.orders.unknownCount++;
        group.orders.items.push({ id: typeof order.id === 'string' ? order.id : null, kind: order.kind, side: ['buy', 'sell'].includes(order.side) ? order.side : null,
          remainingQuantity: remaining, positionSide: order.positionSide ?? null, reduceOnly: typeof order.reduceOnly === 'boolean' ? order.reduceOnly : null });
      }
      for (const side of ['buy', 'sell']) group.orders[`${side}Quantity`] = group.orders.unknownCount ? null : addDecimals(group.orders.items.filter(order => order.side === side).map(order => order.remainingQuantity));
    } else group.orders.unknownCount++;
    for (const job of evidence.jobs) {
      const matching = job.legs.filter(leg => leg.exchange === group.exchange && leg.symbol === group.symbol), binding = job.accounts.find(row => row.exchange === group.exchange);
      if (!matching.length) continue;
      const matchesAccount = group.currentAccount && binding?.identity === account?.identity && binding?.revision === account?.revision;
      let matchesContract = false;
      try { matchesContract = matching.every(leg => sameContract(contract(leg.exchange, leg.symbol, leg.rule), group._meta)); } catch { /* Unproven old units remain unknown. */ }
      group.jobs.push({ id: job.id, ruleId: job.auto?.ruleId ?? null, status: job.status, action: job.action, accountMatches: matchesAccount,
        remainingQuantity: matchesAccount && matchesContract && !matching.some(leg => leg.currentOrder?.unknown || leg.unresolved?.some(order => order.unknown)) ? addDecimals(matching.filter(leg => leg.side === group.side).map(leg => leg.remainingQuantity)) : null });
      for (const row of group.rules) if (job.id !== rules.find(rule => rule.id === row.id)?.state.jobId) row.waitingFor.push(job.id);
      if (!matchesAccount) group.gaps.push('共享合约任务的账户版本或身份无法与当前读取匹配');
      if (!matchesContract) group.gaps.push('共享合约任务的原生合约、单位或乘数已改变或缺少证据');
      if (matching.some(leg => leg.currentOrder?.unknown || leg.unresolved?.some(order => order.unknown))) {
        group.orders.unknownCount++; group.orders.buyQuantity = null; group.orders.sellQuantity = null;
        group.gaps.push('本地执行任务存在未知委托，交易所列表为空仍不能确认没有在途委托');
      }
    }
    if (group.orders.unknownCount) group.gaps.push('在途委托数量或策略子单状态不完整，不能确认零委托');
  }
  const output = [...groups.values()].map(group => {
    const peers = [...groups.values()].filter(peer => peer.accountKey === group.accountKey && (peer.instrumentId ?? peer.symbol) === (group.instrumentId ?? group.symbol));
    group.sharedRuleIds = [...new Set(peers.flatMap(peer => peer.rules.map(rule => rule.id)))];
    const { _account, _market, _meta, _key, ...publicGroup } = group;
    return { ...publicGroup, target: total(group.target, _market, _meta), held: total(group.held, _market, _meta),
      actual: { quantity: group.actual, notional: group.actual !== null && _market && _meta ? notional(group.actual, _market.bid, _meta.contractSize) : null }, gaps: [...new Set(group.gaps)] };
  });
  const times = output.flatMap(group => [group.accountAt, group.quoteAt]).filter(at => fresh(at, now)).map(Date.parse);
  return { generatedAt: iso(now), startedAt: evidence.startedAt, rulesVersion: snapshot.version, maxAgeMs: QUOTE_MAX_AGE,
    expiresAt: iso((times.length ? Math.min(...times) : now) + QUOTE_MAX_AGE), complete: !globalGaps.length && output.every(group => group.gaps.length === 0),
    scope: '仅覆盖自动规则引用的账户与合约；配置目标包含停用与只观察规则，不与记录持仓、真实仓位或委托相加；名义额按当前买一价估算。', groups: output, gaps: globalGaps };
}

export function createTradingAutoExposure({ execution, readRules, now = Date.now } = {}) {
  let pending = null;
  async function read({ signal } = {}) {
    if (pending) throw new ExecutionError(429, '敞口读取正在进行，请等待本次完成');
    const snapshot = readRules();
    const legs = snapshot.rules.flatMap(rule => [...intentFor(rule.config, 'open').legs, ...(rule.state.held ?? [])]);
    const operation = execution.exposureEvidence(legs, { signal, ruleIds: snapshot.rules.map(rule => rule.id) });
    pending = operation;
    try {
      const evidence = await operation;
      if (signal?.aborted) throw new ExecutionError(503, '敞口读取已取消');
      if (readRules().version !== snapshot.version) throw new ExecutionError(409, '读取期间规则已变化，请重新刷新敞口');
      return projectAutoExposure(snapshot, evidence, now());
    } finally { if (pending === operation) pending = null; }
  }
  return { read };
}
