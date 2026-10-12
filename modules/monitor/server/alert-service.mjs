import { randomUUID } from "node:crypto";
import { loadQuote } from "../lib/quote-service.ts";
import { evaluateRules, isFreshQuote, publicState, reconcileRuleStates, validateConfig } from "./alert-engine.mjs";
import { formatAlert, sendFeishu } from "./feishu.mjs";

export function createAlertService(store, { getQuote = loadQuote, deliver = sendFeishu, clock = Date.now, notifications } = {}) {
  let queue = Promise.resolve();
  let polling;
  let pendingPoll;
  let stopped = false;
  let liveQuote = null;
  let liveQuoteError = "";
  let pendingWrite = null;
  let storageFailed = false;
  const persist = async state => {
    const snapshot = structuredClone(state);
    pendingWrite = snapshot;
    try { await store.save(snapshot); pendingWrite = null; storageFailed = false; }
    catch (error) { storageFailed = true; throw error; }
  };
  const serial = work => {
    const operation = queue.then(async () => {
      // A delivered message must not be sent again just because its disk write failed.
      if (pendingWrite) await persist(pendingWrite);
      return work();
    });
    queue = operation.catch(() => {});
    return operation;
  };
  const record = (state, item) => { state.history = [{ id: randomUUID(), ...item }, ...state.history].slice(0, 100); };
  const publicView = state => {
    const result = publicState(state);
    if (notifications) {
      const shared = notifications.view();
      result.config.webhookConfigured = notifications.configured();
      result.config.signingSecretConfigured = shared.signingSecretConfigured;
    }
    return result;
  };
  const check = () => {
    if (stopped) return Promise.resolve();
    if (pendingPoll) return pendingPoll;
    pendingPoll = serial(async () => {
      const state = store.get();
      let quote;
      try {
        quote = await getQuote();
        if (!isFreshQuote(quote, clock())) throw new Error("实时报价无效或获取时间已过期。");
        liveQuote = quote;
        liveQuoteError = "";
      } catch {
        liveQuoteError = "实时报价获取失败；暂停本轮告警，下一轮自动重试。";
        state.status.checkedAt = new Date(clock()).toISOString();
        state.status.lastError = liveQuoteError;
        await persist(state);
        return;
      }
      const now = clock();
      state.status = { checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(), lastError: "", lastQuote: quote };
      const evaluated = evaluateRules(state.config, state.ruleStates, quote.premium, now);
      state.ruleStates = evaluated.states;
      const rules = evaluated.triggered;
      if (!rules.length || (notifications && !notifications.configured())) { await persist(state); return; }
      for (const rule of rules) state.ruleStates[rule.id].lastAttemptAt = now;
      // Persist the attempt before external delivery; restart cannot cause immediate retries.
      await persist(state);
      if (!isFreshQuote(quote, clock())) {
        state.status.lastError = "报价在发送前已过期，等待下一轮实时报价。";
        await persist(state);
        return;
      }
      const text = formatAlert(quote, rules);
      try {
        if (notifications) await notifications.send(text, () => {
          if (!isFreshQuote(quote, clock())) throw new Error("报价在发送前已过期，等待下一轮实时报价。");
        });
        else await deliver(state.config, text, { now });
        for (const rule of rules) {
          state.ruleStates[rule.id].armed = false;
          state.ruleStates[rule.id].lastSentAt = clock();
        }
        record(state, { time: new Date(clock()).toISOString(), kind: "alert", status: "sent", premium: quote.premium, rules: rules.map(rule => rule.name), error: "" });
      } catch (error) {
        state.status.lastError = error.message;
        record(state, { time: new Date(clock()).toISOString(), kind: "alert", status: "failed", premium: quote.premium, rules: rules.map(rule => rule.name), error: error.message });
      }
      await persist(state);
    }).finally(() => { pendingPoll = undefined; });
    return pendingPoll;
  };
  return {
    healthy: () => !storageFailed,
    view: () => {
      const state = publicView(store.get());
      if (pendingWrite) state.status.lastError = "磁盘保存失败，暂停新告警；请检查数据目录权限和剩余空间。";
      return state;
    },
    async quote() {
      if (!liveQuote || !isFreshQuote(liveQuote, clock())) await check();
      if (liveQuoteError || !isFreshQuote(liveQuote, clock())) throw new Error("实时行情暂不可用。");
      return liveQuote;
    },
    update(input) {
      return serial(async () => {
        const state = store.get();
        if (input.revision !== state.revision) throw new Error("配置已被另一页面修改，请刷新配置后重试。");
        if (notifications && (input.webhookUrl || input.signingSecret || input.clearWebhook || input.clearSigningSecret)) throw new Error("机器人已由整个面板共用，请在顶部的统一飞书告警设置中修改。");
        const config = validateConfig(input, notifications ? { ...state.config, webhookUrl: "", signingSecret: "" } : state.config, { requireWebhook: !notifications });
        state.ruleStates = reconcileRuleStates(state.config, config, state.ruleStates);
        state.config = config;
        // Keep the old on-disk state compatible until an explicit rule edit, so a failed
        // first upgrade can still roll back to the previous server without data changes.
        if (notifications) state.version = 2;
        state.revision++;
        await persist(state);
        return publicView(state);
      });
    },
    test() {
      if (notifications) return notifications.test().then(() => publicView(store.get()));
      return serial(async () => {
        const state = store.get();
        const now = clock();
        if (!state.config.webhookUrl) throw new Error("请先保存飞书 Webhook。");
        if (state.lastTestAt !== null && now - state.lastTestAt < 10_000) throw new Error("请在 10 秒后再发送测试消息。");
        state.lastTestAt = now;
        await persist(state);
        let failure;
        try {
          await deliver(state.config, `海力士价差告警\n测试消息：飞书机器人连接成功。\n时间：${new Date(now).toISOString()}`, { now });
          record(state, { time: new Date(now).toISOString(), kind: "test", status: "sent", rules: [], error: "" });
        } catch (error) {
          failure = error;
          record(state, { time: new Date(now).toISOString(), kind: "test", status: "failed", rules: [], error: error.message });
        }
        await persist(state);
        if (failure) throw failure;
        return publicState(state);
      });
    },
    check,
    start() {
      if (polling) return;
      stopped = false;
      const tick = () => { void check().catch(() => console.error("告警状态保存失败，请检查磁盘和目录权限。")); };
      polling = setInterval(tick, 10_000);
      tick();
    },
    async stop() { stopped = true; clearInterval(polling); polling = undefined; await queue; },
  };
}
