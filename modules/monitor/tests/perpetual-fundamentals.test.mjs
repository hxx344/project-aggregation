import test from 'node:test';
import assert from 'node:assert/strict';
import { createFundamentalsClient } from '../server/perpetual-fundamentals.mjs';

const NOW = 1_789_930_000_000;
const HALF_HOUR = 30 * 60_000;
const DAY = 24 * 60 * 60_000;
const coins = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
  { id: 'bitcoin-copy', symbol: 'btc', name: 'Another BTC' },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
  { id: 'solana', symbol: 'sol', name: 'Solana' },
  { id: 'meme-one', symbol: 'meme', name: 'Meme One' },
  { id: 'meme-two', symbol: 'meme', name: 'Meme Two' },
  { id: 'unique-token', symbol: 'uniq', name: 'Unique Token' },
];
const market = (id, patch = {}) => ({ id, name: id, market_cap: 100, fully_diluted_valuation: 200, circulating_supply: 50, total_supply: 100, max_supply: 150, last_updated: new Date(NOW - 60_000).toISOString(), ...patch });
function setup(options = {}) {
  let now = NOW;
  const calls = [];
  const client = createFundamentalsClient({ clock: () => now, ...options,
    fetchImpl: async (url, request) => {
      calls.push({ url: new URL(url), request });
      if (options.fetchImpl) return options.fetchImpl(url, request);
      const ids = new URL(url).searchParams.get('ids');
      return { ok: true, status: 200, json: async () => ids ? ids.split(',').map(id => market(id)) : coins };
    },
  });
  return { client, calls, setTime: value => { now = value; } };
}

test('fundamentals use confirmed IDs before unique symbols and leave ambiguous or namespaced assets unresolved', async () => {
  const { client, calls } = setup();
  const values = await client.refresh(['BTC', 'UNIQ', 'MEME', 'NOPE', 'EQUITY:BTC', 'ENTROPY:OAI:MARKETCAP', 'BTC']);
  assert.deepEqual(Object.keys(values), ['BTC', 'UNIQ']);
  assert.equal(values.BTC.coinId, 'bitcoin');
  assert.equal(values.UNIQ.coinId, 'unique-token');
  assert.equal(client.describe('MEME').status, 'ambiguous');
  assert.deepEqual(client.describe('MEME').candidates, ['meme-one', 'meme-two']);
  assert.equal(client.describe('NOPE').status, 'unmapped');
  assert.equal(client.describe('EQUITY:BTC').status, 'unsupported');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.search, '', 'Directory avoids unused platform-address payloads');
  assert.equal(calls[1].url.searchParams.get('ids'), 'bitcoin,unique-token');
  assert.equal(calls[1].url.searchParams.get('vs_currency'), 'usd');
  assert.equal(calls[1].request.headers['x-cg-demo-api-key'], undefined);
});

test('fundamentals allow explicit ambiguity resolution and optional header-only demo keys', async () => {
  const { client, calls } = setup({ coinIds: { MEME: 'meme-two', BAD: 'not-listed' }, apiKey: 'test-demo-key' });
  const values = await client.refresh(['MEME', 'BAD']);
  assert.equal(values.MEME.coinId, 'meme-two');
  assert.equal(values.BAD, undefined);
  assert.equal(client.describe('BAD').status, 'unmapped');
  assert.ok(calls.every(call => call.request.headers['x-cg-demo-api-key'] === 'test-demo-key'));
  assert.ok(calls.every(call => !call.url.href.includes('test-demo-key')));
});

test('fundamentals preserve zero, null and source time without deriving FDV from maximum supply', async () => {
  const { client } = setup({ fetchImpl: async url => ({ ok: true, status: 200, json: async () => new URL(url).pathname.endsWith('/list') ? coins : [
    market('bitcoin', { market_cap: 0, fully_diluted_valuation: null, circulating_supply: '0', total_supply: '', max_supply: 21_000_000 }),
    market('ethereum', { market_cap: -10, fully_diluted_valuation: NaN, circulating_supply: false, total_supply: Infinity, max_supply: undefined, last_updated: 'invalid' }),
  ] }) });
  const values = await client.refresh(['BTC', 'ETH']);
  assert.equal(values.BTC.marketCapUsd, 0);
  assert.equal(values.BTC.fdvUsd, null);
  assert.equal(values.BTC.circulatingSupply, 0);
  assert.equal(values.BTC.totalSupply, null);
  assert.equal(values.BTC.maxSupply, 21_000_000);
  assert.equal(values.BTC.updatedAt, NOW - 60_000);
  assert.equal(values.BTC.source, 'coingecko');
  for (const key of ['marketCapUsd', 'fdvUsd', 'circulatingSupply', 'totalSupply', 'maxSupply', 'updatedAt']) assert.equal(values.ETH[key], null, key);
});

test('fundamentals cache markets for thirty minutes and the directory for one day', async () => {
  const { client, calls, setTime } = setup();
  await client.refresh(['BTC']);
  setTime(NOW + HALF_HOUR - 1);
  await client.refresh(['BTC']);
  assert.equal(calls.length, 2);
  setTime(NOW + HALF_HOUR);
  assert.equal(client.get('BTC'), null);
  assert.equal(client.describe('BTC').status, 'stale');
  await client.refresh(['BTC']);
  assert.equal(calls.length, 3);
  assert.equal(client.get('BTC').updatedAt, NOW - 60_000, 'Receiving cached provider data never invents a new source timestamp');
  setTime(NOW + DAY);
  await client.refresh(['BTC']);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/list')).length, 2);
});

test('fundamentals request only expired IDs and bound each refresh to four sequential batches', async () => {
  const directory = Array.from({ length: 1001 }, (_, index) => ({ id: `coin-${index}`, symbol: `c${index}`, name: `Coin ${index}` }));
  let active = 0, maximumActive = 0;
  const { client, calls } = setup({ fetchImpl: async url => {
    active++; maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active--;
    const ids = new URL(url).searchParams.get('ids');
    return { ok: true, status: 200, json: async () => ids ? ids.split(',').map(id => market(id)) : directory };
  } });
  const bases = directory.map(coin => coin.symbol.toUpperCase());
  const first = await client.refresh(bases);
  assert.equal(Object.keys(first).length, 1000);
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(1).every(call => call.url.searchParams.get('ids').split(',').length === 250));
  assert.equal(maximumActive, 1);
  assert.equal(client.describe('C1000').status, 'pending');
  const second = await client.refresh(bases);
  assert.equal(Object.keys(second).length, 1001);
  assert.equal(calls.length, 6);
  assert.equal(calls.at(-1).url.searchParams.get('ids'), 'coin-1000');
});

test('fundamentals cache missing rows and never accept unrequested market identities', async () => {
  const { client, calls } = setup({ fetchImpl: async url => ({ ok: true, status: 200, json: async () => new URL(url).pathname.endsWith('/list') ? coins : [market('unrequested')] }) });
  assert.deepEqual(await client.refresh(['BTC']), {});
  assert.equal(client.describe('BTC').status, 'missing');
  assert.deepEqual(await client.refresh(['BTC']), {});
  assert.equal(calls.length, 2);
});

test('fundamentals prioritize never-loaded assets when earlier batches expire before the next refresh', async () => {
  const directory = Array.from({ length: 1001 }, (_, index) => ({ id: `coin-${index}`, symbol: `c${index}`, name: `Coin ${index}` }));
  const { client, calls, setTime } = setup({ fetchImpl: async url => {
    const ids = new URL(url).searchParams.get('ids');
    return { ok: true, status: 200, json: async () => ids ? ids.split(',').map(id => market(id)) : directory };
  } });
  const bases = directory.map(coin => coin.symbol.toUpperCase());
  await client.refresh(bases);
  setTime(NOW + HALF_HOUR);
  const values = await client.refresh(bases);
  assert.equal(values.C1000.coinId, 'coin-1000', 'The same first 1,000 assets must not starve later ones');
  assert.equal(calls.length, 9);
  assert.equal(calls[5].url.searchParams.get('ids').split(',')[0], 'coin-1000');
});

test('fundamentals failures retain original source time and expired data is not returned as fresh', async () => {
  let fail = false;
  const { client, setTime } = setup({ fetchImpl: async url => {
    if (fail) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '60' }) };
    return { ok: true, status: 200, json: async () => new URL(url).pathname.endsWith('/list') ? coins : [market('bitcoin')] };
  } });
  await client.refresh(['BTC']);
  setTime(NOW + HALF_HOUR);
  fail = true;
  await assert.rejects(client.refresh(['BTC']), error => error.status === 429 && error.retryAfter === '60');
  assert.equal(client.get('BTC'), null);
  assert.equal(client.describe('BTC').status, 'stale');
  assert.equal(client.describe('BTC').updatedAt, NOW - 60_000);
  fail = false;
  assert.equal((await client.refresh(['BTC'])).BTC.updatedAt, NOW - 60_000);
});

test('fundamentals normalize timeout and network failures without exposing secrets', async () => {
  const timeout = setup({ fetchImpl: async () => { throw new DOMException('private detail', 'TimeoutError'); } });
  await assert.rejects(timeout.client.refresh(['BTC']), error => error.status === 408 && error.name === 'TimeoutError' && !error.message.includes('private'));
  const network = setup({ apiKey: 'private-key', fetchImpl: async () => { throw new Error('proxy credentials private-key'); } });
  await assert.rejects(network.client.refresh(['BTC']), error => error.status === 502 && !error.message.includes('private-key'));
});

test('fundamentals serialize concurrent refreshes and reuse successful cached requests', async () => {
  const { client, calls } = setup();
  const [first, second] = await Promise.all([client.refresh(['BTC']), client.refresh(['BTC', 'ETH'])]);
  assert.equal(first.BTC.coinId, 'bitcoin');
  assert.equal(second.ETH.coinId, 'ethereum');
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).url.searchParams.get('ids'), 'ethereum');
});
