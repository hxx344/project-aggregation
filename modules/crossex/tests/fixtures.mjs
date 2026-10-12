import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createEngine } from '../server/engine.mjs';
import { pairKey } from '../server/model.mjs';
export const epoch = 1790000000000;
export function quote(exchange, at = epoch, extra = {}) { return { exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', collateralCurrency: 'USDT', multiplier: 1, assetClass: 'crypto', identitySource: 'test-official-directory', identityVerified: true, bid: exchange === 'binance' ? 99 : 102, ask: exchange === 'binance' ? 100 : 103, bidAskAt: at, receivedAt: at, ...extra }; }
export function feed(at = epoch) { const long = quote('binance', at), short = quote('bybit', at); const signal = { id: `signal-${at}`, base: 'BTC', quoteCurrency: 'USDT', long, short, observedAt: at, expiresAt: at + 10000 }; return { schemaVersion: 1, mode: 'paper', source: 'market-monitor', monitorId: 'perpetual', generatedAt: at, status: 'live', exchanges: [{ id: 'binance', status: 'live' }, { id: 'bybit', status: 'live' }], quotes: [long, short], signals: [{ ...signal, pairKey: pairKey(signal) }] }; }
export const catalog = ['BINANCE', 'BYBIT'].map(exchange => ({ symbol: `${exchange}_FUTURE_BTC_USDT`, exchange_type: exchange, business_type: 'FUTURE', state: 'live', min_size: '0.001', lot_size: '0.001', tick_size: '0.01', min_notional: '5', max_market_size: '10000', delist_time: '0' }));
export function book(q, at = epoch) { return { at, bids: [[q.bid, 100]], asks: [[q.ask, 100]] }; }
export function fixture(t, engineOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-test-')); let now = epoch, currentFeed = feed(), currentCatalog = catalog, depth = q => book(q, now), offline = false;
  let store = createStore(directory); const options = { clock: () => now, catalogReader: async () => currentCatalog, feedReader: async () => { if (offline) throw new Error('offline'); return currentFeed; }, depthReader: async q => depth(q), fxReader: async () => currentFeed.fx, fundingReader: async (q, from, to) => ({ exchange: q.exchange, symbol: q.symbol, from, to, coveredFrom: from, coveredTo: to, complete: true, source: 'test', sourceAt: now, current: null, settlements: [] }), ...engineOptions };
  let engine = createEngine(store, options);
  t.after(async () => { await engine.stop(); store.close(); const resolved = join(tmpdir(), ''); if (!directory.startsWith(resolved) || !directory.includes('crossex-test-')) throw new Error('Unsafe test cleanup'); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, get engine() { return engine; }, advance(ms) { now += ms; }, setFeed(value) { currentFeed = value; }, setCatalog(value) { currentCatalog = value; }, setDepth(fn) { depth = fn; }, offline(value) { offline = value; }, now: () => now, async reopen() { await engine.stop(); store.close(); store = createStore(directory); engine = createEngine(store, options); } };
}
