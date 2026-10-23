import { test } from "node:test";
import assert from "node:assert/strict";
import { startActivityPolling } from "../lib/polling.ts";
import { loadSettings } from "../lib/settings-load.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));
const abortableRead = signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

function settingsPanel(t, read, initialView = null) {
  const lifetime = new AbortController();
  const page = Object.assign(new EventTarget(), { hidden: false });
  const state = { view: initialView, draft: "未保存的草稿", error: "", errors: [], generation: 0, request: 0 };
  const poll = startActivityPolling({
    intervalMs: 10_000, page,
    load: signal => {
      const generation = state.generation, request = ++state.request;
      return loadSettings({
        signal: AbortSignal.any([lifetime.signal, signal]),
        load: read,
        isCurrent: () => !lifetime.signal.aborted && generation === state.generation && request === state.request,
        onData: next => { state.view = next; state.error = ""; },
        onError: timedOut => { state.error = timedOut ? "读取超时，现有配置与草稿已保留" : "无法读取设置"; state.errors.push(state.error); },
      });
    },
    onData: () => {}, onError: () => {},
  });
  t.after(() => { lifetime.abort(); poll.stop(); });
  return { state, poll, page, lifetime };
}

for (const initialView of [null, "上次成功的配置"]) {
  test(`settings polling timeout reports one error and retains ${initialView === null ? "initial state" : "existing configuration"}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let calls = 0;
    const { state, poll } = settingsPanel(t, signal => ++calls === 1 ? abortableRead(signal) : Promise.resolve("最新配置"), initialView);
    await flush();
    t.mock.timers.tick(15_000); await flush();
    assert.equal(state.error, "读取超时，现有配置与草稿已保留");
    assert.equal(state.errors.length, 1);
    assert.equal(state.view, initialView);
    assert.equal(state.draft, "未保存的草稿");
    await poll.refresh();
    assert.equal(state.error, "");
    assert.equal(state.view, "最新配置");
    assert.equal(state.errors.length, 1);
  });
}

for (const cancellation of ["pause", "stop", "unmount"]) {
  test(`settings ${cancellation} cancels silently and keeps configuration and draft`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let requestSignal;
    const { state, poll, lifetime } = settingsPanel(t, signal => { requestSignal = signal; return abortableRead(signal); }, "原有配置");
    await flush();
    if (cancellation === "pause") poll.setActive(false);
    else if (cancellation === "stop") poll.stop();
    else { lifetime.abort(); poll.stop(); }
    t.mock.timers.tick(30_000); await flush();
    assert.equal(requestSignal.aborted, true);
    assert.equal(requestSignal.reason.name, "AbortError");
    assert.deepEqual(state.errors, []);
    assert.equal(state.view, "原有配置");
    assert.equal(state.draft, "未保存的草稿");
  });
}

test("a replacement read suppresses the cancelled request's late rejection", async t => {
  let calls = 0, rejectOld, oldSignal;
  const { state, page } = settingsPanel(t, signal => {
    if (++calls === 1) { oldSignal = signal; return new Promise((_, reject) => { rejectOld = reject; }); }
    return Promise.resolve("新请求的配置");
  });
  await flush();
  page.dispatchEvent(new Event("visibilitychange")); await flush();
  assert.equal(oldSignal.reason.name, "AbortError");
  assert.equal(calls, 2);
  rejectOld(new Error("被替换的旧请求")); await flush();
  assert.deepEqual(state.errors, []);
  assert.equal(state.view, "新请求的配置");
});

for (const failure of ["timeout", "network"]) {
  test(`settings ${failure} from an older configuration generation stays silent`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let rejectRead;
    const { state } = settingsPanel(t, signal => failure === "timeout" ? abortableRead(signal) : new Promise((_, reject) => { rejectRead = reject; }), "已保存的新配置");
    await flush();
    state.generation++;
    if (failure === "timeout") t.mock.timers.tick(15_000);
    else rejectRead(new Error("旧配置读取失败"));
    await flush();
    assert.deepEqual(state.errors, []);
    assert.equal(state.view, "已保存的新配置");
  });
}

test("a late timeout rejection cannot replace a newer successful read with an error", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, rejectOld, oldSignal;
  const { state, poll } = settingsPanel(t, signal => {
    if (++calls === 1) { oldSignal = signal; return new Promise((_, reject) => { rejectOld = reject; }); }
    return Promise.resolve("恢复后的配置");
  });
  await flush();
  t.mock.timers.tick(15_000); await flush();
  assert.equal(oldSignal.reason.name, "TimeoutError");
  await poll.refresh();
  rejectOld(oldSignal.reason); await flush();
  assert.deepEqual(state.errors, []);
  assert.equal(state.view, "恢复后的配置");
});

test("an ordinary settings read failure reports an error while retaining configuration and draft", async t => {
  const { state } = settingsPanel(t, async () => { throw new Error("后台不可用"); }, "原有配置");
  await flush();
  assert.deepEqual(state.errors, ["无法读取设置"]);
  assert.equal(state.view, "原有配置");
  assert.equal(state.draft, "未保存的草稿");
});
