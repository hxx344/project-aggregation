import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOkxOilQuote, parseBitgetOilQuote, createOilCexReader } from '../lib/oil-cex.ts';
import { calculateExchangeSpread } from '../lib/exchange-quotes.ts';

const NOW = Date.UTC(2026, 9, 1, 10), HOUR = 3_600_000;
const iso = value => new Date(value).toISOString();
const contracts = [['BZ', 104, -0.0002, 4], ['CL', 100, 0.0001, 1]];
function fixtures(exchange, now = NOW) {
  const okx = exchange === 'okx', wrap = (data, time = now) => ({ code: okx ? '0' : '00000', data, ...(okx ? {} : { requestTime: time }) });
  const instruments = wrap(contracts.map(([base], index) => okx
    ? { instId: `${base}-USDT-SWAP`, instType: 'SWAP', ctType: 'linear', state: 'live', settleCcy: 'USDT', ctValCcy: base, instFamily: `${base}-USDT`, uly: `${base}-USDT`, ruleType: 'normal', ctVal: index === 0 ? '0.01' : '0.1', baseCcy: '', quoteCcy: '' }
    : { symbol: `${base}USDT`, baseCoin: base, quoteCoin: 'USDT', symbolType: 'perpetual', symbolStatus: 'normal', supportMarginCoins: ['USDT'], fundInterval: '8', isRwa: 'YES' }));
  const prices = wrap(contracts.map(([base, price], index) => okx
    ? { instId: `${base}-USDT-SWAP`, instType: 'SWAP', markPx: String(price), ts: String(now - 2000 + index * 1000) }
    : { symbol: `${base}USDT`, markPrice: String(price), ts: String(now - 2000 + index * 1000), lastPr: '999', indexPrice: '888', fundingRate: '0.99' }));
  const funding = contracts.map(([base, , rate, hours], index) => wrap([okx
    ? { instId: `${base}-USDT-SWAP`, instType: 'SWAP', method: 'current_period', fundingRate: String(rate), fundingTime: String(now + hours * HOUR), nextFundingTime: String(now + 2 * hours * HOUR), ts: String(now - 8000 + index * 1000) }
    : { symbol: `${base}USDT`, fundingRate: String(rate), fundingRateInterval: String(hours), nextUpdate: String(now + hours * HOUR) }], now - 8000 + index * 1000));
  return { instruments, prices, funding };
}
function parse(exchange, fixture, now = NOW) {
  return (exchange === 'okx' ? parseOkxOilQuote : parseBitgetOilQuote)(fixture.instruments, fixture.prices, fixture.funding, now);
}
function assertPriceOnly(quote) {
  assert.equal(quote.left.price, 104);
  assert.equal(quote.right.price, 100);
  assert.equal(quote.fundingFetchedAt, null);
  assert.equal(quote.left.fundingRate, null);
  assert.equal(quote.right.fundingRate, null);
  assert.equal(calculateExchangeSpread(quote).shortAnnualized, null);
  assert.ok(quote.fundingError);
}

for (const exchange of ['okx', 'bitget']) {
  test(`${exchange}: mark prices, decimal funding, per-leg intervals and actual source times are preserved`, () => {
    const quote = parse(exchange, fixtures(exchange));
    assert.equal(quote.exchange, exchange);
    assert.equal(quote.monitorId, 'oil');
    assert.equal(quote.currency, 'USDT');
    assert.equal(quote.priceBasis, 'mark');
    assert.equal(quote.fundingPriceBasis, 'mark');
    assert.equal(quote.status, 'live');
    assert.equal(quote.left.price, 104);
    assert.equal(quote.right.price, 100);
    assert.equal(quote.left.fundingPrice, 104);
    assert.equal(quote.left.fundingRate, -0.0002);
    assert.equal(quote.right.fundingRate, 0.0001);
    assert.equal(quote.left.fundingIntervalHours, 4);
    assert.equal(quote.right.fundingIntervalHours, 1);
    assert.equal(quote.left.nextFundingAt, iso(NOW + 4 * HOUR));
    assert.equal(quote.right.nextFundingAt, iso(NOW + HOUR));
    assert.equal(quote.fetchedAt, iso(NOW - 2000));
    assert.equal(quote.fundingFetchedAt, iso(NOW - 8000));
    const result = calculateExchangeSpread(quote);
    assert.equal(result.spread, 4);
    assert.ok(Math.abs(result.shortAnnualized - ((104 * -0.0002 / 4 - 100 * 0.0001) / 204 * 8760)) < 1e-12);
  });

  test(`${exchange}: genuine zero is valid; missing or invalid funding never becomes zero`, () => {
    const fixture = fixtures(exchange);
    fixture.funding.forEach(response => { response.data[0].fundingRate = '0'; });
    assert.equal(calculateExchangeSpread(parse(exchange, fixture)).shortAnnualized, 0);
    for (const value of [null, undefined, '', ' ', false, 'NaN', 'Infinity', '1.01']) {
      const broken = fixtures(exchange); broken.funding[0].data[0].fundingRate = value;
      assertPriceOnly(parse(exchange, broken));
    }
    for (const value of [null, [], {}, { code: 'failed', data: [] }]) {
      const broken = fixtures(exchange); broken.funding = value;
      assertPriceOnly(parse(exchange, broken));
    }
  });

  test(`${exchange}: incomplete settlement metadata or funding identity preserves prices only`, () => {
    const intervalField = exchange === 'okx' ? 'nextFundingTime' : 'fundingRateInterval';
    const nextField = exchange === 'okx' ? 'fundingTime' : 'nextUpdate';
    const symbolField = exchange === 'okx' ? 'instId' : 'symbol';
    for (const [field, value] of [[intervalField, ''], [nextField, ''], [nextField, NOW - 61_000], [nextField, NOW + 26 * HOUR], [symbolField, 'WRONG']]) {
      const broken = fixtures(exchange); broken.funding[0].data[0][field] = value;
      assertPriceOnly(parse(exchange, broken));
    }
    for (const hours of [0, 0.5, 25]) {
      const broken = fixtures(exchange);
      broken.funding[0].data[0][intervalField] = exchange === 'okx' ? String(Number(broken.funding[0].data[0].fundingTime) + hours * HOUR) : String(hours);
      assertPriceOnly(parse(exchange, broken));
    }
    const duplicate = fixtures(exchange); duplicate.funding.push(duplicate.funding[0]);
    assertPriceOnly(parse(exchange, duplicate));
    const missingLeg = fixtures(exchange); missingLeg.funding.pop();
    assertPriceOnly(parse(exchange, missingLeg));
  });

  test(`${exchange}: stale, future or absent funding sources cannot be relabeled fresh`, () => {
    for (const time of [NOW - 121_000, NOW + 61_000, '', null, 1790850]) {
      const broken = fixtures(exchange);
      if (exchange === 'okx') broken.funding[0].data[0].ts = time;
      else broken.funding[0].requestTime = time;
      assertPriceOnly(parse(exchange, broken));
    }
  });

  test(`${exchange}: independently refreshed funding snapshots remain usable within their own validity windows`, () => {
    const fixture = fixtures(exchange);
    const times = [NOW - 61_000, NOW - 1000];
    fixture.funding.forEach((response, index) => {
      if (exchange === 'okx') response.data[0].ts = String(times[index]);
      else response.requestTime = times[index];
    });
    const quote = parse(exchange, fixture);
    assert.equal(quote.left.fundingRate, -0.0002);
    assert.equal(quote.right.fundingRate, 0.0001);
    assert.equal(quote.fundingFetchedAt, iso(NOW - 61_000));
    assert.notEqual(calculateExchangeSpread(quote).shortAnnualized, null);
  });

  test(`${exchange}: contract identity, perpetual status, USDT settlement and uniqueness are mandatory`, () => {
    const changes = exchange === 'okx'
      ? [['instType', 'FUTURES'], ['ctType', 'inverse'], ['state', 'suspend'], ['settleCcy', 'USD'], ['ctValCcy', 'BTC'], ['instFamily', 'BTC-USDT'], ['uly', 'BZ-USD'], ['ruleType', 'pre_market']]
      : [['symbolType', 'delivery'], ['symbolStatus', 'suspend'], ['baseCoin', 'BTC'], ['quoteCoin', 'USDC'], ['supportMarginCoins', ['BTC']], ['supportMarginCoins', []]];
    for (const [field, value] of changes) {
      const broken = fixtures(exchange); broken.instruments.data[0][field] = value;
      assert.throws(() => parse(exchange, broken), /contract/);
    }
    for (const field of [changes[0][0], changes[1][0]]) {
      const broken = fixtures(exchange); delete broken.instruments.data[0][field];
      assert.throws(() => parse(exchange, broken));
    }
    for (const part of ['instruments', 'prices']) {
      const duplicate = fixtures(exchange); duplicate[part].data.push(duplicate[part].data[0]);
      assert.throws(() => parse(exchange, duplicate), /duplicate/);
      const missing = fixtures(exchange); missing[part].data.pop();
      assert.throws(() => parse(exchange, missing), /Missing/);
      const failed = fixtures(exchange); failed[part].code = 'failed';
      assert.throws(() => parse(exchange, failed), /response/);
    }
  });

  test(`${exchange}: stale, future, unsynchronized and invalid price sources are rejected`, () => {
    for (const time of [NOW - 121_000, NOW + 61_000, NOW - 16_001, '', null, 1790850]) {
      const broken = fixtures(exchange); broken.prices.data[0].ts = time;
      assert.throws(() => parse(exchange, broken));
    }
    for (const price of ['', null, false, '0', '-1', 'NaN', 'Infinity']) {
      const broken = fixtures(exchange); broken.prices.data[0][exchange === 'okx' ? 'markPx' : 'markPrice'] = price;
      assert.throws(() => parse(exchange, broken));
    }
  });

  test(`${exchange}: public reader isolates funding failures and requests the correct linear markets`, async () => {
    let failFunding = true;
    const calls = [], keys = [];
    const reader = createOilCexReader({
      clock: () => NOW,
      shared: async (key, ttl, load) => { keys.push([key, ttl]); return load(); },
      request: async input => {
        const url = new URL(input), fixture = fixtures(exchange); calls.push(url);
        if (url.pathname.endsWith('/instruments') || url.pathname.endsWith('/contracts')) return fixture.instruments;
        if (url.pathname.endsWith('/mark-price') || url.pathname.endsWith('/tickers')) return fixture.prices;
        if (failFunding) throw new Error('offline');
        const symbol = url.searchParams.get(exchange === 'okx' ? 'instId' : 'symbol');
        return fixture.funding[symbol.startsWith('BZ') ? 0 : 1];
      },
    });
    assertPriceOnly(await reader(exchange));
    assert.equal(calls.length, 4);
    assert.ok(calls.every(url => url.protocol === 'https:' && (exchange === 'okx' ? url.hostname === 'www.okx.com' : url.hostname === 'api.bitget.com')));
    assert.ok(calls.filter(url => !url.pathname.endsWith('/funding-rate')).every(url => url.searchParams.get(exchange === 'okx' ? 'instType' : 'productType') === (exchange === 'okx' ? 'SWAP' : 'USDT-FUTURES')));
    assert.deepEqual(keys.map(([, ttl]) => ttl), [60_000, 1000, 15_000, 15_000]);
    failFunding = false;
    assert.equal((await reader(exchange)).left.fundingRate, -0.0002);
  });
}

test('OKX rejects mismatched mark and funding market types and the obsolete next-period mechanism', () => {
  const fixture = fixtures('okx'); fixture.prices.data[0].instType = 'FUTURES';
  assert.throws(() => parse('okx', fixture), /contract/);
  for (const [field, value] of [['instType', 'FUTURES'], ['method', 'next_period']]) {
    const broken = fixtures('okx'); broken.funding[0].data[0][field] = value;
    assertPriceOnly(parse('okx', broken));
  }
});

test('Bitget never substitutes ticker funding or static instrument interval for missing current metadata', () => {
  const fixture = fixtures('bitget');
  delete fixture.funding[0].data[0].fundingRateInterval;
  assertPriceOnly(parse('bitget', fixture));
});

test('reader rejects failed envelopes before caching, and unknown exchanges before any request', async () => {
  let requests = 0, cached = 0;
  const reader = createOilCexReader({ clock: () => NOW, request: async () => { requests++; return { code: 'failed', data: [] }; }, shared: async (_key, _ttl, load) => { const result = await load(); cached++; return result; } });
  await assert.rejects(reader('okx'), /response/);
  assert.equal(cached, 0);
  const previous = requests;
  await assert.rejects(reader('binance'), /Unsupported/);
  assert.equal(requests, previous);
});
