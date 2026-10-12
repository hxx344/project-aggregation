import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, quote, epoch } from './fixtures.mjs';

const iso = at => new Date(at).toISOString();
const metric = (snapshot, key) => snapshot.metrics.find(item => item.key === key).value;

// Model the hub's freshness decision using only the exported summary contract.
function hubState(snapshot, now) {
  if (['offline', 'stale'].includes(snapshot.health.state)) return snapshot.health.state;
  const at = Date.parse(snapshot.updatedAt);
  return !Number.isFinite(at) || now - at > snapshot.health.staleAfterSeconds * 1000 ? 'stale' : snapshot.health.state;
}

test('mixed quotes keep the hub partial using the latest usable quote time', async t => {
  const f = fixture(t), current = feed(epoch - 500);
  current.signals = [];
  current.quotes = [
    quote('binance', epoch - 20000),
    quote('bybit', epoch - 2000),
    quote('binance', epoch - 1000, { base: 'ETH', symbol: 'ETHUSDT', receivedAt: epoch - 250 }),
  ];
  f.setFeed(current); await f.engine.tick();
  const snapshot = f.engine.summary();
  assert.equal(snapshot.health.state, 'partial');
  assert.match(snapshot.health.message, /1 条盘口过期/);
  assert.equal(snapshot.updatedAt, iso(epoch - 1000));
  assert.equal(hubState(snapshot, f.now()), 'partial');
  f.advance(2000);
  await f.engine.tick();
  assert.equal(f.engine.summary().updatedAt, snapshot.updatedAt);
  assert.equal(hubState(snapshot, epoch + 9001), 'stale');
});

test('a quote near expiry does not shorten unrelated live market data without positions', async t => {
  const f = fixture(t), current = feed();
  current.signals = [];
  current.quotes = [quote('binance', epoch - 9999), quote('bybit', epoch)];
  f.setFeed(current); await f.engine.tick();
  const snapshot = f.engine.summary();
  assert.equal(snapshot.health.state, 'online');
  assert.equal(metric(snapshot, 'positions'), 0);
  assert.equal(snapshot.updatedAt, iso(epoch));
  assert.equal(hubState(snapshot, epoch + 2), 'online');
  f.advance(2);
  const next = f.engine.summary();
  assert.equal(next.health.state, 'partial');
  assert.equal(next.updatedAt, iso(epoch));
  assert.equal(hubState(next, f.now()), 'partial');
});

test('a current feed heartbeat cannot freshen an entirely expired quote set', async t => {
  const f = fixture(t), current = feed();
  current.signals = [];
  current.quotes = [quote('binance', epoch - 20000), quote('bybit', epoch - 12000)];
  f.setFeed(current); await f.engine.tick();
  const snapshot = f.engine.summary();
  assert.equal(snapshot.health.state, 'stale');
  assert.match(snapshot.health.message, /2 条盘口过期/);
  assert.equal(hubState(snapshot, f.now()), 'stale');
  assert.ok(Date.parse(snapshot.updatedAt) <= epoch - 12000);
});

const invalidQuotes = [
  ['future timestamp', () => quote('bybit', epoch + 1001)],
  ['missing timestamp', () => quote('bybit', epoch, { bidAskAt: null })],
  ['unverified identity', () => quote('bybit', epoch, { identityVerified: false })],
  ['invalid bid', () => quote('bybit', epoch, { bid: 0 })],
  ['crossed bid and ask', () => quote('bybit', epoch, { bid: 104, ask: 103 })],
];
for (const [label, invalid] of invalidQuotes) {
  test(`a recent quote with ${label} cannot renew the summary`, async t => {
    const f = fixture(t), current = feed();
    current.signals = [];
    current.quotes = [quote('binance', epoch - 9000), invalid()];
    f.setFeed(current); await f.engine.tick();
    const snapshot = f.engine.summary();
    assert.equal(snapshot.health.state, 'partial');
    assert.match(snapshot.health.message, /1 条盘口过期/);
    assert.equal(snapshot.updatedAt, iso(epoch - 9000));
    assert.equal(hubState(snapshot, epoch + 1001), 'stale');
    current.quotes = [invalid()];
    f.setFeed({ ...current }); await f.engine.tick();
    assert.equal(f.engine.summary().health.state, 'stale');
  });
}

test('quotes from an offline venue cannot renew live market data or supply its only fresh quote', async t => {
  const f = fixture(t), current = feed();
  current.signals = [];
  current.exchanges[1].status = 'offline';
  current.quotes = [quote('binance', epoch - 9000), quote('bybit', epoch)];
  f.setFeed(current); await f.engine.tick();
  const snapshot = f.engine.summary();
  assert.equal(snapshot.health.state, 'partial');
  assert.match(snapshot.health.message, /行情异常：bybit/);
  assert.equal(snapshot.updatedAt, iso(epoch - 9000));
  assert.equal(hubState(snapshot, epoch + 1001), 'stale');
  f.setFeed({ ...current, quotes: [quote('bybit', epoch)] }); await f.engine.tick();
  assert.equal(f.engine.summary().health.state, 'stale');
});

test('a frozen feed generation time caps even newer quote timestamps and cached hub expiry', async t => {
  const f = fixture(t), current = feed(epoch - 9000);
  current.signals = [];
  current.quotes = [quote('binance', epoch), quote('bybit', epoch)];
  f.setFeed(current); await f.engine.tick();
  const snapshot = f.engine.summary();
  assert.equal(snapshot.health.state, 'online');
  assert.equal(snapshot.updatedAt, iso(epoch - 9000));
  assert.equal(hubState(snapshot, f.now()), 'online');
  f.advance(1001);
  assert.equal(hubState(snapshot, f.now()), 'stale');
  assert.equal(f.engine.summary().health.state, 'stale');
});

test('a failed source read remains offline and never stamps the response with request time', async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.advance(1500); f.offline(true); await f.engine.tick();
  const snapshot = f.engine.summary();
  assert.equal(snapshot.health.state, 'offline');
  assert.equal(snapshot.updatedAt, iso(epoch));
  assert.equal(hubState(snapshot, f.now()), 'offline');
  assert.notEqual(snapshot.updatedAt, iso(f.now()));
});

test('published position PnL expires with its oldest valuation but stale PnL does not expire active quotes', async t => {
  const f = fixture(t);
  await f.engine.tick();
  await f.engine.open(`signal-${epoch}`, 'summary-valuation-boundary');
  f.advance(9000);
  const current = feed(f.now());
  current.signals = [];
  current.quotes = [
    quote('binance', epoch + 1000),
    quote('bybit', epoch + 2000),
    quote('binance', f.now(), { base: 'ETH', symbol: 'ETHUSDT' }),
  ];
  f.setFeed(current); await f.engine.tick();
  const valued = f.engine.summary();
  assert.equal(valued.health.state, 'online');
  assert.equal(metric(valued, 'positions'), 1);
  assert.equal(typeof metric(valued, 'unrealized'), 'number');
  assert.equal(valued.updatedAt, iso(epoch + 1000));
  assert.equal(hubState(valued, f.now()), 'online');
  f.advance(2000);
  assert.equal(hubState(valued, f.now()), 'online');
  assert.equal(typeof metric(f.engine.summary(), 'unrealized'), 'number');
  f.advance(1);
  assert.equal(hubState(valued, f.now()), 'stale');
  const staleValuation = f.engine.summary();
  assert.equal(staleValuation.health.state, 'partial');
  assert.match(staleValuation.health.message, /1 组持仓估值过期/);
  assert.equal(metric(staleValuation, 'unrealized'), null);
  assert.equal(staleValuation.updatedAt, iso(epoch + 9000));
  assert.equal(hubState(staleValuation, f.now()), 'partial');
  const position = f.engine.view({ includeHistory: false }).positions[0];
  assert.equal(position.valuation.stale, true);
  assert.equal(position.valuation.at, epoch + 1000);
});

test('an unavailable directory remains partial while usable market data keeps its own timestamp', async t => {
  const f = fixture(t);
  f.setCatalog([]); await f.engine.tick();
  const snapshot = f.engine.summary();
  assert.equal(snapshot.health.state, 'partial');
  assert.match(snapshot.health.message, /目录/);
  assert.equal(snapshot.updatedAt, iso(epoch));
  assert.equal(metric(snapshot, 'catalog'), 'unavailable');
  assert.equal(hubState(snapshot, f.now()), 'partial');
});
