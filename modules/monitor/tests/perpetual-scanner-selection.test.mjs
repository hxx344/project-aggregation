import test from 'node:test';
import assert from 'node:assert/strict';
import { createScannerDataPairSelector, scannerDataSelectionKey } from '../lib/perpetual-scanner-data.ts';

const NOW = 1800000000000;
const quote = (exchange, base = 'BTC', extra = {}) => ({ exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT',
  bid: 100, ask: 101, mark: 100.5, last: 100, fundingRate: .0001, fundingIntervalHours: 8,
  nextFundingAt: NOW + 3600000, receivedAt: NOW, sourceTime: NOW, bidAskAt: NOW, fundingAt: NOW, transport: 'ws', ...extra });
const row = (long = quote('a'), short = quote('b')) => ({ base: long.base, long, short, spreadPercent: 1, buyPrice: 100,
  sellPrice: 101, fundingSpread8h: .0001, updatedAt: NOW, crossCurrency: false });
const reverse = value => ({ ...value, long: value.short, short: value.long });
const originalPairs = rows => rows.map(value => ({ base: value.base, longKey: `${value.long.exchange}:${value.long.symbol}`,
  shortKey: `${value.short.exchange}:${value.short.symbol}`, identity: JSON.stringify([value.long, value.short]
    .map(leg => [`${leg.exchange}:${leg.symbol}`, leg.base, leg.quoteCurrency, leg.marketId ?? null, leg.multiplier ?? 1,
      leg.contractUnit ?? null, leg.collateralCurrency ?? null, leg.settlementCurrency ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))) }));

test('candidate selection matches existing canonical identity and preserves every candidate', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => row(quote('a', `C${index}`), quote('B', `C${index}`)));
  const select = createScannerDataPairSelector(), pairs = select([...rows, ...rows.map(reverse)]);
  assert.equal(pairs.length, 1000);
  assert.deepEqual(pairs, JSON.parse(scannerDataSelectionKey(originalPairs(rows))));
  assert.ok(pairs.every(pair => pair.longKey < pair.shortKey));
});

test('rank order, reversed and duplicated directions retain the same selection array', () => {
  const first = row(), second = row(quote('c', 'ETH'), quote('d', 'ETH'));
  const select = createScannerDataPairSelector(), initial = select([first, second]);
  assert.strictEqual(select([second, first]), initial);
  assert.strictEqual(select([reverse(first), reverse(second)]), initial);
  assert.strictEqual(select([reverse(second), first, second, reverse(first), first]), initial);
  assert.strictEqual(select([first, second]), initial);
});

test('fresh quote objects with price, funding and time changes retain membership and pair references', () => {
  const initialRow = row(), select = createScannerDataPairSelector(), initial = select([initialRow]);
  for (let frame = 1; frame <= 50; frame++) {
    const tick = leg => ({ ...leg, bid: leg.bid + frame, ask: leg.ask + frame, fundingRate: frame / 10000,
      receivedAt: NOW + frame * 1000, bidAskAt: NOW + frame * 1000, fundingAt: NOW + frame * 1000 });
    const next = select([{ ...initialRow, long: tick(initialRow.long), short: tick(initialRow.short), spreadPercent: frame,
      updatedAt: NOW + frame * 1000 }]);
    assert.strictEqual(next, initial);
    assert.strictEqual(next[0], initial[0]);
  }
});

test('adding, removing and replacing candidates updates membership without losing unchanged pair references', () => {
  const first = row(), second = row(quote('c', 'ETH'), quote('d', 'ETH'));
  const select = createScannerDataPairSelector(), initial = select([first]);
  const added = select([first, second]);
  assert.notStrictEqual(added, initial); assert.equal(added.length, 2);
  assert.strictEqual(added.find(pair => pair.base === 'BTC'), initial[0]);
  const removed = select([second]);
  assert.notStrictEqual(removed, added); assert.equal(removed[0].base, 'ETH');
  const replaced = select([first]);
  assert.notStrictEqual(replaced, removed); assert.equal(replaced[0].base, 'BTC');
  const empty = select([]);
  assert.deepEqual(empty, []); assert.strictEqual(select([]), empty);
  assert.equal(select([first, second]).length, 2);
});

test('every existing catalog identity field invalidates only the affected canonical pair', () => {
  const changes = { base: 'RENAMED', quoteCurrency: 'USD', marketId: 7, multiplier: 1000,
    contractUnit: 'contracts', collateralCurrency: 'USDC', settlementCurrency: 'USDG' };
  for (const [field, value] of Object.entries(changes)) {
    const first = row(), second = row(quote('c', 'ETH'), quote('d', 'ETH'));
    const select = createScannerDataPairSelector(), initial = select([first, second]);
    const changed = { ...first, long: { ...first.long, [field]: value } };
    const next = select([changed, second]);
    assert.notStrictEqual(next, initial, field);
    const previousPair = initial.find(pair => pair.base === 'BTC'), changedPair = next.find(pair => pair.base === 'BTC');
    assert.notStrictEqual(changedPair, previousPair, field);
    assert.notEqual(changedPair.identity, previousPair.identity, field);
    assert.strictEqual(next.find(pair => pair.base === 'ETH'), initial.find(pair => pair.base === 'ETH'), field);
    assert.strictEqual(select([reverse(changed), second]), next, field);
    assert.deepEqual(next, JSON.parse(scannerDataSelectionKey(originalPairs([changed, second]))), field);
  }
  for (const field of ['exchange', 'symbol']) {
    const first = row(), select = createScannerDataPairSelector(), initial = select([first]);
    const next = select([{ ...first, long: { ...first.long, [field]: 'relisted' } }]);
    assert.notStrictEqual(next, initial, field); assert.notEqual(next[0].identity, initial[0].identity, field);
  }
});

test('explicit default multiplier and null optional metadata preserve existing identity semantics', () => {
  const first = row(), select = createScannerDataPairSelector(), initial = select([first]);
  const defaults = leg => ({ ...leg, multiplier: 1, marketId: null, contractUnit: null, collateralCurrency: null, settlementCurrency: null });
  assert.strictEqual(select([{ ...first, long: defaults(first.long), short: defaults(first.short) }]), initial);
});
