import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClients } from '../server/clients.mjs';

const NOW = 1790067200000;
const gate = () => ({ current: NOW, update: NOW - 1000, bids: [['0.98', '50']], asks: [['0.99', '60']] });
const kraken = () => ({ error: [], result: { USDTZUSD: { bids: [['0.95', '80', (NOW - 2000) / 1000]], asks: [['1.02', '100', (NOW - 3000) / 1000]] } } });

test('FX preserves Gate USDC prices and conservatively inverts Kraken USD bid/ask', async () => {
  const requests = [], clients = createPublicClients({ clock: () => NOW, fetcher: async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify(url.includes('gateio') ? gate() : kraken())); } });
  const fx = await clients.loadFx();
  assert.equal(fx.baseCurrency, 'USDT'); assert.equal(fx.staleAfterMs, 180_000); assert.equal(fx.rates.USDT.bid, 1);
  assert.equal(fx.rates.USDC.bid, 0.98); assert.equal(fx.rates.USDC.ask, 0.99); assert.equal(fx.rates.USDC.at, NOW - 1000);
  assert.equal(fx.rates.USD.bid, 1 / 1.02); assert.equal(fx.rates.USD.ask, 1 / 0.95); assert.equal(fx.rates.USD.at, NOW - 3000);
  assert.deepEqual(fx.reasons, {}); assert.strictEqual(await clients.loadFx(), fx); assert.equal(requests.length, 2);
  for (const { init } of requests) { assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, undefined); assert.equal(init.redirect, 'error'); }
});

test('cached fallback retains source timestamps and expires despite new batch generation times', async () => {
  let now = NOW, failing = false;
  const clients = createPublicClients({ clock: () => now, fetcher: async url => { if (failing) throw Error('offline'); return new Response(JSON.stringify(url.includes('gateio') ? gate() : kraken())); } });
  const first = await clients.loadFx(); failing = true; now += 60_001;
  const second = await clients.loadFx();
  assert.equal(second.generatedAt, now); assert.equal(second.rates.USD.at, first.rates.USD.at); assert.equal(second.rates.USDC.at, first.rates.USDC.at); assert.match(second.reasons.USD, /沿用/);
  now += 120_000;
  const third = await clients.loadFx(); assert.equal(third.rates.USD, undefined); assert.equal(third.rates.USDC, undefined); assert.equal(third.rates.USDT.bid, 1); assert.ok(third.reasons.USD);
});

test('FX rejects stale, future, missing, crossed and zero-liquidity sources independently', async () => {
  for (const change of [
    (g, k) => { g.update = NOW - 180_001; k.result.USDTZUSD.bids[0][2] = (NOW - 180_001) / 1000; },
    (g, k) => { g.update = NOW + 1001; k.result.USDTZUSD.asks[0][2] = (NOW + 1001) / 1000; },
    (g, k) => { delete g.update; delete k.result.USDTZUSD.bids[0][2]; },
    (g, k) => { g.bids[0][0] = '1.1'; k.result.USDTZUSD.bids[0][0] = '1.1'; },
    (g, k) => { g.asks[0][1] = '0'; k.result.USDTZUSD.asks[0][1] = '0'; },
  ]) {
    const g = gate(), k = kraken(); change(g, k);
    const clients = createPublicClients({ clock: () => NOW, fetcher: async url => new Response(JSON.stringify(url.includes('gateio') ? g : k)) });
    const fx = await clients.loadFx(); assert.deepEqual(Object.keys(fx.rates), ['USDT']); assert.ok(fx.reasons.USDC); assert.ok(fx.reasons.USD);
  }
  const clients = createPublicClients({ clock: () => NOW, fetcher: async url => new Response(JSON.stringify(url.includes('gateio') ? gate() : { error: ['failed'], result: {} })) });
  const fx = await clients.loadFx(); assert.ok(fx.rates.USDC); assert.equal(fx.rates.USD, undefined);
});

test('parallel FX callers share one bounded refresh', async () => {
  let requests = 0;
  const clients = createPublicClients({ clock: () => NOW, fetcher: async url => { requests++; await Promise.resolve(); return new Response(JSON.stringify(url.includes('gateio') ? gate() : kraken())); } });
  const [a, b] = await Promise.all([clients.loadFx(), clients.loadFx()]); assert.strictEqual(a, b); assert.equal(requests, 2);
});

test('out-of-order source timestamps cannot replace a newer cached currency rate', async () => {
  let now = NOW, reverted = false;
  const clients = createPublicClients({ clock: () => now, fetcher: async url => {
    const g = gate(), k = kraken();
    if (reverted) { g.update -= 5000; g.bids[0][0] = '0.97'; k.result.USDTZUSD.asks[0][2] -= 5; k.result.USDTZUSD.asks[0][0] = '1.1'; }
    return new Response(JSON.stringify(url.includes('gateio') ? g : k));
  } });
  const first = await clients.loadFx(); now += 60_001; reverted = true;
  const second = await clients.loadFx();
  assert.deepEqual(second.rates.USDC, first.rates.USDC); assert.deepEqual(second.rates.USD, first.rates.USD);
  assert.match(second.reasons.USDC, /时间回退/); assert.match(second.reasons.USD, /时间回退/);
});
