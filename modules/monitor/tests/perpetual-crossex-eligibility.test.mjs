import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCrossExRanking, indexSpotTransferPairs, parseCrossExSettings, spotTransferPairState } from '../lib/perpetual-crossex-eligibility.ts';

const NOW = 1790000000000;
const pair = (base = 'BTC', exchanges = ['binance', 'gate']) => ({ base, exchanges, networks: ['BTC'], checkedAt: NOW - 100, expiresAt: NOW + 100 });
const row = (base = 'BTC', exchanges = ['binance', 'gate']) => ({ base, long: { base, exchange: exchanges[0], multiplier: 1 }, short: { base, exchange: exchanges[1], multiplier: 1 } });
const settings = (pairs = [pair()]) => ({ available: true, generatedAt: NOW, revision: 1, metadataRevision: 1, config: { requireSpotTransfer: true, blockedBases: [] }, error: '', venues: [], spotTransferPairs: pairs });

test('settings validation rejects incomplete, ambiguous and forged qualification evidence', () => {
  assert.deepEqual(parseCrossExSettings(settings()), settings());
  for (const input of [null, {}, { ...settings(), metadataRevision: undefined }, { ...settings(), generatedAt: null }, { ...settings(), revision: -1 }, settings([pair(), pair('BTC', ['gate', 'binance'])]),
    ...[{ exchanges: ['binance', 'binance'] }, { exchanges: ['binance', 'unknown'] }, { networks: [] }, { networks: ['BTC', 'BTC'] }, { checkedAt: NOW + 1 }, { expiresAt: NOW - 100 }, { expiresAt: NOW + 180_001 }].map(patch => settings([{ ...pair(), ...patch }]))]) assert.throws(() => parseCrossExSettings(input));
});

test('qualification matches base and both venues in either direction and rejects multipliers', () => {
  const data = settings(), index = indexSpotTransferPairs(data.spotTransferPairs);
  assert.equal(spotTransferPairState(row(), data, index, NOW), 'verified');
  assert.equal(spotTransferPairState(row('BTC', ['gate', 'binance']), data, index, NOW), 'verified');
  for (const candidate of [row('ETH'), row('BTC', ['binance', 'bybit']), { ...row(), long: { ...row().long, multiplier: 1000 } }, { ...row(), short: { ...row().short, base: 'BTC2' } }]) assert.equal(spotTransferPairState(candidate, data, index, NOW), 'unknown');
  assert.equal(spotTransferPairState(row(), data, index, NOW - 101), 'unknown');
  assert.equal(spotTransferPairState(row(), data, index, NOW + 100), 'expired');
  assert.equal(spotTransferPairState(row(), { ...data, error: 'offline' }, index, NOW), 'unknown');
});

test('full sorted ranking is qualified before pagination and statistics, including frozen rows', () => {
  const rows = Array.from({ length: 230 }, (_, i) => ({ ...row(`T${i}`), spreadPercent: 230 - i, netSpreadPercent: 230 - i }));
  const data = settings(rows.slice(205).map(r => pair(r.base))), index = indexSpotTransferPairs(data.spotTransferPairs);
  const ranking = filterCrossExRanking(rows, data, index, NOW);
  assert.equal(ranking.length, 25); assert.equal(ranking.filter(r => r.netSpreadPercent > 0).length, 25);
  assert.equal(ranking.slice(0, 30)[0].base, 'T205'); assert.equal(ranking[24].base, 'T229');
  assert.deepEqual(filterCrossExRanking(ranking, data, index, NOW + 100), [], 'a frozen list cannot retain expired evidence');
  assert.deepEqual(filterCrossExRanking(ranking, settings([]), indexSpotTransferPairs([]), NOW), [], 'new metadata removes a frozen qualification');
  assert.deepEqual(filterCrossExRanking(rows, null, index, NOW), []);
  data.config = { requireSpotTransfer: false, blockedBases: ['T0'] };
  assert.deepEqual(filterCrossExRanking(rows, data, index, NOW + 100), rows.slice(1));
  assert.equal(spotTransferPairState(row(), data, index, NOW), 'disabled');
  assert.equal(rows.length, 230, 'qualification never mutates the quote/ranking source');
});
