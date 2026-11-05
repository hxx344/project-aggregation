import { test } from "node:test";
import assert from "node:assert/strict";
import { hynixAlerts, hynixDraft, hynixConfig, oilAlerts, oilDraft, oilConfig, monitorAlertAdapters } from "../lib/monitor-alerts.ts";
import { monitors } from "../lib/monitors.ts";
import { applyAlertGrid, gridDefaults, gridThresholds } from "../lib/alert-grid.ts";

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

test("two-way tiers roundtrip through both editors", () => {
  const twoWay = { ...oil, rules: [{ ...oil.rules[0], operator: "both" }] };
  assert.equal(oilDraft(twoWay).rules[0].direction, "both");
  assert.deepEqual(oilConfig(oilDraft(twoWay)), twoWay);
  const hynixTwoWay = { ...hynix, rules: [{ ...hynix.rules[0], direction: "both" }] };
  assert.deepEqual(hynixConfig(hynixDraft(hynixTwoWay)), hynixTwoWay);
});

test("range generator produces exact decimal levels and enforces the tier limit", () => {
  assert.deepEqual(gridThresholds(0.1, 0.3, 0.1, 50), [0.1, 0.2, 0.3]);
  assert.deepEqual(gridThresholds(3, 5, 0.5, 50), [3, 3.5, 4, 4.5, 5]);
  assert.deepEqual(gridThresholds(-1, 1.2, 1, 50), [-1, 0, 1], "the last level never passes the upper bound");
  assert.deepEqual(gridThresholds(4, 4, 1, 50), [4]);
  assert.deepEqual(gridThresholds(0, 2e-9, 1e-9, 50), [0, 1e-9, 2e-9], "exponent-notation steps keep their precision");
  assert.deepEqual(gridThresholds(1.25e-7, 3.75e-7, 1.25e-7, 50), [1.25e-7, 2.5e-7, 3.75e-7]);
  assert.deepEqual(gridThresholds(123.456, 123.456006, 0.000003, 50), [123.456, 123.456003, 123.456006], "the upper bound is reached despite binary rounding");
  assert.throws(() => gridThresholds(0, 2e-21, 1e-21, 50), /20 位小数/);
  assert.throws(() => gridThresholds(123.456, 123.45600000000006, 1.5e-14, 50), /有效数字过多/, "levels a number would round cannot be restored later");
  assert.throws(() => gridThresholds(0, 100, 0.001, 50), /100001 档.*50 档/);
  for (const [from, to, step] of [[1, 0, 1], [0, 1, 0], [0, 1, -1], [NaN, 1, 1], [0, Infinity, 1]]) assert.throws(() => gridThresholds(from, to, step, 50));
});

test("range generator replaces only the chosen metric's tiers and keeps matching tier IDs", () => {
  const draft = oilDraft({ enabled: true, rules: [
    { id: "keep-4", label: "旧 4", metric: "spread", operator: "both", threshold: 4, cooldownMinutes: 30, hysteresis: 0.1, enabled: false },
    { id: "drop-9", label: "旧 9", metric: "spread", operator: "gte", threshold: 9, cooldownMinutes: 30, hysteresis: 0.1, enabled: true },
    { id: "brent", label: "布伦特", metric: "brent", operator: "lte", threshold: 80, cooldownMinutes: 30, hysteresis: 0.1, enabled: true },
  ] });
  const grid = { metric: "spread", from: 3, to: 5, step: 0.5, direction: "both", cooldownMinutes: 15, hysteresis: 0.05 };
  const next = applyAlertGrid(draft, grid, oilAlerts);
  assert.deepEqual(next.rules.map(rule => [rule.metric, rule.threshold, rule.direction, rule.name, rule.enabled]), [
    ["brent", 80, "below", "布伦特", true],
    ["spread", 3, "both", "双向 3 USDT/桶", true], ["spread", 3.5, "both", "双向 3.5 USDT/桶", true], ["spread", 4, "both", "双向 4 USDT/桶", true],
    ["spread", 4.5, "both", "双向 4.5 USDT/桶", true], ["spread", 5, "both", "双向 5 USDT/桶", true],
  ]);
  assert.equal(next.rules.find(rule => rule.threshold === 4).id, "keep-4");
  assert.ok(next.rules.every(rule => rule.metric !== "spread" || (rule.cooldownMinutes === 15 && rule.hysteresis === 0.05)));
  assert.equal(new Set(next.rules.map(rule => rule.id)).size, next.rules.length);
  assert.doesNotThrow(() => oilConfig(next));
  assert.deepEqual(draft.rules.map(rule => rule.id), ["keep-4", "drop-9", "brent"], "the source draft is not mutated");
  assert.throws(() => applyAlertGrid(draft, { ...grid, step: 0.01 }, oilAlerts), /49 档/, "other metrics' tiers count toward the limit");
  assert.throws(() => applyAlertGrid(draft, { ...grid, hysteresis: -1 }, oilAlerts), /回差/);
  assert.throws(() => applyAlertGrid(hynixDraft(hynix), { metric: "premium", from: -200, to: -100, step: 50, direction: "below", cooldownMinutes: 5, hysteresis: 0.5 }, hynixAlerts), /超出/);
  const hynixGrid = applyAlertGrid(hynixDraft(hynix), { metric: "premium", from: 30, to: 50, step: 10, direction: "above", cooldownMinutes: 5, hysteresis: 0.5 }, hynixAlerts);
  assert.deepEqual(hynixConfig(hynixGrid).rules.map(rule => [rule.name, rule.direction, rule.threshold, rule.cooldownSeconds]), [["向上 30%", "above", 30, 300], ["向上 40%", "above", 40, 300], ["向上 50%", "above", 50, 300]]);
  assert.equal(hynixGrid.rules[1].id, "original", "the existing upward 40% tier keeps its ID");
});

test("range generator starts from evenly spaced tiers already in the draft, else the monitor default", () => {
  const spaced = applyAlertGrid(oilDraft(oil), { metric: "spread", from: 2, to: 4, step: 0.5, direction: "above", cooldownMinutes: 10, hysteresis: 0.1 }, oilAlerts);
  assert.deepEqual(gridDefaults(spaced, oilAlerts), { metric: "spread", from: 2, to: 4, step: 0.5, direction: "above", cooldownMinutes: 10, hysteresis: 0.1 });
  assert.deepEqual(gridDefaults({ enabled: false, rules: [] }, oilAlerts), { metric: "spread", from: 3, to: 5, step: 0.5, direction: "both", cooldownMinutes: 30, hysteresis: 0.1 });
  assert.deepEqual(gridDefaults(hynixDraft(hynix), hynixAlerts), { metric: "premium", from: 40, to: 40, step: 5, direction: "above", cooldownMinutes: 100 / 60, hysteresis: 0.5 }, "a single tier restores its own level");
  assert.deepEqual(gridDefaults(hynixDraft({ ...hynix, rules: [] }), hynixAlerts), { metric: "premium", from: 30, to: 50, step: 5, direction: "both", cooldownMinutes: 100 / 60, hysteresis: 0.5 });
  const uneven = { enabled: true, rules: [2, 3, 5].map((threshold, index) => ({ ...spaced.rules[0], id: `u${index}`, threshold })) };
  assert.equal(gridDefaults(uneven, oilAlerts).step, 0.5, "unevenly spaced tiers fall back to the default range");
});

test("tiny steps survive generate, reload defaults and regenerate with the same thresholds and IDs", () => {
  for (const [from, to, step] of [[0, 2.42e-9, 1.21e-9], [0, 2e-11, 1e-11], [0, 0.3, 0.1], [123.456, 123.456003, 0.000003], [0.1, 0.10000000242, 1.21e-9], [-0.3, 0.3, 0.1], [2, 2, 1], [2, 2.4, 1]]) {
    const grid = { metric: "spread", from, to, step, direction: "both", cooldownMinutes: 10, hysteresis: 0 };
    const first = applyAlertGrid({ enabled: true, rules: [] }, grid, oilAlerts);
    const restored = gridDefaults(first, oilAlerts);
    if (first.rules.length > 1) assert.deepEqual(restored, grid);
    const again = applyAlertGrid(first, restored, oilAlerts);
    assert.deepEqual(again.rules.map(rule => [rule.id, rule.threshold]), first.rules.map(rule => [rule.id, rule.threshold]));
  }
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
