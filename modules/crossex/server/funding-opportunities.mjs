import { createHash } from 'node:crypto';
import { D } from './money.mjs';
import { contractIdentity, freshQuote, fxRate, quoteTime, referencePrice, settlement, transferEligibility, validIdentity, validSignal } from './model.mjs';

const FUNDING_TTL_MS = 300000, QUOTE_TTL_MS = 10000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const identityPair = (left, right) => JSON.stringify([left, right].sort());
const compare = (a, b) => Number(b.eligible) - Number(a.eligible) || b.equivalent8hBps - a.equivalent8hBps || a.id.localeCompare(b.id);

function fundingLeg(quote, rule, now) {
  return { exchange: quote.exchange, symbol: rule.symbol, quoteCurrency: quote.quoteCurrency,
    rate: quote.fundingRate, intervalHours: quote.fundingIntervalHours,
    normalized8hBps: D(quote.fundingRate).times(80000).div(quote.fundingIntervalHours).toNumber(),
    nextFundingAt: finite(quote.nextFundingAt) && quote.nextFundingAt > now ? quote.nextFundingAt : null,
    fundingAt: quote.fundingAt };
}

/** Pure discovery from complete Monitor quotes; never fetches data or authorizes an order. */
export function fundingOpportunities(feed, { now, ruleFor, sourceReason = '', entryPaused = false, entryPolicyKnown = false, catalogExpiresAt = Infinity,
  signals = feed?.signals || [], signalValid = signal => validSignal(signal, feed, now) } = {}) {
  if (!feed) return [];
  const groups = new Map(), liveVenues = new Set(feed.exchanges.filter(venue => venue.status === 'live').map(venue => venue.id));
  const policy = feed.crossexFilter, blocked = new Set(Array.isArray(policy?.blockedBases) ? policy.blockedBases : []);
  const evidence = new Map();
  // A transfer certificate covers both directions, but only these exact current
  // contract identities. A positive-price signal is never required for discovery.
  if (policy?.requireSpotTransfer === true) for (const signal of signals) {
    if (!signalValid(signal)) continue;
    const transfer = transferEligibility(signal, feed, now);
    if (transfer.state !== 'verified') continue;
    const key = identityPair(contractIdentity(signal.long), contractIdentity(signal.short));
    const expiresAt = Math.min(signal.expiresAt, transfer.expiresAt);
    evidence.set(key, Math.max(evidence.get(key) ?? 0, expiresAt));
  }
  for (const quote of feed.quotes) {
    // Unknown intervals must not be silently treated as eight-hour contracts.
    if (!finite(quote.fundingRate) || !finite(quote.fundingIntervalHours) || quote.fundingIntervalHours <= 0 || quote.fundingIntervalHours > 168
      || !finite(quote.fundingAt) || quote.fundingAt <= 0 || blocked.has(quote.base)
      || !validIdentity(quote) || (quote.contractKind ?? 'linear') !== 'linear' || quote.delisting || quote.delistingAt) continue;
    let rule;
    try { rule = ruleFor(quote); } catch { continue; }
    const leg = fundingLeg(quote, rule, now);
    if (!finite(leg.normalized8hBps)) continue;
    const entry = { quote, leg, identity: contractIdentity(quote) };
    if (!groups.has(quote.base)) groups.set(quote.base, []);
    groups.get(quote.base).push(entry);
  }
  const result = [];
  for (const [base, quotes] of groups) for (let i = 0; i < quotes.length; i++) for (let j = i + 1; j < quotes.length; j++) {
    const a = quotes[i], b = quotes[j];
    if (a.quote.exchange === b.quote.exchange || a.leg.normalized8hBps === b.leg.normalized8hBps) continue;
    const [long, short] = a.leg.normalized8hBps < b.leg.normalized8hBps ? [a, b] : [b, a];
    const equivalent8hBps = D(short.leg.normalized8hBps).minus(long.leg.normalized8hBps).toNumber();
    if (!finite(equivalent8hBps) || equivalent8hBps <= 0) continue;
    const legs = [long.quote, short.quote], fundingTimes = legs.map(q => q.fundingAt), quoteTimes = legs.map(quoteTime);
    let reason = sourceReason, grossBps = null;
    const deadlines = [catalogExpiresAt, feed.generatedAt + QUOTE_TTL_MS, ...fundingTimes.map(at => at + FUNDING_TTL_MS),
      ...quoteTimes.map(at => finite(at) && at > 0 ? at + QUOTE_TTL_MS : now)];
    if (!reason && entryPolicyKnown && policy === undefined) reason = 'Monitor 筛选策略缺失，请等待来源恢复';
    if (!reason && fundingTimes.some(at => at > now + 1000 || now - at >= FUNDING_TTL_MS)) reason = '资金费数据过期或时间无效';
    if (!reason && legs.some(q => !liveVenues.has(q.exchange))) reason = '交易所行情离线，等待来源恢复';
    if (!reason && (legs.some(q => !freshQuote(q, now) || [q.bidAskAt, q.receivedAt].some(at => !finite(at) || at > now + 1000))
      || Math.abs(quoteTimes[0] - quoteTimes[1]) > 5000)) reason = '报价过期、无效或双腿不同步';
    try {
      for (const q of legs) for (const currency of new Set([q.quoteCurrency, settlement(q)])) {
        const rate = fxRate(currency, feed.fx, now);
        if (currency !== 'USDT') deadlines.push(rate.at + Math.min(180000, feed.fx.staleAfterMs));
      }
      if (legs.every(q => finite(q.bid) && finite(q.ask) && q.bid > 0 && q.ask >= q.bid)) {
        const gross = (referencePrice(short.quote, short.quote.bid, 'sell', feed.fx, now) / referencePrice(long.quote, long.quote.ask, 'buy', feed.fx, now) - 1) * 10000;
        if (finite(gross)) grossBps = gross;
      }
      if (grossBps === null) reason ||= '开仓报价无效，等待来源恢复';
    } catch (error) { reason ||= error.message; }
    const policyEligibility = transferEligibility({ base }, feed, now);
    if (policy?.requireSpotTransfer === true) {
      const expiresAt = evidence.get(identityPair(long.identity, short.identity));
      if (expiresAt) deadlines.push(expiresAt);
      else reason ||= policyEligibility.reason || '双边现货与充提证据缺失或已过期';
    } else if (policyEligibility.state === 'blocked') reason ||= policyEligibility.reason;
    if (!reason && entryPaused) reason = '新开仓已暂停，平仓仍可使用';
    const expiresAt = Math.min(...deadlines);
    if (!reason && expiresAt <= now) reason = '行情或资格证据已过期';
    result.push({ id: createHash('sha256').update(JSON.stringify([base, long.identity, short.identity])).digest('hex'), base,
      long: long.leg, short: short.leg, equivalent8hBps, grossBps,
      asOf: Math.min(...fundingTimes), expiresAt, eligible: !reason, reason });
  }
  return result.sort(compare).slice(0, 200);
}
