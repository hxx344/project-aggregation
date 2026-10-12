import { sendFeishu } from "./feishu.mjs";
import { validateChannel } from "./notification-store.mjs";

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const sourceLabels = { oil: "原油", hynix: "海力士" };

export function createNotificationService(store, { deliver = sendFeishu, clock = Date.now } = {}) {
  let queue = Promise.resolve(), storageFailed = false;
  const serial = work => { const task = queue.then(work); queue = task.catch(() => {}); return task; };
  const persist = async state => {
    try { await store.save(state); storageFailed = false; }
    catch { storageFailed = true; throw failure("统一飞书配置保存失败，发送已暂停；请检查数据目录权限和磁盘空间后重新保存。", 503); }
  };
  const view = () => {
    const state = store.get();
    return { available: true, revision: state.revision, webhookConfigured: Boolean(state.config.webhookUrl), signingSecretConfigured: Boolean(state.config.signingSecret),
      candidates: state.candidates.map(source => ({ id: source.id, label: sourceLabels[source.id], destination: `${new URL(source.webhookUrl).hostname} / …${source.webhookUrl.slice(-4)}`, signingSecretConfigured: Boolean(source.signingSecret) })),
      migratedFrom: state.migratedFrom.map(id => sourceLabels[id]), lastTestAt: state.lastTestAt, testResult: state.testResult,
      error: storageFailed ? "统一配置保存失败，发送已暂停，请重新保存。" : "" };
  };
  const send = async (text, beforeSend) => {
    if (storageFailed) throw failure("统一配置保存失败，飞书发送已暂停。", 503);
    const state = store.get();
    if (!state.config.webhookUrl) throw failure(state.candidates.length ? "请先在统一飞书告警设置中选择共用机器人。" : "请先保存统一飞书机器人配置。");
    beforeSend?.();
    // URL and secret are one committed snapshot, and updates share this queue.
    await deliver(state.config, text, { now: clock() });
  };
  return {
    view, configured: () => !storageFailed && Boolean(store.get().config.webhookUrl), healthy: () => !storageFailed,
    send: (text, beforeSend) => serial(() => send(text, beforeSend)),
    update: input => serial(async () => {
      const state = store.get();
      if (!input || !Number.isSafeInteger(input.revision)) throw failure("缺少统一配置版本号。");
      if (input.revision !== state.revision) throw failure("统一配置已被另一页面修改，请重新载入后再保存。", 409);
      for (const key of ["webhookUrl", "signingSecret"]) if (input[key] !== undefined && typeof input[key] !== "string") throw failure("机器人配置格式不正确。");
      for (const key of ["clearWebhook", "clearSigningSecret"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw failure("清除选项格式不正确。");
      let config;
      if (input.migrationSource) {
        const candidate = state.candidates.find(source => source.id === input.migrationSource);
        if (!candidate || input.webhookUrl?.trim() || input.signingSecret?.trim() || input.clearWebhook || input.clearSigningSecret) throw failure("请选择一个已有机器人，或填写新机器人配置。");
        config = validateChannel(candidate); state.migratedFrom = [candidate.id];
      } else {
        const webhookUrl = input.clearWebhook ? "" : (input.webhookUrl?.trim() || state.config.webhookUrl);
        const changed = webhookUrl !== state.config.webhookUrl;
        const signingSecret = !webhookUrl || input.clearSigningSecret ? "" : (input.signingSecret?.trim() || (changed ? "" : state.config.signingSecret));
        config = validateChannel({ webhookUrl, signingSecret });
        if (state.candidates.length && !webhookUrl && !input.clearWebhook) throw failure("请选择已有机器人或填写新的 Webhook。");
        state.migratedFrom = [];
      }
      state.config = config; state.candidates = []; state.revision++; state.testResult = null;
      await persist(state); return view();
    }),
    test: () => serial(async () => {
      const state = store.get(), now = clock();
      if (!state.config.webhookUrl) throw failure("请先保存统一飞书机器人配置。");
      if (state.lastTestAt !== null && now - state.lastTestAt < 60_000) throw failure("测试消息每分钟最多发送一次。", 429);
      state.lastTestAt = now; state.testResult = { time: new Date(now).toISOString(), status: "sending", error: "" };
      await persist(state);
      let error;
      try { await send(`市场监控 · 飞书连接测试\n原油 / 金油比 / 海力士 / 合约价差告警共用此机器人。\n时间：${new Date(now).toISOString()}`); state.testResult.status = "sent"; }
      catch (cause) { error = cause; state.testResult.status = "failed"; state.testResult.error = cause.message; }
      await persist(state);
      if (error) throw error;
      return view();
    }),
    stop: () => queue,
  };
}
