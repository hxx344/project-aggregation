import { pairTakerFees, validFeePercent, takerFeeVenues } from '../lib/perpetual-fees.ts';
import { quoteIsFresh, quotePriceTime } from '../lib/perpetual-spreads.ts';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const failure = message => new Error(message);
const venueIds = new Set(takerFeeVenues.map(venue => venue.id));
export const initialPerpetualAlertState = () => ({ version: 1, revision: 0, config: { enabled: false, rules: [] }, ruleStates: {}, history: [] });

export function validatePerpetualAlertConfig(input) {
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 20) throw failure('最多配置 20 个组合，需提供提醒总开关。');
  const ids = new Set();
  const rules = input.rules.map(rule => {
    if (!rule || typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rule.id) || ['__proto__', 'constructor', 'prototype'].includes(rule.id) || ids.has(rule.id) || typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 80 || typeof rule.enabled !== 'boolean') throw failure('规则需要唯一编号、名称与观察开关。');
    ids.add(rule.id);
    if (typeof rule.base !== 'string' || !/^[A-Z0-9:._-]{1,80}$/.test(rule.base) || [rule.longKey, rule.shortKey].some(key => typeof key !== 'string' || key.length > 160 || !/^[a-z0-9-]+:[^\s\u0000-\u001f]+$/.test(key)) || rule.longKey.split(':')[0] === rule.shortKey.split(':')[0]) throw failure('需选择同一标的、不同交易所的完整做多和做空合约。');
    if (!finite(rule.thresholdPercent) || rule.thresholdPercent < -100 || rule.thresholdPercent > 1000 || !integer(rule.durationSeconds, 1, 3600) || !integer(rule.windowSeconds, 5, 3600) || rule.durationSeconds > rule.windowSeconds || !finite(rule.minHitRatio) || rule.minHitRatio < 0 || rule.minHitRatio > 1 || !integer(rule.cooldownSeconds, 30, 86400) || !integer(rule.maxAgeSeconds, 1, 30)) throw failure('阈值 -100% 至 1000%；持续 1–3600 秒且不超过窗口；窗口 5–3600 秒；占比 0–100%；冷却 30–86400 秒；报价年龄 1–30 秒。');
    if (!rule.budget || !validFeePercent(rule.budget.slippagePercent) || !rule.budget.takerOverrides || typeof rule.budget.takerOverrides !== 'object' || Array.isArray(rule.budget.takerOverrides)) throw failure('手续费覆盖与滑点预算格式无效。');
    const takerOverrides = {};
    for (const [venue, fee] of Object.entries(rule.budget.takerOverrides)) {
      if (!venueIds.has(venue) || !validFeePercent(fee)) throw failure('账户手续费覆盖无效。');
      takerOverrides[venue] = fee;
    }
    return { id: rule.id, name: rule.name.trim(), enabled: rule.enabled, base: rule.base, longKey: rule.longKey, shortKey: rule.shortKey,
      thresholdPercent: rule.thresholdPercent, durationSeconds: rule.durationSeconds, windowSeconds: rule.windowSeconds,
      minHitRatio: rule.minHitRatio, cooldownSeconds: rule.cooldownSeconds, maxAgeSeconds: rule.maxAgeSeconds,
      budget: { takerOverrides, slippagePercent: rule.budget.slippagePercent } };
  });
  if (input.enabled && !rules.some(rule => rule.enabled)) throw failure('启用飞书前，请启用至少一个组合观察规则。');
  return { enabled: input.enabled, rules };
}

export function evaluatePerpetualAlertQuote(rule, getQuote, now, isVenueLive = () => true) {
  const long = getQuote(rule.longKey), short = getQuote(rule.shortKey);
  const unavailable = reason => ({ valid: false, hit: false, netSpreadPercent: null, reason });
  if (!long || !short || long.base !== rule.base || short.base !== rule.base || long.comparable === false || short.comparable === false || long.exchange === short.exchange) return unavailable('组合已下线、身份变更或报价未就绪');
  if (long.quoteCurrency !== short.quoteCurrency) return unavailable('跨计价币组合不用于此告警，需先统一计价');
  if (!isVenueLive(long.exchange) || !isVenueLive(short.exchange)) return unavailable('至少一个平台连接未在线');
  if (![long, short].every(quote => quoteIsFresh(quote, 'book', now, rule.maxAgeSeconds * 1000) && finite(quote.bid) && quote.bid > 0 && finite(quote.ask) && quote.ask >= quote.bid)) return unavailable('报价过期或买卖盘口不完整');
  if (Math.abs(quotePriceTime(long, 'book') - quotePriceTime(short, 'book')) > 5000) return unavailable('两腿报价时间相差超过 5 秒');
  const fees = pairTakerFees({ long, short }, rule.budget.takerOverrides, now);
  if (fees.roundTripPercent === null) return unavailable('至少一腿 taker 费率缺失或过期');
  const netSpreadPercent = (short.bid / long.ask - 1) * 100 - fees.roundTripPercent - rule.budget.slippagePercent;
  if (!finite(netSpreadPercent)) return unavailable('扣费价差无效');
  return { valid: true, hit: netSpreadPercent >= rule.thresholdPercent, netSpreadPercent, reason: netSpreadPercent >= rule.thresholdPercent ? '本次达到净价差阈值' : '本次未达到净价差阈值' };
}

/** One small ring per saved rule; missing seconds reduce coverage and interrupt persistence. */
export function createPerpetualConditionTracker(rule) {
  const points = new Map();
  let lastSecond = null, lastObservedAt = null, continuousSince = null, hitCount = 0, validCount = 0;
  return {
    observe(result, now) {
      const second = Math.floor(now / 1000);
      if (lastObservedAt !== null && now < lastObservedAt) { points.clear(); hitCount = 0; validCount = 0; continuousSince = null; lastSecond = null; }
      lastObservedAt = now;
      if (lastSecond === null || second > lastSecond) {
        if (!result.hit || lastSecond === null || second - lastSecond !== 1) continuousSince = result.hit ? now : null;
        if (result.hit && continuousSince === null) continuousSince = now;
        points.set(second, { hit: result.hit, valid: result.valid });
        hitCount += Number(result.hit); validCount += Number(result.valid); lastSecond = second;
        for (const [at, value] of points) {
          if (at > second - rule.windowSeconds) break;
          points.delete(at); hitCount -= Number(value.hit); validCount -= Number(value.valid);
        }
      } else if (!result.hit) {
        // A same-second invalidation must break continuity immediately.
        continuousSince = null;
        const previous = points.get(second);
        if (previous?.hit) { previous.hit = false; hitCount--; }
        if (previous?.valid && !result.valid) { previous.valid = false; validCount--; }
      }
      const continuousSeconds = result.hit && continuousSince !== null ? Math.floor((now - continuousSince) / 1000) : 0;
      const hitRatio = hitCount / rule.windowSeconds, coverage = validCount / rule.windowSeconds;
      return { continuousSeconds, hitRatio, coverage, ready: result.hit && continuousSeconds >= rule.durationSeconds && hitRatio >= rule.minHitRatio };
    },
    size: () => points.size,
  };
}
