import { test } from "node:test";
import assert from "node:assert/strict";
import { hynixAlerts, hynixDraft, hynixConfig, oilAlerts, oilDraft, oilConfig, goldOilAlerts, goldOilBzAlerts, goldOilBybitAlerts, goldOilBybitBzAlerts, goldOilAlertId, monitorAlertAdapters } from "../lib/monitor-alerts.ts";
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

test("new oil rules use percent, while amount configurations and historical event units remain explicit", async () => {
  const fresh = oilAlerts.newRule(oilDraft(oil));
  assert.equal(fresh.metric, 'spreadPercent');
  assert.equal(oilAlerts.metrics.find(metric => metric.id === fresh.metric).unit, '%');
  assert.equal(oilAlerts.metrics.find(metric => metric.id === fresh.metric).hysteresisUnit, '百分点');
  const mixed = { ...oil, rules: [...oil.rules, { ...oil.rules[0], id: 'percent', metric: 'spreadPercent' }] };
  assert.deepEqual(oilConfig(oilDraft(mixed)), mixed);
  const events = ['spreadPercent', 'spread'].map(metric => ({ id: metric, time: '2026-09-23T00:00:00Z', status: 'sent', rules: [{ label: '阈值', metric, operator: 'gte', value: 5, threshold: 5 }] }));
  const view = await oilAlerts.load(signal(), async url => Response.json(url.endsWith('status') ? { available: true, market: { brent: { markPx: 80 }, wti: { markPx: 75 } } } : url.endsWith('config') ? { revision: 1, config: mixed } : { events }));
  assert.match(view.market, /价差 6.6667%/);
  assert.match(view.history[0].description, /百分比价差 5.0000 ≥ 5 %/);
  assert.match(view.history[1].description, /绝对价差 5.0000 ≥ 5 USDT\/桶/);
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
});

test('gold/oil editor uses ratio units, isolated endpoints, canonical saves and retained event values', async () => {
  const config = { enabled: true, rules: [{ ...oil.rules[0], id: 'ratio', label: '上沿', metric: 'ratio', threshold: 50, hysteresis: 0.5 }] }, calls = [];
  const draft = oilDraft(config), fresh = goldOilAlerts.newRule(draft);
  assert.equal(fresh.metric, 'ratio'); assert.equal(goldOilAlerts.metrics[0].unit, '桶/盎司'); assert.equal(goldOilAlerts.metrics[0].hysteresisUnit, '桶/盎司');
  assert.equal(Number.isNaN(fresh.threshold), true);
  const view = await goldOilAlerts.load(signal(), async url => {
    calls.push(url);
    return Response.json(url.endsWith('status') ? { available: true, stale: true, webhookConfigured: true, market: goldQuote('cl'), error: 'offline' }
      : url.endsWith('config') ? { revision: 2, config }
      : { events: [{ id: 'event', time: '2026-09-30T00:00:00Z', status: 'sent', rules: [{ label: '旧下沿', operator: 'lte', value: 45, threshold: 46 }] }] });
  });
  assert.deepEqual(view.draft, draft); assert.equal(view.revision, 2); assert.match(view.market, /已过期.*50.0000 桶\/盎司/);
  assert.match(view.history[0].description, /旧下沿.*45.0000 ≤ 46 桶\/盎司/); assert.equal(view.error, 'offline');
  assert.ok(calls.every(url => url.startsWith('/api/monitors/cl-xau/')));
  const saved = await goldOilAlerts.save(draft, 2, signal(), async (url, init) => {
    assert.equal(url, '/api/monitors/cl-xau/config'); assert.deepEqual(JSON.parse(init.body), { revision: 2, config });
    return Response.json({ revision: 3, config });
  });
  assert.deepEqual(saved, { revision: 3, draft });
  await assert.rejects(goldOilAlerts.save(draft, 2, signal(), async () => Response.json({ error: 'conflict' }, { status: 409 })), /你的修改仍保留/);
  calls.length = 0;
  const unavailable = await goldOilAlerts.load(signal(), async url => { calls.push(url); return Response.json({ available: false, reason: '预览' }); });
  assert.equal(unavailable.available, false); assert.deepEqual(calls, ['/api/monitors/cl-xau/status']);
});

function goldQuote(oilType, source = 'Binance') {
  const fetchedAt = '2026-09-30T00:00:00Z', oil = { symbol: oilType === 'cl' ? 'CLUSDT' : 'BZUSDT', price: oilType === 'cl' ? 80 : 100, updatedAt: fetchedAt };
  return { source, currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt, oilType, oil, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: fetchedAt }, ratio: 999, funding: null };
}

test('BZ alert editor uses independent endpoints, revisions, labels and saves', async () => {
  const config = { enabled: false, rules: [] }, calls = [];
  assert.equal(monitorAlertAdapters['cl-xau-bz'], goldOilBzAlerts);
  assert.notEqual(goldOilBzAlerts, goldOilAlerts);
  assert.match(goldOilBzAlerts.metrics[0].label, /XAU \/ BZ/);
  const view = await goldOilBzAlerts.load(signal(), async url => {
    calls.push(url);
    return Response.json(url.endsWith('status') ? { available: true, stale: false, webhookConfigured: true, market: goldQuote('bz') }
      : url.endsWith('config') ? { revision: 8, config } : { events: [] });
  });
  assert.deepEqual(calls.sort(), ['config', 'events', 'status'].map(action => `/api/monitors/cl-xau/bz/${action}`));
  assert.equal(view.revision, 8); assert.deepEqual(view.draft, { enabled: false, rules: [] });
  assert.match(view.market, /XAU \/ BZ 40.0000/); assert.match(view.market, /布伦特原油 100.0000/); assert.doesNotMatch(view.market, /CL|WTI/);
  const draft = { enabled: true, rules: [{ ...goldOilBzAlerts.newRule(view.draft), threshold: 40 }] };
  const saved = await goldOilBzAlerts.save(draft, 8, signal(), async (url, init) => {
    assert.equal(url, '/api/monitors/cl-xau/bz/config'); assert.deepEqual(JSON.parse(init.body), { revision: 8, config: oilConfig(draft) });
    return Response.json({ revision: 9, config: oilConfig(draft) });
  });
  assert.deepEqual(saved, { revision: 9, draft });
});

test('wrong-oil status quotes are hidden while alert configuration remains editable', async () => {
  for (const [adapter, wrongOil] of [[goldOilAlerts, 'bz'], [goldOilBzAlerts, 'cl']]) {
    const view = await adapter.load(signal(), async url => Response.json(url.endsWith('status') ? { available: true, market: goldQuote(wrongOil) }
      : url.endsWith('config') ? { revision: 1, config: { enabled: false, rules: [] } } : { events: [] }));
    assert.equal(view.available, true); assert.equal(view.market, '服务器尚未取得有效行情。'); assert.match(view.error, /合约标识或格式无效/);
    assert.deepEqual(view.draft, { enabled: false, rules: [] });
  }
});

test('Bybit CL and BZ adapters keep their own identities, revisions, event labels and saves', async () => {
  const allAdapters = [goldOilAlerts, goldOilBzAlerts, goldOilBybitAlerts, goldOilBybitBzAlerts];
  assert.equal(new Set(allAdapters).size, 4);
  for (const [oilType, adapter, revision] of [['cl', goldOilBybitAlerts, 12], ['bz', goldOilBybitBzAlerts, 19]]) {
    assert.equal(monitorAlertAdapters[goldOilAlertId(oilType, 'bybit')], adapter);
    const identity = { source: 'Bybit', exchange: 'bybit', oilType }, prefix = `/api/monitors/cl-xau/bybit/${oilType === 'bz' ? 'bz/' : ''}`, calls = [];
    const view = await adapter.load(signal(), async url => {
      calls.push(url);
      return Response.json({ ...identity, ...(url.endsWith('status') ? { available: true, market: goldQuote(oilType, 'Bybit') }
        : url.endsWith('config') ? { revision, config: { enabled: false, rules: [] } }
        : { events: [{ id: 'bybit-event', time: '2026-10-07T00:00:00Z', status: 'sent', rules: [{ label: 'Bybit 阈值', operator: 'gte', value: 48, threshold: 47 }] }] }) });
    });
    assert.deepEqual(calls.sort(), ['config', 'events', 'status'].map(action => `${prefix}${action}`));
    assert.deepEqual(view.draft, { enabled: false, rules: [] }); assert.equal(view.revision, revision);
    assert.equal(adapter.metrics[0].unit, oilType === 'bz' ? '报价比' : '桶/盎司');
    assert.equal(adapter.metrics[0].hysteresisUnit, oilType === 'bz' ? '报价比' : '桶/盎司');
    assert.match(view.market, /^Bybit 标记价/); assert.match(view.history[0].description, new RegExp(`^\\[Bybit ${oilType.toUpperCase()}\\]`));
    const draft = { enabled: true, rules: [{ ...adapter.newRule(view.draft), threshold: 48 }] };
    const saved = await adapter.save(draft, revision, signal(), async (url, init) => {
      assert.equal(url, `${prefix}config`); assert.deepEqual(JSON.parse(init.body), { revision, config: oilConfig(draft) });
      return Response.json({ ...identity, revision: revision + 1, config: oilConfig(draft) });
    });
    assert.deepEqual(saved, { revision: revision + 1, draft });
    const unavailable = await adapter.load(signal(), async () => Response.json({ ...identity, available: false, reason: '仅行情' }));
    assert.equal(unavailable.reason, '仅行情');
  }
});

test('Bybit alert responses reject crossed identities and hide a crossed market quote', async () => {
  const identity = { source: 'Bybit', exchange: 'bybit', oilType: 'cl' }, config = { enabled: false, rules: [] };
  for (const action of ['status', 'config', 'events']) {
    for (const wrongIdentity of [{}, { ...identity, source: 'Binance' }, { ...identity, exchange: 'binance' }, { ...identity, oilType: 'bz' }]) {
      await assert.rejects(goldOilBybitAlerts.load(signal(), async url => Response.json({ ...(url.endsWith(action) ? wrongIdentity : identity),
        ...(url.endsWith('status') ? { available: true, market: goldQuote('cl', 'Bybit') } : url.endsWith('config') ? { revision: 1, config } : { events: [] }) })), /其他交易所或合约/);
    }
  }
  const view = await goldOilBybitAlerts.load(signal(), async url => Response.json({ ...identity,
    ...(url.endsWith('status') ? { available: true, market: goldQuote('cl', 'Binance') } : url.endsWith('config') ? { revision: 1, config } : { events: [] }) }));
  assert.equal(view.market, '服务器尚未取得有效行情。'); assert.match(view.error, /合约标识或格式无效/);
  await assert.rejects(goldOilBybitAlerts.save({ enabled: false, rules: [] }, 1, signal(), async () => Response.json({ source: 'Binance', exchange: 'binance', oilType: 'cl', revision: 2, config })), /其他交易所或合约/);
});
