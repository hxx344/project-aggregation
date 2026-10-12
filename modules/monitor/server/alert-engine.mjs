export const DEFAULT_CONFIG = {
  enabled: false,
  webhookUrl: "",
  signingSecret: "",
  cooldownSeconds: 300,
  hysteresis: 0.5,
  rules: [],
};

export function validateWebhook(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入有效的飞书机器人 Webhook 地址。"); }
  if (url.protocol !== "https:" || !["open.feishu.cn", "open.larksuite.com"].includes(url.hostname) || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
    throw new Error("Webhook 必须是飞书或 Lark 自定义机器人 HTTPS 地址。");
  }
  return url.href;
}

export function validateConfig(input, previous = DEFAULT_CONFIG, { requireWebhook = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("告警配置格式不正确。");
  const { enabled, cooldownSeconds, hysteresis, rules } = input;
  if (typeof enabled !== "boolean" || !Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 86400 || typeof hysteresis !== "number" || !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 100) {
    throw new Error("冷却时间须为 0–86400 秒的整数，回差须为 0–100 个百分点。");
  }
  if (!Array.isArray(rules) || rules.length > 20) throw new Error("最多可设置 20 档阈值。");
  const ids = new Set();
  const cleanRules = rules.map(rule => {
    if (!rule || typeof rule.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(rule.id) || ids.has(rule.id) || typeof rule.name !== "string" || !rule.name.trim() || rule.name.length > 40 || !["above", "below"].includes(rule.direction) || typeof rule.enabled !== "boolean" || typeof rule.threshold !== "number" || !Number.isFinite(rule.threshold) || rule.threshold < -100 || rule.threshold > 10000) {
      throw new Error("每档需有唯一编号、名称、方向和有效阈值（-100% 至 10000%）。");
    }
    ids.add(rule.id);
    const overrides = {};
    if (rule.cooldownSeconds !== undefined) {
      if (!Number.isInteger(rule.cooldownSeconds) || rule.cooldownSeconds < 0 || rule.cooldownSeconds > 86400) throw new Error("每档冷却时间须为 0–86400 秒的整数。");
      overrides.cooldownSeconds = rule.cooldownSeconds;
    }
    if (rule.hysteresis !== undefined) {
      if (typeof rule.hysteresis !== "number" || !Number.isFinite(rule.hysteresis) || rule.hysteresis < 0 || rule.hysteresis > 100) throw new Error("每档回差须为 0–100 个百分点。");
      overrides.hysteresis = rule.hysteresis;
    }
    return { id: rule.id, name: rule.name.trim(), enabled: rule.enabled, direction: rule.direction, threshold: rule.threshold, ...overrides };
  });
  for (const field of ["webhookUrl", "signingSecret"]) {
    if (input[field] !== undefined && typeof input[field] !== "string") throw new Error("机器人配置格式不正确。");
  }
  const webhookUrl = input.clearWebhook ? "" : (input.webhookUrl?.trim() || previous.webhookUrl);
  const signingSecret = input.clearSigningSecret ? "" : (input.signingSecret?.trim() || previous.signingSecret);
  if (webhookUrl) validateWebhook(webhookUrl);
  if (signingSecret.length > 512) throw new Error("签名密钥过长。");
  if (enabled && ((requireWebhook && !webhookUrl) || !cleanRules.some(rule => rule.enabled))) throw new Error(requireWebhook ? "启用告警前，请配置 Webhook 并启用至少一档阈值。" : "启用告警前，请启用至少一档阈值。");
  return { enabled, webhookUrl, signingSecret, cooldownSeconds, hysteresis, rules: cleanRules };
}

export const freshRuleState = () => ({ armed: true, lastSentAt: null, lastAttemptAt: null });

export function reconcileRuleStates(previous, config, states) {
  const wasEnabled = previous.enabled;
  return Object.fromEntries(config.rules.map(rule => {
    const old = previous.rules.find(item => item.id === rule.id);
    const unchanged = old && old.direction === rule.direction && old.threshold === rule.threshold && old.enabled === rule.enabled && !(config.enabled && !wasEnabled);
    return [rule.id, unchanged && states[rule.id] ? { ...states[rule.id] } : freshRuleState()];
  }));
}

export function isFreshQuote(quote, now) {
  const received = Date.parse(quote?.fetchedAt);
  return quote && [quote.ordinary, quote.adr, quote.equivalent, quote.spread, quote.premium].every(Number.isFinite) && quote.ordinary > 0 && quote.adr > 0 && quote.equivalent > 0 && Number.isFinite(received) && now - received <= 30_000 && received - now <= 5_000;
}

/** Keep each tier armed until a delivery succeeds. A failed signal is only retried while still valid. */
export function evaluateRules(config, states, premium, now) {
  const next = structuredClone(states);
  const triggered = [];
  if (!config.enabled || !Number.isFinite(premium)) return { states: next, triggered };
  const compare = (left, right) => Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right)) ? 0 : Math.sign(left - right);
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const state = next[rule.id] ??= freshRuleState();
    const hysteresis = rule.hysteresis ?? config.hysteresis;
    const cooldownSeconds = rule.cooldownSeconds ?? config.cooldownSeconds;
    const reset = rule.direction === "above" ? compare(premium, rule.threshold - hysteresis) < 0 : compare(premium, rule.threshold + hysteresis) > 0;
    if (!state.armed && reset) state.armed = true;
    const reached = rule.direction === "above" ? premium >= rule.threshold : premium <= rule.threshold;
    const cooled = state.lastSentAt === null || now - state.lastSentAt >= cooldownSeconds * 1000;
    const retryReady = state.lastAttemptAt === null || (state.lastSentAt !== null && state.lastSentAt >= state.lastAttemptAt) || now - state.lastAttemptAt >= 30_000;
    if (state.armed && reached && cooled && retryReady) triggered.push(rule);
  }
  return { states: next, triggered };
}

export function publicState(state) {
  const { webhookUrl, signingSecret, ...config } = state.config;
  return {
    available: true,
    revision: state.revision,
    config: { ...config, webhookConfigured: Boolean(webhookUrl), signingSecretConfigured: Boolean(signingSecret) },
    status: state.status,
    ruleStates: state.ruleStates,
    history: state.history,
  };
}
