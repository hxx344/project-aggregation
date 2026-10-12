import { randomUUID } from 'node:crypto';
import { METRICS, evaluateRule, marketValues, ruleFingerprint, validateConfig } from './config.mjs';

const oilDefinition = {
  service: 'oil-spread-monitor', validateConfig, marketValues, testTitle: '原油阈值告警',
  message: (market, values, due) => ['原油阈值告警', `采集时间：${market.fetchedAt}（UTC）`, '价格口径：Binance BZUSDT / CLUSDT 标记价，USDT/桶；百分比价差＝(布伦特 − WTI) ÷ WTI × 100%',
    ...due.map(({ rule, value, id }) => `【${rule.label}】${METRICS[rule.metric]} ${value.toFixed(4)} ${rule.operator === 'gte' ? '≥' : '≤'} ${rule.threshold} ${rule.metric === 'spreadPercent' ? '%' : 'USDT/桶'}\n事件 ${id}`),
    `布伦特 ${values.brent.toFixed(4)} · WTI ${values.wti.toFixed(4)} · 价差 ${values.spreadPercent.toFixed(4)}%`].join('\n'),
};

export class Monitor {
  constructor({ store, data, fetchMarket, notify, webhookConfigured, pollSeconds = 30, clock = Date.now, definition = oilDefinition, canRun = () => true, beforeSend }) {
    Object.assign(this, { store, data, fetchMarket, notify, webhookConfigured, pollSeconds, clock, definition, canRun, beforeSend });
    this.market = null; this.lastAttemptAt = null; this.error = null; this.deliveryError = null;
    this.storageError = null; this.queue = Promise.resolve(); this.stopped = true; this.lastTestAt = null;
  }
  serial(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  async persist(next) {
    try { await this.store.write(next); this.data = next; this.storageError = null; }
    catch { this.storageError = '数据写入失败，告警已暂停；请检查磁盘后重启服务'; throw new Error(this.storageError); }
  }
  async configure(config, revision) {
    return this.serial(async () => {
      if (this.storageError) throw new Error(this.storageError);
      if (revision !== this.data.revision) { const error = new Error('配置已被其他页面修改，请重新载入后编辑'); error.status = 409; throw error; }
      const validated = this.definition.validateConfig(config), next = structuredClone(this.data);
      const states = {};
      for (const rule of validated.rules) {
        const old = this.data.config.rules.find(item => item.id === rule.id);
        if (old && ruleFingerprint(old) === ruleFingerprint(rule) && this.data.states[rule.id]) states[rule.id] = this.data.states[rule.id];
      }
      next.config = validated; next.states = states; next.revision++;
      await this.persist(next); return this.configuration();
    });
  }
  configuration() { return { revision: this.data.revision, config: structuredClone(this.data.config) }; }
  notificationConfigured() { return typeof this.webhookConfigured === 'function' ? this.webhookConfigured() : this.webhookConfigured; }
  status() {
    const now = this.clock();
    return { service: this.definition.service, enabled: this.data.config.enabled, pollSeconds: this.pollSeconds,
      webhookConfigured: this.notificationConfigured(), lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.market?.fetchedAt ?? null, stale: !this.market || now - Date.parse(this.market.fetchedAt) > (this.definition.maxAgeMs ?? Math.max(90_000, this.pollSeconds * 2000)),
      market: this.market, error: this.storageError || this.error, deliveryError: this.deliveryError,
      enabledRules: this.data.config.rules.filter(rule => rule.enabled).length };
  }
  async tick() {
    return this.serial(async () => {
      if (this.storageError || !this.canRun()) return;
      this.lastAttemptAt = new Date(this.clock()).toISOString();
      let values, market;
      try { market = await this.fetchMarket(); values = this.definition.marketValues(market, this.clock()); }
      catch (error) { this.error = error.message.startsWith('Binance') ? error.message : '行情获取失败或已过期，暂停阈值判断'; return; }
      this.market = market; this.error = null;
      const now = this.clock(), next = structuredClone(this.data), due = [];
      for (const rule of next.config.rules) {
        if (!rule.enabled) continue;
        const { state, shouldSend } = evaluateRule(rule, next.states[rule.id], values[rule.metric], now);
        next.states[rule.id] = state;
        if (shouldSend && next.config.enabled && this.notificationConfigured()) {
          state.eventId ||= randomUUID(); state.nextAttemptAt = now + 60_000;
          due.push({ rule, value: values[rule.metric], id: state.eventId });
        }
      }
      if (!due.length) {
        if (JSON.stringify(next.states) !== JSON.stringify(this.data.states)) await this.persist(next);
        return;
      }
      // Persist attempt IDs before external I/O; an uncertain retry retains its ID.
      const batchId = randomUUID();
      next.events.unshift({ id: batchId, source: this.definition.source ?? 'binance', time: new Date(now).toISOString(), status: 'sending', rules: due.map(item => ({ id: item.id, label: item.rule.label, metric: item.rule.metric, operator: item.rule.operator, threshold: item.rule.threshold, value: item.value })) });
      next.events = next.events.slice(0, 100);
      await this.persist(next);
      const message = this.definition.message(market, values, due);
      const delivered = structuredClone(this.data), event = delivered.events.find(item => item.id === batchId);
      try {
        await this.notify(message, () => {
          if (!this.canRun()) throw new Error('监控已关闭，取消本次告警');
          this.definition.marketValues(market, this.clock());
          this.beforeSend?.(market, due);
        });
        this.deliveryError = null; event.status = 'sent';
        for (const item of due) { delivered.states[item.rule.id].alerted = true; delivered.states[item.rule.id].lastSentAt = this.clock(); }
      } catch (error) { event.status = 'failed'; event.error = error.message; this.deliveryError = error.message; }
      await this.persist(delivered);
    });
  }
  async testNotification() {
    return this.serial(async () => {
      if (this.storageError) throw new Error(this.storageError);
      if (this.lastTestAt !== null && this.clock() - this.lastTestAt < 60_000) { const error = new Error('测试消息每分钟最多发送一次'); error.status = 429; throw error; }
      this.lastTestAt = this.clock();
      const next = structuredClone(this.data), event = { id: randomUUID(), time: new Date(this.clock()).toISOString(), status: 'sending', test: true, rules: [] };
      next.events.unshift(event); next.events = next.events.slice(0, 100); await this.persist(next);
      let failed;
      try { await this.notify(`${this.definition.testTitle} · 连接测试\n飞书机器人连接正常。\n${event.time}`); event.status = 'sent'; this.deliveryError = null; }
      catch (error) { event.status = 'failed'; event.error = error.message; failed = error; this.deliveryError = error.message; }
      await this.persist(next);
      if (failed) throw failed;
      return { ok: true };
    });
  }
  start() {
    this.stopped = false;
    const run = async () => {
      try { await this.tick(); } catch { /* storageError is surfaced in /api/status */ }
      if (!this.stopped) this.timer = setTimeout(run, this.pollSeconds * 1000);
    };
    void run();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.queue; }
}
