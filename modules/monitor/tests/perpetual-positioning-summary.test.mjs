import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPositioningConstituents, summarizePositioning } from '../server/perpetual-positioning-summary.mjs';

const NOW = 1_790_000_100_000;
const exchanges = ['binance', 'bybit', 'okx', 'bitget', 'gate'];
const quote = (exchange, patch = {}) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, ...patch });
const constituents = selectPositioningConstituents('BTC', exchanges.map(exchange => quote(exchange)));
const data = (exchange, longRatio, patch = {}) => ({ exchange, symbol: 'BTCUSDT', kind: 'accounts', scope: '合约全体持仓账户（5 分钟）',
  longRatio, shortRatio: 1 - longRatio, observedAt: NOW, ...patch });
const ratios = (...rows) => new Map(rows.map(row => [`${row.exchange}:${row.symbol}`, row]));
const summarize = (values, attempts = new Map(), selected = constituents, now = NOW) => summarizePositioning(selected, values, attempts, now);

test('selection returns exactly five venues in fixed order and marks absent USDT contracts', () => {
  const selected = selectPositioningConstituents('BTC', [quote('gate', { symbol: 'BTC_USDT' }), quote('binance'), quote('aster'), quote('bybit', { quoteCurrency: 'USDC' })]);
  assert.deepEqual(selected.map(row => row.exchange), exchanges);
  assert.deepEqual(selected[0], { exchange: 'binance', key: 'binance:BTCUSDT', symbol: 'BTCUSDT' });
  assert.deepEqual(selected[1], { exchange: 'bybit', key: null, symbol: null });
  assert.deepEqual(selected[4], { exchange: 'gate', key: 'gate:BTC_USDT', symbol: 'BTC_USDT' });
});

test('selection excludes different identities, incomparable contracts and known non-USDT collateral', () => {
  const values = [quote('binance', { base: 'OTHER:BTC' }), quote('bybit', { comparable: false }),
    quote('okx', { collateralCurrency: 'USDC' }), quote('bitget', { quoteCurrency: 'USD' }), quote('gate', { symbol: '' })];
  assert.ok(selectPositioningConstituents('BTC', values).every(row => row.key === null));
  assert.equal(selectPositioningConstituents('BTC', [quote('okx', { collateralCurrency: 'USDT' })])[2].key, 'okx:BTCUSDT');
});

test('standard multiplier wins, then stable symbol ordering, without depending on input or best prices', () => {
  const values = [quote('binance', { symbol: '000BTCUSDT', multiplier: 1_000, ask: 1 }),
    quote('binance', { symbol: 'ZBTCUSDT', ask: 50 }), quote('binance', { symbol: 'BTCUSDT', ask: 200 }),
    quote('bybit', { symbol: '1000BTCUSDT', multiplier: 1_000 }), quote('bybit', { symbol: '100BTCUSDT', multiplier: 100 })];
  const original = structuredClone(values);
  const first = selectPositioningConstituents('BTC', values);
  assert.equal(first[0].symbol, 'BTCUSDT');
  assert.equal(first[1].symbol, '1000BTCUSDT');
  assert.deepEqual(selectPositioningConstituents('BTC', [...values].reverse()), first);
  assert.deepEqual(values, original);
});

test('equal exchange aggregation averages account shares and does not average L/S quotients', () => {
  const result = summarize(ratios(data('binance', 0.8), data('bybit', 0.2), data('gate', 0.5)));
  assert.equal(result.kind, 'accounts'); assert.equal(result.method, 'equal-exchange');
  assert.equal(result.periodMs, 300_000);
  assert.equal(result.longRatio, 0.5); assert.equal(result.shortRatio, 0.5);
  assert.equal(result.availableExchanges, 3); assert.equal(result.eligibleExchanges, 5); assert.equal(result.totalExchanges, 5);
  assert.equal(result.observedAt, NOW);
  assert.equal(result.constituents[2].status, 'pending');
});

test('one or zero valid exchanges leave the aggregate unknown and never fill missing votes with 50%', () => {
  for (const values of [new Map(), ratios(data('binance', 0.9))]) {
    const result = summarize(values);
    assert.equal(result.longRatio, null); assert.equal(result.shortRatio, null); assert.equal(result.observedAt, null);
    assert.equal(result.availableExchanges, values.size);
  }
  const result = summarize(ratios(data('binance', 0.8), data('bybit', 0.6)));
  assert.equal(result.longRatio, 0.7); assert.ok(Math.abs(result.shortRatio - 0.3) < 1e-15);
});

test('coverage distinguishes absent markets from not-yet-collected eligible contracts', () => {
  const selected = selectPositioningConstituents('BTC', [quote('binance'), quote('gate')]);
  const result = summarize(ratios(data('binance', 0.6), data('gate', 0.4)), new Map(), selected);
  assert.equal(result.availableExchanges, 2); assert.equal(result.eligibleExchanges, 2); assert.equal(result.totalExchanges, 5);
  assert.equal(result.constituents[1].status, 'unsupported');
  assert.equal(result.constituents[1].reason, '未发现该平台同币种USDT合约');
});

test('top-trader, position-size, unknown scopes and different contracts are not mixed with all accounts', () => {
  for (const patch of [{ kind: 'positions' }, { scope: 'Top trader accounts' }, { scope: 'all' }, { scope: undefined }, { symbol: 'ETHUSDT' }, { exchange: 'other' }]) {
    const values = ratios(data('binance', 0.6), data('bybit', 0.4));
    values.set('bybit:BTCUSDT', data('bybit', 0.4, patch));
    const result = summarize(values);
    assert.equal(result.availableExchanges, 1);
    assert.equal(result.longRatio, null);
    assert.equal(result.constituents[1].status, 'unavailable');
  }
});

test('finite fractions and near-one totals are required, while actual zero sides are valid', () => {
  for (const patch of [{ longRatio: '0.6' }, { longRatio: NaN }, { shortRatio: Infinity }, { longRatio: null },
    { longRatio: -0.1, shortRatio: 1.1 }, { longRatio: 60, shortRatio: 40 }, { longRatio: 0, shortRatio: 0 }, { longRatio: 0.1, shortRatio: 0.8 }]) {
    assert.equal(summarize(ratios(data('binance', 0.6), data('bybit', 0.4, patch))).availableExchanges, 1);
  }
  const zero = summarize(ratios(data('binance', 0), data('bybit', 1)));
  assert.equal(zero.longRatio, 0.5); assert.equal(zero.shortRatio, 0.5);
  const rounded = summarize(ratios(data('binance', 0.6, { shortRatio: 0.4001 }), data('bybit', 0.4)));
  assert.equal(rounded.availableExchanges, 2); assert.equal(rounded.longRatio + rounded.shortRatio, 1);
});

test('source timestamps must be positive and at most five seconds in the future', () => {
  for (const observedAt of [null, undefined, 0, -1, NaN, Infinity, String(NOW), NOW + 5_001]) {
    const result = summarize(ratios(data('binance', 0.6), data('bybit', 0.4, { observedAt })));
    assert.equal(result.availableExchanges, 1); assert.equal(result.constituents[1].status, 'unavailable');
  }
  assert.equal(summarize(ratios(data('binance', 0.6), data('bybit', 0.4, { observedAt: NOW + 5_000 }))).availableExchanges, 2);
});

test('fifteen-minute expiry is inclusive and invalidates old cache without changing or deleting it', () => {
  const values = ratios(data('binance', 0.6, { observedAt: NOW - 900_000 }), data('bybit', 0.4, { observedAt: NOW - 900_000 }));
  const original = structuredClone(values);
  assert.equal(summarize(values).availableExchanges, 2);
  const expired = summarize(values, new Map(), constituents, NOW + 1);
  assert.equal(expired.availableExchanges, 0); assert.equal(expired.longRatio, null);
  assert.equal(expired.constituents[0].status, 'stale');
  assert.match(expired.constituents[0].reason, /已过期/);
  assert.deepEqual(values, original);
});

test('statistics align within one five-minute period and retain the earliest included source time', () => {
  const values = ratios(data('binance', 0.8), data('bybit', 0.2, { observedAt: NOW - 300_000 }), data('gate', 0.9, { observedAt: NOW - 300_001 }));
  const result = summarize(values);
  assert.equal(result.availableExchanges, 2); assert.equal(result.longRatio, 0.5);
  assert.equal(result.observedAt, NOW - 300_000);
  assert.equal(result.constituents[4].status, 'stale'); assert.match(result.constituents[4].reason, /统计时点不同/);
  const sameBucket = NOW - NOW % 300_000;
  assert.equal(summarize(ratios(data('binance', 0.6, { observedAt: sameBucket }), data('bybit', 0.4, { observedAt: sameBucket + 1000 }))).availableExchanges, 2);
});

test('each failed state remains distinguishable when no cached series exists', () => {
  const attempts = new Map([
    ['binance:BTCUSDT', { status: 'rate-limited', error: '多空接口限流，等待重试' }],
    ['bybit:BTCUSDT', { status: 'unavailable', error: '该合约暂无公开多空数据' }],
    ['okx:BTCUSDT', { status: 'error', error: '多空接口暂不可用' }],
    ['bitget:BTCUSDT', { error: 'legacy error' }],
  ]);
  const result = summarize(new Map(), attempts);
  assert.deepEqual(result.constituents.map(row => row.status), ['rate-limited', 'unavailable', 'error', 'error', 'pending']);
  assert.equal(result.constituents[0].reason, '多空接口限流，等待重试');
});

test('a failed refresh may retain still-fresh evidence and its error hint without freshening it', () => {
  const values = ratios(data('binance', 0.8, { observedAt: NOW - 60_000 }), data('bybit', 0.4));
  const attempts = new Map([['binance:BTCUSDT', { status: 'rate-limited', error: '多空接口限流，等待重试', at: NOW, retryAt: NOW + 600_000 }]]);
  const originalValues = structuredClone(values), originalAttempts = structuredClone(attempts), originalConstituents = structuredClone(constituents);
  const result = summarize(values, attempts);
  assert.equal(result.availableExchanges, 2); assert.equal(result.constituents[0].status, 'fresh');
  assert.equal(result.constituents[0].reason, '多空接口限流，等待重试');
  assert.equal(result.observedAt, NOW - 60_000);
  assert.deepEqual(values, originalValues); assert.deepEqual(attempts, originalAttempts); assert.deepEqual(constituents, originalConstituents);
});

test('a route-level unsupported reason takes precedence even if an old cached series exists', () => {
  const values = ratios(data('binance', 0.8), data('bybit', 0.4));
  const attempts = new Map([['binance:BTCUSDT', { status: 'unsupported', error: '该合约格式不受官方接口支持' }]]);
  const result = summarize(values, attempts);
  assert.equal(result.availableExchanges, 1);
  assert.equal(result.eligibleExchanges, 5);
  assert.equal(result.constituents[0].status, 'unsupported');
  assert.equal(result.constituents[0].reason, '该合约格式不受官方接口支持');
  assert.equal(values.size, 2);
});
