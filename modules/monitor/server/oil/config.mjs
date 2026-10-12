import { decimalDifference, oilSpreadPercent } from '../../modules/oil/spread.mjs';

export const METRICS = Object.freeze({ spreadPercent: '布伦特相对 WTI 价差 (%)', spread: '绝对价差', brent: '布伦特价格', wti: 'WTI 价格' });

export function defaultConfig() {
  return { enabled: false, rules: [3, 5, 8].map((threshold, index) => ({
    id: `spread-${index + 1}`, label: `价差 ${threshold}%`, metric: 'spreadPercent', operator: 'gte',
    threshold, cooldownMinutes: 30, hysteresis: 0.1, enabled: true
  })) };
}

export function validateConfig(input, { metrics = METRICS, positiveMetrics = ['brent', 'wti'], thresholdError = '价格阈值必须大于 0；价差可为负数；绝对值不能超过 100 万' } = {}) {
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 50) throw new Error('配置需包含总开关，最多允许 50 个梯度');
  const ids = new Set(), conditions = new Set();
  const rules = input.rules.map(rule => {
    if (!rule || typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || ['__proto__', 'constructor', 'prototype'].includes(rule.id) || ids.has(rule.id)) throw new Error('梯度 ID 无效或重复');
    ids.add(rule.id);
    if (typeof rule.label !== 'string' || !rule.label.trim() || rule.label.length > 60 || /[\r\n\x00-\x1f]/.test(rule.label)) throw new Error('梯度名称需要 1–60 个字符，不含换行');
    if (!Object.hasOwn(metrics, rule.metric) || !['gte', 'lte'].includes(rule.operator) || typeof rule.enabled !== 'boolean') throw new Error('监控指标、方向或开关无效');
    for (const field of ['threshold', 'cooldownMinutes', 'hysteresis']) if (typeof rule[field] !== 'number' || !Number.isFinite(rule[field])) throw new Error('阈值、冷却时间和回差必须是有效数字');
    if (Math.abs(rule.threshold) > 1e6 || (positiveMetrics.includes(rule.metric) && rule.threshold <= 0)) throw new Error(thresholdError);
    if (rule.cooldownMinutes < 0 || rule.cooldownMinutes > 10080 || rule.hysteresis < 0 || rule.hysteresis > 1e6) throw new Error('冷却时间需在 0–10080 分钟内，回差需在 0–100 万内');
    const condition = JSON.stringify([rule.metric, rule.operator, rule.threshold]);
    if (conditions.has(condition)) throw new Error('相同指标、方向和阈值的梯度不能重复');
    conditions.add(condition);
    return { id: rule.id, label: rule.label.trim(), metric: rule.metric, operator: rule.operator, threshold: rule.threshold, cooldownMinutes: rule.cooldownMinutes, hysteresis: rule.hysteresis, enabled: rule.enabled };
  });
  return { enabled: input.enabled, rules };
}

export function ruleFingerprint(rule) {
  return JSON.stringify([rule.metric, rule.operator, rule.threshold, rule.hysteresis, rule.enabled]);
}

export function marketValues(market, now = Date.now(), maxAge = 90_000) {
  const timestamp = Date.parse(market?.fetchedAt);
  if (!Number.isFinite(timestamp) || now - timestamp > maxAge || timestamp - now > 5000) throw new Error('行情已过期，暂停阈值判断');
  const brent = market?.brent?.markPx, wti = market?.wti?.markPx;
  if (![brent, wti].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new Error('行情价格无效，暂停阈值判断');
  // Subtract decimal quotes before converting the spread back to Number so
  // tiny quoted spreads remain equal to the same user-entered decimal threshold.
  const spreadPercent = oilSpreadPercent(brent, wti);
  if (spreadPercent === null) throw new Error('行情价差无效，暂停阈值判断');
  return { spread: decimalDifference(brent, wti), spreadPercent, brent, wti };
}

// One notification per threshold episode. Cooldown also spans separate episodes.
export function evaluateRule(rule, previous = {}, value, now) {
  const state = { active: false, alerted: false, lastSentAt: null, nextAttemptAt: 0, ...previous };
  const compare = (left, right) => Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right)) ? 0 : Math.sign(left - right);
  const matched = rule.operator === 'gte' ? compare(value, rule.threshold) >= 0 : compare(value, rule.threshold) <= 0;
  const reset = rule.operator === 'gte' ? compare(value, rule.threshold - rule.hysteresis) < 0 : compare(value, rule.threshold + rule.hysteresis) > 0;
  if (state.active && reset) { state.active = false; state.alerted = false; state.eventId = null; state.nextAttemptAt = 0; }
  if (!state.active && matched) { state.active = true; state.alerted = false; }
  const cooled = state.lastSentAt === null || now - state.lastSentAt >= rule.cooldownMinutes * 60_000;
  return { state, shouldSend: rule.enabled && matched && state.active && !state.alerted && cooled && now >= state.nextAttemptAt };
}
