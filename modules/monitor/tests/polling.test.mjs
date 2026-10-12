import { test } from "node:test";
import assert from "node:assert/strict";
import { startActivityPolling, startPolling, QUOTE_REFRESH_MS } from "../lib/polling.ts";
import { loadQuote } from "../lib/quote-service.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));

test("a transport that ignores cancellation cannot pin polling or overwrite recovered data", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, finish, firstSignal, settled = 0;
  const values = [], errors = [];
  const poll = startPolling({ intervalMs: 10_000, timeoutMs: 5000,
    load: signal => { calls++; if (calls === 1) { firstSignal = signal; return new Promise(resolve => { finish = resolve; }); } return Promise.resolve(calls); },
    onData: value => values.push(value), onError: error => errors.push(error), onSettled: () => settled++ });
  t.after(() => poll.stop()); await flush();
  const shared = poll.refresh(); assert.equal(shared, poll.refresh());
  t.mock.timers.tick(5000); await shared;
  assert.equal(firstSignal.aborted, true); assert.equal(errors[0].name, "TimeoutError"); assert.equal(settled, 1);
  await poll.refresh(); assert.deepEqual(values, [2]);
  finish(1); await flush(); assert.deepEqual(values, [2]); assert.equal(settled, 2);
});

test("offline pauses reads and online resumes once, ignoring late results from the previous connection", async t => {
  const network = Object.assign(new EventTarget(), { onLine: false });
  let calls = 0, finish, signal;
  const values = [];
  const poll = startActivityPolling({ network, intervalMs: 10_000, immediate: false,
    load: s => { signal = s; calls++; return new Promise(resolve => { finish = resolve; }); }, onData: value => values.push(value), onError: assert.fail });
  t.after(() => poll.stop()); await flush(); assert.equal(calls, 0);
  network.onLine = true; network.dispatchEvent(new Event("online")); await flush(); assert.equal(calls, 1);
  const oldFinish = finish;
  network.onLine = false; network.dispatchEvent(new Event("offline")); assert.equal(signal.aborted, true);
  network.onLine = true; network.dispatchEvent(new Event("online")); network.dispatchEvent(new Event("online"));
  await flush(); assert.equal(calls, 2); finish(2); await flush(); oldFinish(1); await flush(); assert.deepEqual(values, [2]);
});

test("inactive panels create no reads; restoring activity immediately resumes without clearing retained data", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const page = Object.assign(new EventTarget(), { hidden: false });
  let calls = 0, retained = "initial";
  const poll = startActivityPolling({ active: false, page, intervalMs: 10000, load: async () => ++calls, onData: value => { retained = value; }, onError: assert.fail });
  t.after(() => poll.stop());
  t.mock.timers.tick(60000); await flush(); assert.equal(calls, 0);
  poll.setActive(true); await flush(); assert.equal(retained, 1);
  poll.setActive(false); t.mock.timers.tick(60000); await flush(); assert.equal(calls, 1); assert.equal(retained, 1);
  poll.setActive(true); await flush(); assert.equal(calls, 2);
  page.hidden = true; page.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(29_999); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 3);
  t.mock.timers.tick(30_000); await flush(); assert.equal(calls, 4);
  page.hidden = false; page.dispatchEvent(new Event("visibilitychange")); await flush(); assert.equal(calls, 5);
});

test("pausing aborts the panel read, suppresses late results and leaves unrelated save operations alive", async t => {
  const page = Object.assign(new EventTarget(), { hidden: false });
  const mutation = new AbortController();
  let requestSignal, finish;
  const values = [];
  const poll = startActivityPolling({ page, intervalMs: 10000, load: signal => { requestSignal = signal; return new Promise(resolve => { finish = resolve; }); }, onData: value => values.push(value), onError: assert.fail });
  t.after(() => poll.stop()); await flush();
  poll.setActive(false); assert.equal(requestSignal.aborted, true); assert.equal(mutation.signal.aborted, false);
  finish("old read"); await flush(); assert.deepEqual(values, []);
  poll.setActive(true); await flush(); finish("new read"); await flush(); assert.deepEqual(values, ["new read"]);
});

test('hydrated history skips the duplicate first request but polls at its existing cadence and supports immediate manual refresh', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  let calls = 0;
  const poll = startPolling({ intervalMs:60_000, immediate:false, load:async()=>++calls, onData:()=>{}, onError:assert.fail });
  await flush(); assert.equal(calls,0);
  t.mock.timers.tick(59_999); await flush(); assert.equal(calls,0);
  t.mock.timers.tick(1); await flush(); assert.equal(calls,1);
  await poll.refresh(); assert.equal(calls,2);
  poll.stop(); t.mock.timers.tick(60_000); await flush(); assert.equal(calls,2);
});

test('an unmounted hydrated panel cancels its scheduled first fetch', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  let calls=0;
  const poll=startPolling({intervalMs:60_000,immediate:false,load:async()=>++calls,onData:()=>{},onError:assert.fail});
  poll.stop();t.mock.timers.tick(60_000);await flush();assert.equal(calls,0);
});

test("fetch immediately and at 10-second intervals without overlapping manual refresh",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});
  let calls=0,resolvePending;
  const results=[];
  const poll=startPolling({intervalMs:QUOTE_REFRESH_MS,load:()=>{calls++;return new Promise(resolve=>{resolvePending=resolve;});},onData:v=>results.push(v),onError:assert.fail});
  await flush(); assert.equal(calls,1);
  t.mock.timers.tick(10_000); void poll.refresh();
  await flush(); assert.equal(calls,1);
  resolvePending(1); await flush();
  t.mock.timers.tick(9_999); await flush(); assert.equal(calls,1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls,2);
  resolvePending(2); await flush();
  assert.deepEqual(results,[1,2]);
  poll.stop(); t.mock.timers.tick(30_000); await flush(); assert.equal(calls,2);
});

test("cancel on unmount and ignore a late result even if transport ignores abort",async()=>{
  let signal,resolvePending;
  const results=[];
  const poll=startPolling({intervalMs:10_000,load:s=>{signal=s;return new Promise(resolve=>{resolvePending=resolve;});},onData:v=>results.push(v),onError:assert.fail});
  await flush(); poll.stop(); assert.equal(signal.aborted,true);
  resolvePending("late"); await flush(); assert.deepEqual(results,[]);
});

test("recover next cycle after a request failure without replacing the last success",async t=>{
  t.mock.timers.enable({apis:["setInterval"]});
  let calls=0,errors=0,last;
  const poll=startPolling({intervalMs:10_000,load:async()=>{calls++;if(calls===2)throw new Error("offline");return calls;},onData:v=>{last=v;},onError:()=>{errors++;}});
  await flush(); assert.equal(last,1);
  t.mock.timers.tick(10_000); await flush(); assert.equal(last,1);assert.equal(errors,1);
  t.mock.timers.tick(10_000); await flush(); assert.equal(last,3);
  poll.stop();
});

test("read both current mids together and request funding alongside them",async()=>{
  const time=Date.parse("2026-09-11T07:00:00Z");
  const requests=[];
  const quote=await loadQuote(async(url,init)=>{
    assert.equal(url,"https://api.hyperliquid.xyz/info");
    const body=JSON.parse(init.body);
    requests.push(body);
    if(body.type==="metaAndAssetCtxs") return Response.json([{universe:[{name:"xyz:SKHX"},{name:"xyz:SKHY"}]},[{oraclePx:"1500",funding:"0"},{oraclePx:"180",funding:"0"}]]);
    return Response.json({"xyz:SKHX":"1500","xyz:SKHY":"180"});
  },()=>time);
  assert.deepEqual(requests,[{type:"allMids",dex:"xyz"},{type:"metaAndAssetCtxs",dex:"xyz"}]);
  assert.equal(quote.equivalent,150);assert.equal(quote.spread,30);
  assert.ok(Math.abs(quote.premium-20)<1e-10);
  assert.equal(quote.fetchedAt,"2026-09-11T07:00:00.000Z");
  assert.equal(quote.funding.annualizedRate,0);
  assert.equal(quote.funding.fetchedAt,quote.fetchedAt);
});

test("partial, zero, invalid or failed live quotes never become a fresh pair",async()=>{
  for(const body of [{"xyz:SKHX":"1500"},{"xyz:SKHX":"0","xyz:SKHY":"180"},{"xyz:SKHX":"NaN","xyz:SKHY":"180"},null]){
    await assert.rejects(loadQuote(async()=>Response.json(body)));
  }
  await assert.rejects(loadQuote(async()=>Response.json({error:"limited"},{status:429})));
});
