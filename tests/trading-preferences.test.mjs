import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Resolve the frontend's extensionless TS imports under Node's native type stripping.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('./') && context.parentURL?.includes('/src/') && error.code === 'ERR_MODULE_NOT_FOUND') return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const preferences = await import('../src/trading-preferences.ts');
const { normalizeTradingPreferences, readTradingPreferences, saveTradingPreferences, normalizeShares, EXECUTION_PREFERENCES_KEY, PAIR_PREFERENCE_KEY, DAYS_PREFERENCE_KEY, readTradingPair, readTradingDays } = preferences;
const { readPreference, writePreference } = await import('../src/ui-preferences.ts');
const { readTradingSection, saveTradingSection } = await import('../src/trading-navigation.ts');
const memory = new Map();
const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

test('restores ANT/Lighter choices and separate per-market settings without execution authority', () => {
  const value = normalizeTradingPreferences(null); value.market = 'anthropic';
  Object.assign(value.profiles.anthropic, { anthropicKeys: ['rh-lighter:ANTHROPIC', 'binance:ANTHROPICUSDT'], orientation: 'reverse', action: 'close', batchCount: '4', advanced: true,
    orderTypes: { 'rh-lighter-ANTHROPIC': 'market' }, equalSize: '167', previewId: 'old-preview', requestId: 'old-request', apiKey: 'do-not-save', quantity: '99' });
  value.profiles.oil.selectedExchange = 'okx';
  saveTradingPreferences(value);
  const restored = readTradingPreferences('binance,bybit');
  assert.equal(restored.market, 'anthropic');
  assert.deepEqual(restored.profiles.anthropic.anthropicKeys, ['rh-lighter:ANTHROPIC', 'binance:ANTHROPICUSDT']);
  assert.equal(restored.profiles.anthropic.orientation, 'reverse');
  assert.equal(restored.profiles.anthropic.action, 'close');
  assert.equal(restored.profiles.anthropic.orderTypes['rh-lighter-ANTHROPIC'], 'market');
  assert.equal(restored.profiles.oil.selectedExchange, 'okx');
  for (const forbidden of ['equalSize', 'previewId', 'requestId', 'apiKey', 'quantity']) assert.ok(!memory.get(EXECUTION_PREFERENCES_KEY).includes(forbidden), forbidden);
});

test('bad contracts, symbols, actions, timing and unknown fields fall back with no old direction', () => {
  const value = normalizeTradingPreferences({ market: 'unknown', profiles: {
    oil: { selectedSymbol: 'SKHYUSDT', orientation: 'forward', batchCount: '201', timeout: 'Infinity' },
    anthropic: { action: 'close', anthropicKeys: ['rh-lighter:ANTHROPIC', 'rh-lighter:ANTHROPIC'], orientation: 'reverse', orderTypes: { 'unknown-secret': 'market', 'rh-lighter-ANTHROPIC': 'bad' } },
  } });
  assert.equal(value.market, 'oil');
  assert.equal(value.profiles.oil.selectedSymbol, 'CLUSDT');
  assert.equal(value.profiles.oil.orientation, '');
  assert.equal(value.profiles.oil.batchCount, '1');
  assert.equal(value.profiles.oil.timeout, '300');
  assert.equal(value.profiles.anthropic.orientation, '');
  assert.notEqual(...value.profiles.anthropic.anthropicKeys);
  assert.deepEqual(value.profiles.anthropic.orderTypes, {});
  assert.deepEqual(normalizeTradingPreferences([]), normalizeTradingPreferences(null));
  for (const invalid of [{ selectedExchange: ['okx'] }, { preset: ['four-leg'] }, { selectedExchange: { toString: null } }, { preset: { toString: null } }]) {
    const saved = normalizeTradingPreferences(null);
    Object.assign(saved.profiles.oil, { orientation: 'reverse' }, invalid);
    assert.equal(normalizeTradingPreferences(saved).profiles.oil.orientation, '', 'coerced enums cannot preserve the direction of a different structure');
  }
});

test('different cross-venue pair invalidates saved direction, ANT and same-venue choices survive', () => {
  const value = normalizeTradingPreferences(null);
  Object.assign(value.profiles.oil, { orientation: 'forward', preset: 'four-leg', pair: 'binance,okx' });
  value.profiles.hynix.orientation = 'reverse'; value.profiles.anthropic.orientation = 'forward';
  saveTradingPreferences(value);
  assert.equal(readTradingPreferences('binance,okx').profiles.oil.orientation, 'forward');
  const changed = readTradingPreferences('bybit,okx');
  assert.equal(changed.profiles.oil.orientation, '');
  assert.equal(changed.profiles.hynix.orientation, 'reverse');
  assert.equal(changed.profiles.anthropic.orientation, 'forward');
});

test('explicit URL and legacy links win over saved navigation; reversed pairs remain supported', () => {
  writePreference(PAIR_PREFERENCE_KEY, 'bybit,okx'); writePreference(DAYS_PREFERENCE_KEY, 30); saveTradingSection('trade');
  assert.equal(readTradingPair(''), 'bybit,okx'); assert.equal(readTradingDays(''), 30); assert.equal(readTradingSection(''), 'trade');
  assert.equal(readTradingPair('?tradingPair=okx,binance'), 'binance,okx');
  assert.equal(readTradingPair('?tradingPair=unknown'), 'binance,bybit');
  assert.equal(readTradingDays('?tradingDays=7'), 7); assert.equal(readTradingSection('?tradingSection=positions'), 'positions');
  saveTradingSection('accounts'); assert.equal(readTradingSection('?tradingPair=binance,okx'), 'trade');
});

test('shares retain decimal strings and reject incomplete, inconsistent or oversized values', () => {
  assert.deepEqual(normalizeShares({ outstanding: '13.100', diluted: '18.20' }), { outstanding: '13.100', diluted: '18.20' });
  for (const value of [null, { outstanding: '30', diluted: '20' }, { outstanding: '', diluted: '20' }, { outstanding: '1'.repeat(30), diluted: '20' }]) assert.deepEqual(normalizeShares(value), { outstanding: '12.7', diluted: '16.7' });
});

test('malformed, oversized and unavailable storage never breaks defaults or editing', () => {
  for (const raw of ['{', 'x'.repeat(32_769)]) { memory.set(EXECUTION_PREFERENCES_KEY, raw); assert.equal(readTradingPreferences('binance,bybit').market, 'oil'); }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try { assert.equal(readPreference('test'), null); assert.doesNotThrow(() => writePreference('test', true)); assert.equal(readTradingPreferences('binance,bybit').market, 'oil'); }
  finally { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage }); }
});
