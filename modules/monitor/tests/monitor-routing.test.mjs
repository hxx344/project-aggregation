import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHandler } from "../server/http.mjs";
import { monitors } from "../lib/monitors.ts";
import { createDataReader } from "../lib/monitor-service.ts";

test('new oil comparisons cannot dispatch through Hynix preview routes', async () => {
  const calls = [];
  const read = createDataReader({ oil: { quote: async () => ({}) }, hynix: { quote: async () => ({}) } }, Date.now, async (exchange, id) => { calls.push([exchange, id]); return { exchange, id }; });
  for (const exchange of ['lighter', 'variational', 'okx', 'bitget']) {
    assert.deepEqual(await read('oil', `exchanges/${exchange}/quote`), { exchange, id: 'oil' });
    await assert.rejects(read('hynix', `exchanges/${exchange}/quote`), /Unsupported/);
  }
  assert.equal(calls.length, 4);
});

test("registered modules isolate cached requests and retry failed live quotes", async () => {
  let calls = 0, now = 100, fail = false;
  const read = createDataReader({ oil: { quote: async () => { calls++; if (fail) throw Error("offline"); return { brent: 80 }; }, history: async () => ({ status: "snapshot", fetchedAt: "original" }) }, hynix: { quote: async () => ({ premium: 2 }), history: async () => ({}) } }, () => now);
  assert.deepEqual(await Promise.all([read("oil", "quote"),read("oil", "quote")]), [{ brent: 80 },{ brent: 80 }]);
  assert.equal(calls, 1);
  assert.deepEqual(await read("hynix", "quote"), { premium: 2 });
  now += 6000; fail = true;
  await assert.rejects(read("oil", "quote"));
  await assert.rejects(read("oil", "quote"));
  assert.equal(calls, 3);
  assert.equal((await read("oil", "history")).fetchedAt, "original");
  await assert.rejects(read("__proto__", "quote"));
  assert.equal(new Set(monitors.map(m => m.id)).size, monitors.length);
});

test('perpetual preview exposes only its own quote adapter and cannot borrow fixed-market exchange routes', async () => {
  let externalCalls = 0;
  const read = createDataReader({ perpetual: { quote: async () => ({ status: 'unavailable', quotes: [] }) } }, Date.now, async () => { externalCalls++; });
  assert.equal((await read('perpetual', 'quote')).status, 'unavailable');
  await assert.rejects(read('perpetual', 'exchanges/binance/quote'), /Unsupported/);
  await assert.rejects(read('perpetual', 'history'), /Unsupported/);
  assert.equal(externalCalls, 0);
});

test("15-minute candles have an independent one-minute cache, shorter retained-data retry and explicit module capability", async () => {
  let now = 0, calls = 0, status = 'live';
  const read = createDataReader({ oil: { quote: async () => ({}), history: async () => ({ kind: 'daily' }), 'candles/15m': async () => ({ kind: '15m', status, call: ++calls }) }, hynix: { quote: async () => ({}), history: async () => ({}) } }, () => now);
  assert.equal((await read('oil', 'history')).kind, 'daily');
  assert.equal((await read('oil', 'candles/15m')).call, 1);
  now = 59_000;
  assert.equal((await read('oil', 'candles/15m')).call, 1);
  now = 60_001; status = 'snapshot';
  assert.equal((await read('oil', 'candles/15m')).call, 2);
  now += 15_001;
  assert.equal((await read('oil', 'candles/15m')).call, 3);
  await assert.rejects(read('hynix', 'candles/15m'));
  assert.ok(monitors.find(item => item.id === 'oil').capabilities.includes('candles/15m'));
});

test("module APIs authenticate, protect writes and keep revisions separate", async t => {
  const state = { oil: 0, hynix: 0 };
  const services = new Map(Object.keys(state).map(id => [id, { actions: { config: ["GET", "PUT"] }, async handle(_action, method, input) { if (method === "PUT") { if (input.revision !== state[id]) { const error=Error("conflict"); error.status=409; throw error; } state[id]++; } return { revision: state[id], id }; } }]));
  const server=createServer(createHandler({ services, username:"admin", password:"test-password-123", nextHandler:(_q,r)=>{r.writeHead(404);r.end();} }));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={ Authorization:`Basic ${Buffer.from("admin:test-password-123").toString("base64")}`, "Content-Type":"application/json" };
  assert.equal((await fetch(`${base}/api/monitors/oil/config`)).status,401);
  const put={method:"PUT",headers,body:'{"revision":0}'};
  assert.equal((await fetch(`${base}/api/monitors/oil/config`,{...put,headers:{...headers,Origin:"https://wrong.invalid"}})).status,403);
  assert.equal((await fetch(`${base}/api/monitors/oil/config`,put)).status,200);
  assert.equal((await fetch(`${base}/api/monitors/oil/config`,put)).status,409);
  assert.equal(state.hynix,0);
  assert.equal((await fetch(`${base}/api/monitors/hynix/config`,put)).status,200);
  assert.equal((await fetch(`${base}/api/monitors/unknown/config`,{headers})).status,404);
  assert.equal((await fetch(`${base}/api/monitors/oil/config`,{headers,method:"DELETE"})).status,405);
  services.get("oil").healthy = () => false;
  assert.equal((await fetch(`${base}/healthz`)).status,503);
  services.get("oil").healthy = () => true;
  assert.equal((await fetch(`${base}/healthz`)).status,200);
});
