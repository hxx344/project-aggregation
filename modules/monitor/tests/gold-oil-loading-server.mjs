// Local production-rendering fixture for gold-oil-loading.browser.mjs.
// Run after build:linux: node tests/gold-oil-loading-server.mjs
// No collectors, notifications, network data sources or persistent files.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPageHandler } from '../server/page-handler.mjs';
import { parseGoldOilAction } from '../lib/gold-oil.ts';
import { parseGoldOilChartRange, projectGoldOilChartData } from '../lib/gold-oil-chart-data.ts';

export function createGoldOilLoadingFixture(now = Date.now()) {
const size = 20_000, end = Math.floor(now / 900000) * 900000, start = end - size * 900000;
const common = { source: 'Binance', currency: 'USDT', priceBasis: 'mark', status: 'live', fetchedAt: new Date(now).toISOString() };
const history = { ...common, interval: '15m', coverageStart: start, points: Array.from({ length: size }, (_, index) => {
  const cl = 80 + Math.sin(index / 20), xau = index === size - 12 ? null : 4000 + index / 10;
  return { time: start + index * 900000, cl, xau, ratio: xau === null ? null : xau / cl };
}) };
const quote = { ...common, cl: { symbol: 'CLUSDT', price: 80, updatedAt: common.fetchedAt }, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: common.fetchedAt }, ratio: 50, funding: null };
const funding = { source: 'Binance', status: 'live', fetchedAt: common.fetchedAt, coverageStart: start, coverageEnd: end,
  points: Array.from({ length: size / 8 }, (_, index) => ({ time: start + index * 7200000, cl: 0.0001, xau: 0.0003 })) };
const bz = {
  quote: { ...quote, oilType: 'bz', cl: undefined, oil: { symbol: 'BZUSDT', price: 100, updatedAt: common.fetchedAt }, ratio: 40 },
  history: { ...history, oilType: 'bz', points: history.points.map(({ time, xau }) => ({ time, oil: 100, xau, ratio: xau === null ? null : xau / 100 })) },
  funding: { ...funding, oilType: 'bz', points: funding.points.map(({ time, xau }) => ({ time, oil: 0.0005, xau })) },
};
delete bz.quote.cl;
const bybitMarket = (market, oilType) => {
  const bybitQuote = { ...market.quote, source: 'Bybit', oilType, oil: market.quote.oil ?? market.quote.cl,
    xau: { ...market.quote.xau, price: 4800 }, ratio: 4800 / (market.quote.oil ?? market.quote.cl).price };
  delete bybitQuote.cl;
  return { quote: bybitQuote,
    history: { ...market.history, source: 'Bybit', oilType, points: market.history.points.map(({ time, oil, cl, xau }) => ({ time, oil: oil ?? cl, xau: xau === null ? null : xau * 1.2, ratio: xau === null ? null : xau * 1.2 / (oil ?? cl) })) },
    funding: { ...market.funding, source: 'Bybit', oilType, points: market.funding.points.map(({ time, oil, cl, xau }) => ({ time, oil: oil ?? cl, xau })) },
  };
};
const bybit = { ...bybitMarket({ quote, history, funding }, 'cl'), bz: bybitMarket(bz, 'bz') };
const snapshots = { quote, history, funding, bz, bybit };
const chartFixture = (input = {}) => {
  const oilType = input.oilType ?? 'cl', exchange = input.exchange ?? 'binance';
  const source = exchange === 'bybit' ? bybit : snapshots, market = oilType === 'bz' ? source.bz : source;
  const scenario = input.scenario ?? 'success';
  if (!['success', 'pending', 'price-only', 'funding-only'].includes(scenario)) throw Error('Unknown chart fixture scenario');
  return projectGoldOilChartData(
    ['pending', 'funding-only'].includes(scenario) ? null : market.history,
    ['pending', 'price-only'].includes(scenario) ? null : market.funding,
    parseGoldOilChartRange(input.range), oilType, exchange,
    { historyError: scenario === 'funding-only' ? 'Fixture price source unavailable' : null,
      fundingError: scenario === 'price-only' ? 'Fixture funding source unavailable' : null },
  );
};
const services = new Map([['cl-xau', { handle(action, method = 'GET', input) {
  if (method !== 'GET') throw Error('Business writes are forbidden in this fixture');
  const parsed = parseGoldOilAction(action);
  if (!parsed) throw Error('Unknown fixture action');
  if (parsed.action === 'chart') return chartFixture({ ...input, oilType: parsed.oilType, exchange: parsed.exchange });
  const source = parsed.exchange === 'bybit' ? bybit : snapshots, market = parsed.oilType === 'bz' ? source.bz : source;
  return market[parsed.action];
} }]]);
return { snapshots, services, chartFixture };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
const { snapshots, services, chartFixture } = createGoldOilLoadingFixture();
const app = await createPageHandler({ services, root: fileURLToPath(new URL('..', import.meta.url)) });
const handler = app.handle;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:3190');
  const send = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : JSON.stringify(value)); };
  if (request.url === '/__stop' && request.method === 'POST') { response.end('stopped'); void stop(); return; }
  if (!['GET', 'HEAD'].includes(request.method)) return send({ error: 'Business writes are forbidden in this fixture' }, 405);
  if (url.pathname === '/__fixture') return send(snapshots);
  if (url.pathname === '/__chart-fixture') {
    try { return send(chartFixture(Object.fromEntries(url.searchParams))); }
    catch (error) { return send({ error: error.message }, 400); }
  }
  if (url.pathname.startsWith('/api/monitors/cl-xau/')) {
    const action = url.pathname.slice('/api/monitors/cl-xau/'.length), parsed = parseGoldOilAction(action);
    if (parsed && ['quote', 'history', 'funding', 'chart'].includes(parsed.action)) {
      try { return send(services.get('cl-xau').handle(action, 'GET', Object.fromEntries(url.searchParams))); }
      catch (error) { return send({ error: error.message }, 400); }
    }
  }
  void handler(request, response).catch(error => {
    console.error('Fixture page handler failed:', error);
    if (response.headersSent) { response.destroy(error); return; }
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Fixture rendering failed');
  });
});
await new Promise(resolve => server.listen(3190, '127.0.0.1', resolve));
console.log('Seeded chart fixture ready at http://127.0.0.1:3190');
async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
}
