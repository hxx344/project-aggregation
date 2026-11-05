import { oilSpread } from '../../modules/oil/spread.mjs';

export const METRICS = Object.freeze({ spread: '价差（布伦特 − WTI）', brent: '布伦特价格', wti: 'WTI 价格' });

export function defaultConfig() {
  return { enabled: false, rules: [3, 4, 5].map((threshold, index) => ({
    id: `spread-${index + 1}`, label: `价差 ${threshold} USDT`, metric: 'spread', operator: 'gte',
    threshold, cooldownMinutes: 30, hysteresis: 0.1, enabled: true
  })) };
}

const LEGACY_PERCENT_SUFFIX = '（原百分比）';
/**
 * Stored percentage rules (`spreadPercent`) become disabled absolute-spread rules with the
 * same numbers, so a 5% threshold is never silently read as 5 USDT/桶; the user re-enables
 * them after checking the threshold. A converted rule that would duplicate an existing
 * condition is dropped. The converted config is written back on the next persist (a save,
 * an alert event or the first tick), after which the dropped duplicates are gone for good.
 */
// The label limit counts UTF-16 units (as validateConfig and the input's maxLength do); cut on whole code points.
function truncateUnits(text, max) {
  let out = '';
  for (const char of text) { if (out.length + char.length > max) break; out += char; }
  return out;
}
export function migrateLegacyConfig(input) {
  if (!input || !Array.isArray(input.rules) || !input.rules.some(rule => rule?.metric === 'spreadPercent')) return input;
  const condition = rule => JSON.stringify([rule.metric, rule.operator, rule.threshold]);
  const kept = new Set(input.rules.filter(rule => rule?.metric !== 'spreadPercent').map(condition));
  const rules = input.rules.flatMap(rule => {
    if (rule?.metric !== 'spreadPercent') return [rule];
    const label = typeof rule.label === 'string' ? `${truncateUnits(rule.label.trim(), 60 - LEGACY_PERCENT_SUFFIX.length)}${LEGACY_PERCENT_SUFFIX}` : rule.label;
    const next = { ...rule, label, metric: 'spread', enabled: false };
    if (kept.has(condition(next))) return [];
    kept.add(condition(next));
    return [next];
  });
  return { ...input, rules };
}

/** Store reads accept the legacy percentage metric once and convert it; API writes do not. */
export const validateStoredConfig = input => validateConfig(migrateLegacyConfig(input));

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
  const spread = oilSpread(brent, wti);
  if (spread === null) throw new Error('行情价差无效，暂停阈值判断');
  return { spread, brent, wti };
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
