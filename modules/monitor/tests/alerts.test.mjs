import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, unlink, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, evaluateRules, freshRuleState, isFreshQuote, validateConfig } from "../server/alert-engine.mjs";
import { createAlertService } from "../server/alert-service.mjs";
import { openStore, initialState } from "../server/alert-store.mjs";
import { createFeishuPayload, sendFeishu } from "../server/feishu.mjs";
import { loadQuote } from "../lib/quote-service.ts";

const webhookUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook";
const rule = (id, threshold, direction = "above") => ({ id, name: id, threshold, direction, enabled: true });
const config = rules => ({ ...DEFAULT_CONFIG, enabled: true, webhookUrl, rules });
const point = (premium, now) => ({ ordinary: 1000, adr: 100 * (1 + premium / 100), equivalent: 100, spread: premium, premium, fetchedAt: new Date(now).toISOString() });
function memoryStore() {
  let value = initialState();
  return { get: () => structuredClone(value), save: async state => { value = structuredClone(state); } };
}
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "hynix-alert-test-"));
  t.after(async () => {
    const absolute = resolve(dir);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/") + "hynix-alert-test-"));
    for (const file of await readdir(absolute)) await unlink(join(absolute, file));
    await rmdir(absolute);
  });
  return dir;
}

test("threshold boundaries support both directions and combine all crossed tiers", () => {
  const cfg = config([rule("upper-20", 20), rule("upper-30", 30), rule("lower-10", 10, "below")]);
  assert.deepEqual(evaluateRules(cfg, {}, 30, 1000).triggered.map(rule => rule.id), ["upper-20", "upper-30"]);
  assert.deepEqual(evaluateRules(cfg, {}, 10, 1000).triggered.map(rule => rule.id), ["lower-10"]);
  assert.equal(evaluateRules({ ...cfg, enabled: false }, {}, 30, 1000).triggered.length, 0);
});

test("delivered tiers rearm only beyond hysteresis and respect cooldown", () => {
  const cfg = { ...config([rule("up", 40)]), hysteresis: 0.5, cooldownSeconds: 60 };
  const states = { up: { armed: false, lastSentAt: 1000, lastAttemptAt: 1000 } };
  assert.equal(evaluateRules(cfg, states, 45, 62000).triggered.length, 0);
  assert.equal(evaluateRules(cfg, states, 39.5, 2000).states.up.armed, false);
  const reset = evaluateRules(cfg, states, 39.49, 2000).states;
  assert.equal(reset.up.armed, true);
  assert.equal(evaluateRules(cfg, reset, 40, 60999).triggered.length, 0);
  assert.equal(evaluateRules(cfg, reset, 40, 61000).triggered.length, 1);
  const lower = { ...cfg, rules: [rule("down", -10, "below")] };
  assert.equal(evaluateRules(lower, { down: states.up }, -9.5, 2000).states.down.armed, false);
  assert.equal(evaluateRules(lower, { down: states.up }, -9.49, 2000).states.down.armed, true);
});

test("zero hysteresis does not rearm at equality, zero cooldown permits a new crossing", () => {
  const cfg = { ...config([rule("up", 40)]), hysteresis: 0, cooldownSeconds: 0 };
  const states = { up: { armed: false, lastSentAt: 1000, lastAttemptAt: 1000 } };
  assert.equal(evaluateRules(cfg, states, 40, 2000).states.up.armed, false);
  const reset = evaluateRules(cfg, states, 39.99, 2000).states;
  assert.equal(evaluateRules(cfg, reset, 40, 3000).triggered.length, 1);
});

test("failed signals retry after 30 seconds only while the current price still meets the threshold", () => {
  const cfg = config([rule("up", 40)]);
  const states = { up: { ...freshRuleState(), lastAttemptAt: 1000 } };
  assert.equal(evaluateRules(cfg, states, 42, 30999).triggered.length, 0);
  assert.equal(evaluateRules(cfg, states, 42, 31000).triggered.length, 1);
  assert.equal(evaluateRules(cfg, states, 39.8, 31000).triggered.length, 0);
});

test("invalid configurations and unsafe webhook destinations are rejected", () => {
  for (const webhook of ["http://open.feishu.cn/open-apis/bot/v2/hook/x", "https://localhost/x", "https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/x", "https://open.feishu.cn/open-apis/bot/v2/hook/x?redirect=1"]) {
    assert.throws(() => validateConfig({ ...config([rule("a", 10)]), webhookUrl: webhook }));
  }
  assert.throws(() => validateConfig(config([rule("a", NaN)])));
  assert.throws(() => validateConfig(config([rule("a", 10), rule("a", 20)])));
  assert.throws(() => validateConfig({ ...config([]), webhookUrl: "" }));
  const previous = { ...config([rule("a", 10)]), signingSecret: "private-test-secret" };
  assert.equal(validateConfig({ ...previous, webhookUrl: "", signingSecret: "" }, previous).signingSecret, previous.signingSecret);
  assert.equal(validateConfig({ ...previous, clearSigningSecret: true }, previous).signingSecret, "");
});

test("receipt timestamps must be recent; missing or invalid prices never generate alerts", () => {
  const now = Date.parse("2026-09-11T09:00:00Z");
  assert.ok(isFreshQuote(point(40, now), now));
  assert.ok(!isFreshQuote(point(40, now - 30001), now));
  assert.ok(!isFreshQuote(point(40, now + 5001), now));
  assert.ok(!isFreshQuote({ ...point(40, now), ordinary: 0 }, now));
});

test("Feishu checks application response codes, disallows redirects, and signs with seconds", async () => {
  const now = Date.parse("2026-09-11T09:00:00Z");
  const payload = createFeishuPayload("test", "test-secret", now);
  assert.equal(payload.timestamp, "1789117200");
  assert.equal(Buffer.from(payload.sign, "base64").length, 32);
  assert.deepEqual(createFeishuPayload("test"), { msg_type: "text", content: { text: "test" } });
  await sendFeishu({ webhookUrl, signingSecret: "test-secret" }, "海力士价差告警", { now, fetcher: async (url, init) => {
    assert.equal(url, webhookUrl); assert.equal(init.redirect, "error");
    assert.equal(JSON.parse(init.body).timestamp, "1789117200");
    return Response.json({ code: 0 });
  } });
  await assert.rejects(sendFeishu({ webhookUrl }, "test", { fetcher: async () => Response.json({ code: 19021 }) }), /19021/);
  await assert.rejects(sendFeishu({ webhookUrl }, "test", { fetcher: async () => Response.json({ code: 0 }, { status: 429 }) }), /HTTP 429/);
  await assert.rejects(sendFeishu({ webhookUrl }, "test", { fetcher: async () => Response.json({ StatusCode: 0 }) }));
});

test("background checks deliver without any browser request and survive restart without duplicate delivery", async t => {
  const directory = await temporary(t);
  let now = Date.parse("2026-09-11T09:00:00Z"), sent = 0;
  const store = await openStore(directory);
  const service = createAlertService(store, { clock: () => now, getQuote: async () => point(45, now), deliver: async (_config, text) => { sent++; assert.match(text, /upper-40/); assert.match(text, /upper-44/); } });
  await service.update({ ...config([rule("upper-40", 40), rule("upper-44", 44)]), revision: 0 });
  await service.check();
  assert.equal(sent, 1); assert.equal(service.view().history.length, 1);
  now += 10000; await service.check(); assert.equal(sent, 1);
  const loaded = await openStore(directory);
  const restarted = createAlertService(loaded, { clock: () => now, getQuote: async () => point(46, now), deliver: async () => { sent++; } });
  await restarted.check(); assert.equal(sent, 1);
  assert.equal(restarted.view().config.webhookConfigured, true);
  assert.ok(!JSON.stringify(restarted.view()).includes("test-webhook"));
  if (process.platform !== "win32") assert.equal((await stat(join(directory, "alerts.json"))).mode & 0o777, 0o600);
});

test("delivery failure does not disarm the rule and a withdrawn signal is not sent later", async () => {
  let now = 100000, premium = 45, attempts = 0;
  const service = createAlertService(memoryStore(), { clock: () => now, getQuote: async () => point(premium, now), deliver: async () => { attempts++; throw new Error("mock failure"); } });
  await service.update({ ...config([rule("up", 40)]), revision: 0 });
  await service.check(); assert.equal(attempts, 1);
  assert.equal(service.view().ruleStates.up.armed, true);
  now += 10000; await service.check(); assert.equal(attempts, 1);
  now += 20000; premium = 39.8; await service.check(); assert.equal(attempts, 1);
  now += 10000; premium = 41; await service.check(); assert.equal(attempts, 2);
});

test("a funding-only API outage leaves live premium alerts and cached quotes working", async () => {
  const now = Date.parse("2026-09-11T09:00:00Z");
  let sent = 0;
  const service = createAlertService(memoryStore(), {
    clock: () => now,
    getQuote: () => loadQuote(async (_url, init) => JSON.parse(init.body).type === "allMids"
      ? Response.json({ "xyz:SKHX": "1000", "xyz:SKHY": "150" })
      : Response.json({ error: "funding unavailable" }, { status: 503 }), () => now),
    deliver: async () => { sent++; },
  });
  await service.update({ ...config([rule("up", 40)]), revision: 0 });
  await service.check();
  assert.equal(sent, 1);
  assert.equal(service.view().status.lastError, "");
  const quote = await service.quote();
  assert.equal(quote.premium, 50);
  assert.equal(quote.funding, null);
});

test("network failure and a stale quote at send time cannot deliver a notification", async () => {
  let now = 100000, sent = 0;
  const store = memoryStore();
  const save = store.save;
  store.save = async state => { await save(state); if (state.ruleStates.up?.lastAttemptAt === now) now += 31000; };
  const service = createAlertService(store, { clock: () => now, getQuote: async () => point(45, now), deliver: async () => { sent++; } });
  await service.update({ ...config([rule("up", 40)]), revision: 0 });
  await service.check(); assert.equal(sent, 0); assert.match(service.view().status.lastError, /过期/);
  const offline = createAlertService(store, { clock: () => now, getQuote: async () => { throw new Error("network"); }, deliver: async () => { sent++; } });
  await offline.check(); assert.equal(sent, 0); assert.match(offline.view().status.lastError, /暂停本轮告警/);
});

test("ordinary saves retain delivery state; edits and stale revisions are handled explicitly", async () => {
  let now = 100000, sent = 0;
  const service = createAlertService(memoryStore(), { clock: () => now, getQuote: async () => point(45, now), deliver: async () => { sent++; } });
  await service.update({ ...config([rule("up", 40)]), revision: 0 });
  await service.check();
  await service.update({ ...config([{ ...rule("up", 40), name: "renamed" }]), revision: 1 });
  now += 10000; await service.check(); assert.equal(sent, 1);
  await assert.rejects(service.update({ ...config([rule("up", 40)]), revision: 1 }), /另一页面/);
  await service.update({ ...config([rule("up", 44)]), revision: 2 });
  now += 10000; await service.check(); assert.equal(sent, 2);
});

test("a failed disk write after delivery is retried before evaluating another notification", async () => {
  let now = 100000, sent = 0, failed = false;
  const store = memoryStore(), save = store.save;
  store.save = async state => {
    if (state.history.some(item => item.status === "sent") && !failed) { failed = true; throw new Error("disk full"); }
    await save(state);
  };
  const service = createAlertService(store, { clock: () => now, getQuote: async () => point(45, now), deliver: async () => { sent++; } });
  await service.update({ ...config([rule("up", 40)]), revision: 0 });
  await assert.rejects(service.check(), /disk full/);
  assert.equal(sent, 1); assert.match(service.view().status.lastError, /磁盘保存失败/);
  now += 30000; await service.check();
  assert.equal(sent, 1); assert.equal(service.view().ruleStates.up.armed, false);
});

test("store writes are complete JSON and reloading never silently overwrites corruption", async t => {
  const directory = await temporary(t), store = await openStore(directory);
  const a = initialState(), b = initialState(); a.revision = 1; b.revision = 2;
  await Promise.all([store.save(a), store.save(b)]);
  assert.equal(JSON.parse(await readFile(join(directory, "alerts.json"), "utf8")).revision, 2);
  const broken = { ...b, version: 999 };
  await store.save(broken);
  await assert.rejects(openStore(directory), /无法读取告警状态文件/);
  assert.equal(JSON.parse(await readFile(join(directory, "alerts.json"), "utf8")).version, 999);
});

test("resident scheduler polls every 10 seconds and stops without depending on page visits", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0, now = 100000;
  const service = createAlertService(memoryStore(), { clock: () => now, getQuote: async () => { calls++; return point(10, now); } });
  service.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  now += 10000; t.mock.timers.tick(10000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  await service.stop(); t.mock.timers.tick(30000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("optional per-rule controls preserve inheritance and validate explicit zero", () => {
  const inherited = validateConfig(config([rule("up", 40)])).rules[0];
  assert.equal(Object.hasOwn(inherited, "cooldownSeconds"), false);
  assert.equal(Object.hasOwn(inherited, "hysteresis"), false);
  const explicit = validateConfig(config([{ ...rule("up", 40), cooldownSeconds: 0, hysteresis: 0 }])).rules[0];
  assert.equal(explicit.cooldownSeconds, 0); assert.equal(explicit.hysteresis, 0);
  for (const value of [null, "", "90", false, NaN, Infinity, -1, 0.5, 86401]) assert.throws(() => validateConfig(config([{ ...rule("up", 40), cooldownSeconds: value }])));
  for (const value of [null, "", "0.5", false, NaN, Infinity, -0.1, 100.01]) assert.throws(() => validateConfig(config([{ ...rule("up", 40), hysteresis: value }])));
});

test("each tier independently applies cooldown and hysteresis with global fallback", () => {
  const cfg = { ...config([rule("inherited", 40), { ...rule("zero", 40), cooldownSeconds: 0, hysteresis: 0 }, { ...rule("slow", 40), cooldownSeconds: 120, hysteresis: 2 }]), cooldownSeconds: 60, hysteresis: 1 };
  const states = armed => Object.fromEntries(cfg.rules.map(item => [item.id, { armed, lastSentAt: 1000, lastAttemptAt: 1000 }]));
  const triggered = now => evaluateRules(cfg, states(true), 45, now).triggered.map(item => item.id);
  assert.deepEqual(triggered(1001), ["zero"]);
  assert.deepEqual(triggered(61000), ["inherited", "zero"]);
  assert.deepEqual(triggered(121000), ["inherited", "zero", "slow"]);
  const reset = evaluateRules(cfg, states(false), 39.5, 2000).states;
  assert.equal(reset.inherited.armed, false); assert.equal(reset.zero.armed, true); assert.equal(reset.slow.armed, false);
  assert.equal(evaluateRules(cfg, states(false), 39, 2000).states.inherited.armed, false);
  assert.equal(evaluateRules(cfg, states(false), 38, 2000).states.slow.armed, false);
  assert.equal(evaluateRules(cfg, states(false), 37.99, 2000).states.slow.armed, true);
});

test("decimal reset equality remains strict and zero cooldown retains failed-send retry", () => {
  const lower = config([{ ...rule("down", 0.3, "below"), hysteresis: 0.6 }]);
  const delivered = { down: { armed: false, lastSentAt: 1000, lastAttemptAt: 1000 } };
  assert.equal(evaluateRules(lower, delivered, 0.9, 2000).states.down.armed, false);
  assert.equal(evaluateRules(lower, delivered, 0.9001, 2000).states.down.armed, true);
  const upper = config([{ ...rule("up", 40), cooldownSeconds: 0, hysteresis: 0 }]);
  const failed = { up: { ...freshRuleState(), lastAttemptAt: 1000 } };
  assert.equal(evaluateRules(upper, failed, 42, 30999).triggered.length, 0);
  assert.equal(evaluateRules(upper, failed, 42, 31000).triggered.length, 1);
  assert.equal(evaluateRules(upper, failed, 39, 31000).triggered.length, 0);
});

test("saving optional controls or names preserves successful delivery state and history", async () => {
  let now = 100000, sent = 0;
  const baseRule = rule("up", 40), cfg = config([baseRule]);
  const service = createAlertService(memoryStore(), { clock: () => now, getQuote: async () => point(45, now), deliver: async () => { sent++; } });
  await service.update({ ...cfg, revision: 0 }); await service.check();
  const before = service.view();
  const edits = [{ ...baseRule, cooldownSeconds: cfg.cooldownSeconds, hysteresis: cfg.hysteresis }, { ...baseRule, name: "renamed", cooldownSeconds: 0, hysteresis: 0 }, baseRule];
  for (let index = 0; index < edits.length; index++) {
    await service.update({ ...cfg, rules: [edits[index]], revision: index + 1 });
    assert.deepEqual(service.view().ruleStates, before.ruleStates);
    now += 10000; await service.check();
    assert.equal(sent, 1); assert.deepEqual(service.view().history, before.history);
  }
  await service.stop();
});

test("legacy v1/v2 inherited rules load without rewriting existing files", async t => {
  for (const version of [1, 2]) {
    const directory = await temporary(t), store = await openStore(directory), state = initialState();
    state.version = version; state.revision = 7;
    state.config = { ...config([rule("inherited", 40)]), webhookUrl: version === 1 ? webhookUrl : "", cooldownSeconds: 90, hysteresis: 0.25 };
    state.ruleStates = { inherited: { armed: false, lastSentAt: 100000, lastAttemptAt: 100000 } };
    await store.save(state);
    const file = join(directory, "alerts.json"), original = await readFile(file, "utf8");
    const reopened = await openStore(directory);
    assert.deepEqual(reopened.get(), state); assert.equal(await readFile(file, "utf8"), original);
    assert.equal(Object.hasOwn(reopened.get().config.rules[0], "cooldownSeconds"), false);
  }
});

test("saved per-rule seconds and hysteresis survive restart with sent state intact", async t => {
  const directory = await temporary(t), store = await openStore(directory);
  let now = 100000, premium = 45, sent = 0;
  const notifications = { configured: () => true, view: () => ({ signingSecretConfigured: false }), send: async () => { sent++; } };
  const options = { notifications, clock: () => now, getQuote: async () => point(premium, now) };
  const service = createAlertService(store, options);
  await service.update({ revision: 0, enabled: true, cooldownSeconds: 600, hysteresis: 3, rules: [{ ...rule("up", 40), cooldownSeconds: 90, hysteresis: 0.25 }] });
  await service.check(); assert.equal(sent, 1);
  const saved = store.get(); assert.equal(saved.version, 2); assert.equal(saved.config.rules[0].cooldownSeconds, 90);
  await service.stop();
  const reopened = await openStore(directory); assert.deepEqual(reopened.get(), saved);
  const restarted = createAlertService(reopened, options);
  now = 100001; premium = 39.75; await restarted.check(); assert.equal(restarted.view().ruleStates.up.armed, false);
  now = 100002; premium = 39.74; await restarted.check(); assert.equal(restarted.view().ruleStates.up.armed, true);
  now = 189999; premium = 40; await restarted.check(); assert.equal(sent, 1);
  now = 190000; await restarted.check(); assert.equal(sent, 2);
  await restarted.stop();
});
