import { test } from "node:test";
import assert from "node:assert/strict";
import { hynixAlerts, hynixDraft, hynixConfig, oilAlerts, oilDraft, oilConfig, monitorAlertAdapters } from "../lib/monitor-alerts.ts";
import { monitors } from "../lib/monitors.ts";

const signal = () => new AbortController().signal;
const hynix = { enabled: true, cooldownSeconds: 100, hysteresis: 0.5, rules: [{ id: "original", name: "原有梯度", direction: "above", threshold: 40, enabled: true }] };
const oil = { enabled: true, rules: ["spread", "brent", "wti"].map((metric, index) => ({ id: `oil-${index}`, label: metric, metric, operator: index ? "lte" : "gte", threshold: 5 + index, cooldownMinutes: 30.5, hysteresis: 0.1, enabled: !index })) };

test("Hynix editor preserves legacy defaults, identifiers and whole seconds without migration", () => {
  assert.deepEqual(hynixConfig(hynixDraft(hynix)), hynix);
  for (const seconds of [0, 31, 90, 100, 86400]) {
    const config = { ...hynix, rules: [{ ...hynix.rules[0], cooldownSeconds: seconds, hysteresis: 0 }] };
    const result = hynixConfig(hynixDraft(config));
    assert.equal(result.rules[0].cooldownSeconds ?? result.cooldownSeconds, seconds);
    assert.equal(result.rules[0].hysteresis, 0);
  }
  for (const minutes of [0.001, -1, Infinity, 1441]) {
    const draft = hynixDraft(hynix); draft.rules[0].cooldownMinutes = minutes;
    assert.throws(() => hynixConfig(draft), /整秒/);
  }
});

test("oil editor roundtrips all metrics, decimal minutes and independent rule controls", () => {
  assert.deepEqual(oilConfig(oilDraft(oil)), oil);
  const draft = oilDraft(oil); draft.rules[0].cooldownMinutes = 0; draft.rules[0].hysteresis = 0;
  assert.equal(oilConfig(draft).rules[0].cooldownMinutes, 0);
  assert.equal(oilConfig(draft).rules[0].hysteresis, 0);
  assert.deepEqual(oilConfig(draft).rules.slice(1), oil.rules.slice(1));
});

test("oil rules use the absolute spread; old percentage events keep their own unit in history", async () => {
  const fresh = oilAlerts.newRule(oilDraft(oil));
  assert.equal(fresh.metric, 'spread');
  assert.equal(oilAlerts.metrics.find(metric => metric.id === fresh.metric).unit, 'USDT/桶');
  assert.equal(oilAlerts.metrics.find(metric => metric.id === fresh.metric).hysteresisUnit, 'USDT/桶');
  assert.ok(!oilAlerts.metrics.some(metric => metric.id === 'spreadPercent' || metric.unit === '%'), 'percentage is no longer selectable');
  const events = ['spreadPercent', 'spread'].map(metric => ({ id: metric, time: '2026-09-23T00:00:00Z', status: 'sent', rules: [{ label: '阈值', metric, operator: 'gte', value: 5, threshold: 5 }] }));
  const view = await oilAlerts.load(signal(), async url => Response.json(url.endsWith('status') ? { available: true, market: { brent: { markPx: 80 }, wti: { markPx: 75 } } } : url.endsWith('config') ? { revision: 1, config: oil } : { events }));
  assert.match(view.market, /价差 5.0000 USDT\/桶/);
  assert.match(view.history[0].description, /百分比价差（已停用） 5.0000 ≥ 5 %/);
  assert.match(view.history[1].description, /价差 5.0000 ≥ 5 USDT\/桶/);
  assert.equal(oilAlerts.notice(oilDraft(oil)), null);
  const converted = { name: '价差 5%（原百分比）', enabled: false };
  const draft = { ...oilDraft(oil), rules: [...oilDraft(oil).rules, { ...fresh, ...converted }] };
  assert.match(oilAlerts.notice(draft), /有 1 档原百分比规则/);
  assert.equal(oilAlerts.notice({ ...draft, rules: draft.rules.map(rule => ({ ...rule, enabled: true })) }), null, 'notice clears once re-enabled');
});

test("web-only oil availability does not request Linux-only configuration or events", async () => {
  const calls = [];
  const view = await oilAlerts.load(signal(), async url => { calls.push(url); return Response.json({ available: false, reason: "仅行情" }); });
  assert.equal(view.available, false); assert.equal(view.reason, "仅行情");
  assert.deepEqual(calls, ["/api/monitors/oil/status"]);
});

test("oil loading keeps stale prices, storage/delivery errors and historical trigger details", async () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ id: `event-${i}`, time: "2026-09-11T12:00:00Z", status: i ? "sent" : "sending", test: i === 1, rules: [{ id: "delivery-not-config-id", label: "旧名称", metric: "brent", operator: "lte", threshold: 80, value: 79 }] }));
  const view = await oilAlerts.load(signal(), async url => Response.json(url.endsWith("status") ? { available: true, webhookConfigured: true, stale: true, market: { brent: { markPx: 80 }, wti: { markPx: 75 } }, lastAttemptAt: "2026-09-11T12:00:00Z", lastSuccessAt: null, error: "disk failed", deliveryError: "send failed" } : url.endsWith("config") ? { revision: 3, config: oil } : { events }));
  assert.equal(view.revision, 3); assert.equal(view.history.length, 100);
  assert.match(view.market, /已过期/); assert.match(view.error, /disk failed；send failed/);
  assert.equal(view.history[0].status, "sending"); assert.equal(view.history[0].id, "event-0");
  assert.match(view.history[0].description, /旧名称 · 布伦特 79.0000 ≤ 80/);
  assert.equal(view.history[1].description, "测试消息");
});

test("saving applies canonical results without depending on a subsequent status request", async () => {
  const calls = [], canonical = { ...oil, rules: [{ ...oil.rules[0], label: "规范名称" }] };
  const saved = await oilAlerts.save(oilDraft(oil), 4, signal(), async (url, init) => {
    calls.push(url); assert.equal(init.method, "PUT");
    assert.deepEqual(JSON.parse(init.body), { revision: 4, config: oil });
    return Response.json({ revision: 5, config: canonical });
  });
  assert.equal(saved.revision, 5); assert.equal(saved.draft.rules[0].name, "规范名称"); assert.equal(calls.length, 1);
  await assert.rejects(oilAlerts.save(oilDraft(oil), 4, signal(), async () => Response.json({ error: "conflict" }, { status: 409 })), /你的修改仍保留/);
  await assert.rejects(hynixAlerts.save(hynixDraft(hynix), 4, signal(), async () => Response.json({ error: "磁盘写入失败" }, { status: 400 })), /磁盘写入失败/);
});

test("every alert-capable monitor registers the common editor contract; HTTP clients can add tiers", t => {
  t.mock.method(globalThis.crypto, "randomUUID", () => undefined);
  for (const monitor of monitors.filter(monitor => monitor.capabilities.includes("alerts"))) {
    const adapter = monitorAlertAdapters[monitor.id]; assert.ok(adapter);
    const fresh = adapter.newRule({ enabled: false, rules: [] });
    assert.match(fresh.id, /^[a-zA-Z0-9_-]{1,64}$/); assert.ok(adapter.metrics.some(metric => metric.id === fresh.metric));
  }
  assert.deepEqual(Object.keys(monitorAlertAdapters).sort(), ['hynix', 'oil'], 'The removed gold/oil monitor registers no alert editor');
});
