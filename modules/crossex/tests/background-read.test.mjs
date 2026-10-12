import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createLatestRead } from '../src/latest-read.ts';
import * as loading from '../src/live-loading.ts';
import * as freshness from '../src/freshness.ts';
import * as display from '../src/display.ts';
import * as liveDisplay from '../src/live-display.ts';
import * as liveRequests from '../src/live-requests.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));

// Execute the real bridge and hooks with deterministic browser events and timers.
function browser({ embedded = false, hidden = false, tab = 'positions' } = {}) {
  const states = [], effects = [], cleanups = [], timers = new Map(), requests = [], sent = [];
  let serial = 0, intersection, cursor = 0;
  const events = () => {
    const handlers = new Map();
    return {
      addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
      removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
      fire(name, event) { for (const fn of handlers.get(name) || []) fn(event); },
    };
  };
  const document = { ...events(), hidden, documentElement: {} };
  const navigator = { onLine: true };
  const window = { ...events(), location: { hostname: embedded ? `p-${'a'.repeat(24)}.hub.localhost` : 'localhost', protocol: 'http:', port: '3100', pathname: '/', hash: '#' + tab, href: 'http://localhost:3100/#' + tab } };
  window.parent = embedded ? { postMessage: (data, origin) => sent.push({ data, origin }) } : window;
  const react = {
    useState(initial) { const index = cursor++; if (index === states.length) states.push(typeof initial === 'function' ? initial() : initial); return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useEffect(effect) { effects.push(effect); },
    useRef: current => ({ current }), useCallback: callback => callback,
  };
  const context = { document, navigator, window, location: window.location, addEventListener: window.addEventListener, removeEventListener: window.removeEventListener, URL, PopStateEvent: class {}, AbortController, AbortSignal,
    performance: { now: () => 0 },
    IntersectionObserver: class { constructor(callback) { intersection = callback; } observe() {} disconnect() { intersection = null; } },
    setTimeout(fn, ms) { timers.set(++serial, { fn, ms }); return serial; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { timers.set(++serial, { fn, ms, interval: true }); return serial; }, clearInterval(id) { timers.delete(id); },
    fetch(url, { signal }) { return new Promise((resolve, reject) => requests.push({ url, signal, resolve, reject })); },
  };
  const modules = { react, 'react/jsx-runtime': { jsx: () => null, jsxs: () => null }, 'lucide-react': {}, './latest-read': { createLatestRead }, './live-loading': loading,
    './freshness': freshness, './display': display, './live-display': liveDisplay, './live-requests': liveRequests };
  for (const name of ['AccountOverview', 'PortfolioPanel', 'TradingTerminal', 'ManualHedgePanel', 'SettingsForm', 'HistoryPanel', 'TradeReview']) modules[`./${name}`] = { default: () => null };
  function load(name, extension = 'ts') {
    const module = { exports: {} };
    const code = ts.transpileModule(fs.readFileSync(new URL(`../src/${name}.${extension}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(code, { ...context, module, exports: module.exports, require: key => { assert.ok(modules[key], key); return modules[key]; } });
    modules[`./${name}`] = module.exports;
    return module.exports;
  }
  const bridge = load('hub-bridge');
  const market = load('live-market');
  return { document, navigator, window, states, timers, requests, sent, bridge, market,
    app() { load('App', 'tsx').default(); },
    rerender(render) { for (const cleanup of cleanups.splice(0)) cleanup(); cursor = 0; render(); },
    mount() { for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
    stop() { for (const cleanup of cleanups.splice(0)) cleanup(); },
    intersect(value) { intersection?.([{ isIntersecting: value }]); },
    message(data, extra = {}) { window.fire('message', { source: window.parent, origin: 'http://hub.localhost:3100', data: { channel: 'project-hub', version: 1, ...data }, ...extra }); },
    respond(request, data) { request.resolve({ ok: true, json: async () => data }); },
    timer(ms) { const entry = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(entry, `missing timer ${ms}`); timers.delete(entry[0]); entry[1].fn(); },
  };
}

test('trusted background reads are separate from visibility and preserve old-host and offline behavior', () => {
  const f = browser({ embedded: true }); f.bridge.useHubBridge('crossex'); f.mount();
  const current = () => f.states[0];
  assert.equal(current().readActive, false);
  f.message({ type: 'activity', active: false, backgroundUpdates: true });
  assert.equal(current().readActive, false);
  f.message({ type: 'ready', role: 'host' });
  f.message({ type: 'activity', active: false, backgroundUpdates: true }, { origin: 'http://evil.localhost:3100' });
  assert.equal(current().readActive, false);
  f.message({ type: 'activity', active: true });
  assert.equal(current().active, true);
  f.intersect(false);
  assert.equal(current().readActive, false, 'old hosts retain their previous pause behavior');
  f.message({ type: 'activity', active: false, backgroundUpdates: true });
  assert.equal(current().active, false);
  assert.equal(current().readActive, true);
  assert.equal(current().background, true);
  f.document.hidden = true; f.document.fire('visibilitychange');
  assert.equal(current().readActive, true);
  f.navigator.onLine = false; f.window.fire('offline');
  assert.equal(current().readActive, false);
  f.navigator.onLine = true; f.window.fire('online');
  assert.equal(current().readActive, true);
  f.document.hidden = false; f.document.fire('visibilitychange'); f.intersect(true);
  f.message({ type: 'activity', active: true, backgroundUpdates: true });
  assert.equal(current().active, true);
  assert.equal(current().background, false);
  f.message({ type: 'activity', active: false });
  assert.equal(current().readActive, false);
  f.stop();
});

test('the hidden account and settings routes keep reading only their own data and ignore stale wake responses', async () => {
  const f = browser({ hidden: true }); f.app(); f.mount(); await flush();
  assert.deepEqual(f.requests.map(request => request.url).sort(), ['/api/bootstrap', '/api/live/instruments', '/api/state?opportunities=0']);
  const first = f.requests.find(request => request.url.startsWith('/api/state'));
  f.respond(first, { now: Date.now(), csrfToken: 'test-token', live: {}, marker: 'background' }); await flush();
  assert.equal(f.states[1].marker, 'background');
  f.timer(30000); await flush();
  const old = f.requests.at(-1);
  f.document.hidden = false; f.document.fire('visibilitychange'); await flush();
  assert.equal(old.signal.aborted, true);
  const current = f.requests.filter(request => request.url.startsWith('/api/state')).at(-1);
  f.respond(current, { now: Date.now(), csrfToken: 'test-token', live: {}, marker: 'fresh' }); await flush();
  f.respond(old, { now: Date.now(), csrfToken: 'test-token', live: {}, marker: 'late' }); await flush();
  assert.equal(f.states[1].marker, 'fresh'); f.stop();

  const settings = browser({ hidden: true, tab: 'settings' }); settings.app(); settings.mount(); await flush();
  assert.deepEqual(settings.requests.map(request => request.url), ['/api/bootstrap']);
  settings.respond(settings.requests[0], { now: Date.now(), csrfToken: 'test-token', connection: { configured: false, connected: false }, config: { monitorUrl: '', entryPaused: false } }); await flush();
  settings.timer(30000); await flush();
  assert.deepEqual(settings.requests.map(request => request.url), ['/api/bootstrap', '/api/bootstrap']); settings.stop();
});

test('standalone hidden pages can read without a host and slow retries to at least thirty seconds', () => {
  const f = browser({ hidden: true }); f.bridge.useHubBridge('crossex'); f.mount();
  assert.equal(f.states[0].active, false);
  assert.equal(f.states[0].readActive, true);
  assert.equal(f.bridge.readPollDelay(2000, false), 30000);
  assert.equal(f.bridge.readPollDelay(60000, true), 60000);
  f.stop();
});

test('hidden market polling continues, wake discards a stalled response, and cleanup stops reads', async () => {
  const f = browser({ hidden: true }); f.market.useMarket('BTC_USDT', '5m', true); f.mount();
  assert.equal(f.requests.length, 1);
  f.respond(f.requests[0], { symbol: 'BTC_USDT', interval: '5m', marker: 'background' }); await flush();
  assert.equal(f.states[0].marker, 'background');
  f.timer(30000); assert.equal(f.requests.length, 2);
  const old = f.requests[1];
  f.document.hidden = false; f.document.fire('visibilitychange');
  assert.equal(old.signal.aborted, true);
  assert.equal(f.requests.length, 3);
  f.respond(f.requests[2], { symbol: 'BTC_USDT', interval: '5m', marker: 'fresh' }); await flush();
  f.respond(old, { symbol: 'BTC_USDT', interval: '5m', marker: 'late' }); await flush();
  assert.equal(f.states[0].marker, 'fresh');
  f.timer(2000); assert.equal(f.requests.length, 4);
  f.window.fire('focus'); assert.equal(f.requests[3].signal.aborted, true);
  f.window.fire('pageshow'); assert.equal(f.requests[4].signal.aborted, true);
  f.stop(); assert.equal(f.requests.at(-1).signal.aborted, true);
  assert.equal(f.timers.size, 0);
  const count = f.requests.length; f.window.fire('focus');
  assert.equal(f.requests.length, count);
});

test('catalog loads in the background and inactive routes do not start market or catalog requests', async () => {
  const f = browser({ hidden: true }); f.market.useInstruments(true, true); f.mount(); await flush();
  assert.equal(f.requests[0].url, '/api/live/instruments');
  f.respond(f.requests[0], { items: [{ symbol: 'BTC_USDT' }] }); await flush();
  assert.equal(f.states[0][0].symbol, 'BTC_USDT');
  assert.ok([...f.timers.values()].every(timer => timer.ms >= 30000)); f.stop();
  const inactive = browser(); inactive.market.useMarket('BTC_USDT', '5m', false); inactive.market.useInstruments(false); inactive.mount();
  assert.equal(inactive.requests.length, 0); inactive.stop();
});

test('market visibility changes retain the current symbol while offline and new symbols remain explicit', async () => {
  const f = browser(); f.market.useMarket('BTC_USDT', '5m', true); f.mount();
  f.respond(f.requests[0], { symbol: 'BTC_USDT', interval: '5m', marker: 'known', status: 'live' }); await flush();
  f.rerender(() => f.market.useMarket('BTC_USDT', '5m', true, true)); f.mount();
  assert.equal(f.states[0].marker, 'known', 'background transition does not clear the chart');
  const count = f.requests.length;
  f.rerender(() => f.market.useMarket('BTC_USDT', '5m', false, true)); f.mount();
  assert.equal(f.states[0].marker, 'known'); assert.equal(f.states[0].status, 'stale');
  assert.equal(f.requests.length, count);
  f.rerender(() => f.market.useMarket('ETH_USDT', '5m', true)); f.mount();
  assert.equal(f.states[0], null, 'another symbol never inherits the old book'); f.stop();
});
