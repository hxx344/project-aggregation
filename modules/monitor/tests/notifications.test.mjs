import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { initialNotifications, openNotificationStore } from "../server/notification-store.mjs";
import { createNotificationService } from "../server/notification-service.mjs";
import { createAlertService } from "../server/alert-service.mjs";
import { initialState, openStore } from "../server/alert-store.mjs";
import { createMonitorServices } from "../server/monitor-services.mjs";
import { Monitor } from "../server/oil/monitor.mjs";
import { emptyStore } from "../server/oil/store.mjs";
import { createHandler } from "../server/http.mjs";

const first = { webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/first-test-only", signingSecret: "first-test-secret" };
const second = { webhookUrl: "https://open.larksuite.com/open-apis/bot/v2/hook/second-test-only", signingSecret: "second-test-secret" };
const source = (id, config = first) => ({ id, ...config });
function memory(value = initialNotifications()) {
  let state = structuredClone(value);
  return { get: () => structuredClone(state), save: async next => { state = structuredClone(next); } };
}
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "shared-feishu-test-"));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "shared-feishu-test-")); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
const quote = (now, premium = 45) => ({ ordinary: 1000, adr: 100 + premium, equivalent: 100, spread: premium, premium, fetchedAt: new Date(now).toISOString() });
const rules = [{ id: "up", name: "溢价告警", enabled: true, direction: "above", threshold: 40 }];

test("migration carries complete pairs, deduplicates equal channels and exposes conflicting sources without credentials", async () => {
  for (const sources of [[], [source("oil")], [source("hynix")], [source("oil"), source("hynix")]]) {
    const state = initialNotifications(sources);
    assert.equal(Boolean(state.config.webhookUrl), sources.length > 0);
    assert.equal(state.candidates.length, 0);
    if (sources.length) assert.deepEqual(state.config, first);
  }
  const store = memory(initialNotifications([source("hynix"), source("oil", second)]));
  let sent = 0;
  const service = createNotificationService(store, { deliver: async () => { sent++; } });
  assert.equal(service.configured(), false); assert.equal(service.view().candidates.length, 2);
  const publicJson = JSON.stringify(service.view());
  for (const secret of [first.webhookUrl, first.signingSecret, second.webhookUrl, second.signingSecret]) assert.ok(!publicJson.includes(secret));
  await assert.rejects(service.send("alert"), /选择共用/); assert.equal(sent, 0);
  await service.update({ revision: 0, migrationSource: "oil" });
  assert.deepEqual(store.get().config, second); assert.deepEqual(service.view().candidates, []);
  await assert.rejects(service.update({ revision: 1, migrationSource: "oil" }), /请选择/);
  assert.equal(initialNotifications([source("oil"), source("hynix", { ...first, signingSecret: "different" })]).candidates.length, 2);
});

test("the global file persists clearing and test throttling across restart and never reimports legacy credentials", async t => {
  const directory = await temporary(t); let now = 100000, deliveries = 0;
  const options = { clock: () => now, deliver: async () => { deliveries++; } };
  const service = createNotificationService(await openNotificationStore(directory, () => [source("oil")]), options);
  await service.test(); assert.equal(deliveries, 1);
  const restarted = createNotificationService(await openNotificationStore(directory, () => { throw Error("must not import"); }), options);
  await assert.rejects(restarted.test(), error => error.status === 429);
  now += 60000; await restarted.test(); assert.equal(deliveries, 2);
  await restarted.update({ revision: 0, clearWebhook: true });
  const cleared = await openNotificationStore(directory, () => [source("oil", second)]);
  assert.deepEqual(cleared.get().config, { webhookUrl: "", signingSecret: "" });
  const publicJson = JSON.stringify(restarted.view()); assert.ok(!publicJson.includes(first.signingSecret));
  if (process.platform !== "win32") assert.equal((await stat(join(directory, "notifications.json"))).mode & 0o777, 0o600);
  await writeFile(join(directory, "notifications.json"), "broken json");
  await assert.rejects(openNotificationStore(directory, () => [source("oil")]), /无法读取统一飞书配置/);
  assert.equal(await readFile(join(directory, "notifications.json"), "utf8"), "broken json");
});

test("updates validate input and revisions, preserve an unchanged secret, and never reuse it for a different robot", async () => {
  const store = memory(initialNotifications([source("oil")])), service = createNotificationService(store);
  await service.update({ revision: 0, webhookUrl: "", signingSecret: "" }); assert.deepEqual(store.get().config, first);
  await assert.rejects(service.update({ revision: 0, ...second }), error => error.status === 409);
  await service.update({ revision: 1, webhookUrl: second.webhookUrl }); assert.deepEqual(store.get().config, { ...second, signingSecret: "" });
  await service.update({ revision: 2, signingSecret: second.signingSecret }); assert.deepEqual(store.get().config, second);
  await service.update({ revision: 3, clearSigningSecret: true }); assert.equal(store.get().config.signingSecret, "");
  for (const fields of [{ webhookUrl: "https://evil.invalid/webhook" }, { signingSecret: 1 }, { clearWebhook: "false" }, { signingSecret: "x".repeat(513) }, { webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/x?token=y" }]) await assert.rejects(service.update({ revision: 4, ...fields }));
  assert.equal(store.get().revision, 4);
});

test("configuration updates wait for in-flight delivery and later sends use the new committed pair", async () => {
  const gate = deferred(), started = deferred(), delivered = [];
  const service = createNotificationService(memory(initialNotifications([source("oil")])), { deliver: async (config, text) => { delivered.push({ config, text }); if (text === "old") { started.resolve(); await gate.promise; } } });
  const sending = service.send("old"); await started.promise;
  let updated = false;
  const update = service.update({ revision: 0, ...second }).then(() => { updated = true; });
  const after = service.send("new"); await new Promise(resolve => setImmediate(resolve)); assert.equal(updated, false);
  gate.resolve(); await Promise.all([sending, update, after]);
  assert.deepEqual(delivered.map(item => item.config), [first, second]);
});

test("disk failures pause sends without committing a new channel, and test attempts persist before external delivery", async () => {
  const store = memory(initialNotifications([source("oil")])); const save = store.save;
  let fail = true, deliveries = 0;
  store.save = async state => { if (fail) throw Error("disk full"); await save(state); };
  const service = createNotificationService(store, { deliver: async () => { deliveries++; } });
  await assert.rejects(service.update({ revision: 0, ...second }), /保存失败/);
  assert.deepEqual(store.get().config, first); assert.equal(service.healthy(), false);
  await assert.rejects(service.send("alert"), /暂停/);
  await assert.rejects(service.test(), /保存失败/); assert.equal(deliveries, 0);
  fail = false; await service.update({ revision: 0, ...second }); assert.equal(service.healthy(), true);
  await service.test(); assert.equal(deliveries, 1);
  fail = true;
  await assert.rejects(service.update({ revision: 1, clearWebhook: true }), /保存失败/);
  assert.deepEqual(store.get().config, second);
});

test("failed tests record delivery errors and concurrent test aliases cannot bypass the shared cooldown", async () => {
  let deliveries = 0;
  const store = memory(initialNotifications([source("oil")]));
  const notifications = createNotificationService(store, { clock: () => 100000, deliver: async () => { deliveries++; throw Error("mock Feishu 19021"); } });
  const hynix = createAlertService(memory(initialState()), { notifications });
  const results = await Promise.allSettled([notifications.test(), hynix.test(), notifications.test()]);
  assert.equal(deliveries, 1); assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(store.get().testResult.status, "failed"); assert.match(store.get().testResult.error, /19021/);
  assert.equal(results[1].reason.status, 429);
});

test("a failed result write after a successful test still retains the persisted cooldown across restart", async () => {
  const store = memory(initialNotifications([source("oil")])), save = store.save;
  let delivered = 0;
  store.save = async state => { if (state.testResult?.status === "sent") throw Error("result write failed"); await save(state); };
  const options = { clock: () => 100000, deliver: async () => { delivered++; } };
  const service = createNotificationService(store, options);
  await assert.rejects(service.test(), /保存失败/); assert.equal(delivered, 1);
  assert.equal(service.healthy(), false); assert.equal(store.get().testResult.status, "sending");
  const restarted = createNotificationService(store, options);
  await assert.rejects(restarted.test(), error => error.status === 429); assert.equal(delivered, 1);
});

test("both monitors use shared changes immediately while their rules and delivery state remain independent", async () => {
  let now = 100000, premium = 45, spread = 5;
  const deliveries = [], notifications = createNotificationService(memory(), { clock: () => now, deliver: async (config, text) => { deliveries.push({ config, text }); } });
  const hynixStore = memory(initialState());
  const hynix = createAlertService(hynixStore, { notifications, clock: () => now, getQuote: async () => quote(now, premium) });
  await hynix.update({ enabled: true, cooldownSeconds: 0, hysteresis: 0.5, rules, revision: 0 });
  const oil = new Monitor({ store: { write: async () => {} }, data: { ...emptyStore(), config: { enabled: true, rules: [{ id: "spread", label: "原油规则", enabled: true, metric: "spread", operator: "gte", threshold: 5, cooldownMinutes: 0, hysteresis: 0.1 }] } },
    clock: () => now, fetchMarket: async () => ({ fetchedAt: new Date(now).toISOString(), brent: { markPx: 80 + spread }, wti: { markPx: 80 } }), webhookConfigured: notifications.configured, notify: notifications.send });
  await Promise.all([hynix.check(), oil.tick()]); assert.equal(deliveries.length, 0);
  assert.equal(hynix.view().history.length, 0); assert.equal(oil.data.events.length, 0);
  const beforeHynix = hynixStore.get(), beforeOil = structuredClone(oil.data);
  await notifications.update({ revision: 0, ...first });
  assert.deepEqual(hynixStore.get(), beforeHynix); assert.deepEqual(oil.data, beforeOil);
  assert.equal(hynix.view().config.webhookConfigured, true); assert.equal(oil.status().webhookConfigured, true);
  await Promise.all([hynix.check(), oil.tick()]); assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(item => item.config.webhookUrl === first.webhookUrl && item.config.signingSecret === first.signingSecret));
  await notifications.update({ revision: 1, ...second });
  now += 10000; await Promise.all([hynix.check(), oil.tick()]); assert.equal(deliveries.length, 2, "changing the robot must not rearm delivered rules");
  premium = 38; spread = 4; now += 10000; await Promise.all([hynix.check(), oil.tick()]);
  premium = 45; spread = 5; now += 10000; await Promise.all([hynix.check(), oil.tick()]);
  assert.equal(deliveries.length, 4); assert.ok(deliveries.slice(2).every(item => item.config.webhookUrl === second.webhookUrl && item.config.signingSecret === second.signingSecret));
  await notifications.update({ revision: 2, clearWebhook: true });
  premium = 38; spread = 4; now += 10000; await Promise.all([hynix.check(), oil.tick()]);
  premium = 45; spread = 5; now += 10000; await Promise.all([hynix.check(), oil.tick()]); assert.equal(deliveries.length, 4);
  assert.equal(oil.status().webhookConfigured, false); assert.equal(hynix.view().config.webhookConfigured, false);
  assert.equal(hynix.view().revision, 1); assert.equal(oil.data.revision, 0);
  for (const fields of [{ webhookUrl: first.webhookUrl }, { signingSecret: "bad" }, { clearWebhook: true }]) await assert.rejects(hynix.update({ ...hynix.view().config, revision: 1, ...fields }), /顶部/);
  assert.equal(hynixStore.get().config.webhookUrl, ""); assert.equal(hynixStore.get().config.signingSecret, "");
});

test("a quote that expires while waiting for the shared sender cannot generate an alert", async () => {
  let now = 100000; const gate = deferred(), started = deferred(), messages = [];
  const notifications = createNotificationService(memory(initialNotifications([source("oil")])), { clock: () => now, deliver: async (_config, text) => { messages.push(text); if (text === "block") { started.resolve(); await gate.promise; } } });
  const blocking = notifications.send("block"); await started.promise;
  const hynix = createAlertService(memory(initialState()), { notifications, clock: () => now, getQuote: async () => quote(now) });
  await hynix.update({ enabled: true, cooldownSeconds: 0, hysteresis: 0, rules, revision: 0 });
  const checking = hynix.check(); await new Promise(resolve => setImmediate(resolve)); now += 31000; gate.resolve();
  await Promise.all([blocking, checking]); assert.deepEqual(messages, ["block"]);
  assert.equal(hynix.view().ruleStates.up.armed, true); assert.match(hynix.view().status.lastError, /过期/);
});

test("oil also checks freshness after waiting behind other modules in the shared delivery queue", async () => {
  let now = 100000; const gate = deferred(), started = deferred(), messages = [];
  const notifications = createNotificationService(memory(initialNotifications([source("oil")])), { clock: () => now, deliver: async (_config, text) => { messages.push(text); if (text === "block") { started.resolve(); await gate.promise; } } });
  const blocking = notifications.send("block"); await started.promise;
  const oil = new Monitor({ store: { write: async () => {} }, data: { ...emptyStore(), config: { enabled: true, rules: [{ id: "up", label: "原油规则", enabled: true, metric: "spread", operator: "gte", threshold: 5, cooldownMinutes: 0, hysteresis: 0.1 }] } },
    clock: () => now, fetchMarket: async () => ({ fetchedAt: new Date(now).toISOString(), brent: { markPx: 85 }, wti: { markPx: 80 } }), webhookConfigured: notifications.configured, notify: notifications.send });
  const checking = oil.tick(); await new Promise(resolve => setImmediate(resolve)); now += 90001; gate.resolve();
  await Promise.all([blocking, checking]); assert.deepEqual(messages, ["block"]);
  assert.notEqual(oil.data.states.up.alerted, true); assert.match(oil.deliveryError, /过期/);
});

test("runtime migration preserves the legacy file for failed-first-start rollback and future rule saves persist without local credentials", async t => {
  let restarted;
  t.after(async () => { if (restarted) { await Promise.all([...restarted.values()].map(service => service.stop())); await restarted.market.stop(); } });
  const directory = await temporary(t), hynixDirectory = join(directory, "hynix");
  const oldStore = await openStore(hynixDirectory), old = initialState();
  old.config = { ...old.config, ...first, enabled: true, rules }; old.revision = 7;
  old.ruleStates = { up: { armed: false, lastSentAt: 100000, lastAttemptAt: 100000 } };
  old.history = [{ id: "kept", time: new Date(100000).toISOString(), kind: "alert", status: "sent", rules: ["up"], error: "" }];
  await oldStore.save(old);
  const previousFile = await readFile(join(hynixDirectory, "alerts.json"), "utf8");
  let deliveries = 0;
  const services = await createMonitorServices(directory, { env: {}, notificationOptions: { deliver: async () => { deliveries++; } } });
  await Promise.all([...services.values()].map(service => service.stop()));
  await services.market.stop();
  assert.equal(await readFile(join(hynixDirectory, "alerts.json"), "utf8"), previousFile);
  assert.deepEqual((await openStore(hynixDirectory)).get(), old);
  assert.equal(services.notifications.view().webhookConfigured, true); assert.equal(deliveries, 0);
  restarted = await createMonitorServices(directory, { env: { OIL_FEISHU_WEBHOOK_URL: "ignored-invalid-legacy-url" }, notificationOptions: { deliver: async () => { deliveries++; } } });
  const view = await restarted.get("hynix").handle("alerts", "PUT", { ...old.config, webhookUrl: "", signingSecret: "", revision: 7 });
  assert.equal(view.config.webhookConfigured, true); assert.equal(view.revision, 8);
  const saved = (await openStore(hynixDirectory)).get();
  assert.equal(saved.version, 2); assert.equal(saved.config.webhookUrl, ""); assert.equal(saved.config.signingSecret, "");
  assert.deepEqual(saved.history, old.history); assert.deepEqual(saved.ruleStates, old.ruleStates);
});

test("the global API authenticates and validates writes, hides credentials, and keeps module test aliases on one throttle", async t => {
  let server, services;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); if (services) { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); } });
  const directory = await temporary(t); let deliveries = 0;
  services = await createMonitorServices(directory, { env: {}, notificationOptions: { deliver: async () => { deliveries++; } } });
  server = createServer(createHandler({ services, username: "admin", password: "test-password-123", nextHandler: (_request, response) => { response.writeHead(404); response.end(); } }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = `${base}/api/notifications/feishu`;
  const headers = { Authorization: `Basic ${Buffer.from("admin:test-password-123").toString("base64")}`, "Content-Type": "application/json" };
  const put = { method: "PUT", headers, body: JSON.stringify({ revision: 0, ...first }) };
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { ...put, headers: { ...headers, Origin: "https://wrong.invalid" } })).status, 403);
  assert.equal((await fetch(endpoint, { ...put, headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await fetch(endpoint, { ...put, headers: { ...headers, "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await fetch(endpoint, { ...put, body: "not-json" })).status, 400);
  assert.equal((await fetch(endpoint, { headers, method: "DELETE" })).status, 405);
  const result = await fetch(endpoint, put); assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const publicJson = await result.text(); assert.ok(!publicJson.includes(first.webhookUrl)); assert.ok(!publicJson.includes(first.signingSecret));
  assert.equal((await fetch(endpoint, put)).status, 409);
  const tests = await Promise.all(["/api/notifications/feishu/test", "/api/monitors/hynix/alerts/test", "/api/monitors/oil/test-notification"].map(path => fetch(`${base}${path}`, { method: "POST", headers, body: "{}" })));
  assert.deepEqual(tests.map(response => response.status).sort(), [200, 429, 429]); assert.equal(deliveries, 1);
  assert.deepEqual((await fetch(`${base}/healthz`).then(response => response.json())).monitors.sort(), ["hynix", "oil", "perpetual"]);
});
