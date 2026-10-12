// Browser-only fixture: native Windows/Linux page server, no collectors or live exchange calls.
// Run after npm run build:linux: node tests/oil-exchanges-server.mjs
import { createServer } from 'node:http';
import { createPageHandler } from '../server/page-handler.mjs';
import { comparisonExchanges, exchangeDefinition } from '../lib/exchange-quotes.ts';
import oilArchive from '../public/oil/data/binance-2026.json' with { type: 'json' };
import oilCandles from '../public/oil/data/binance-15m.json' with { type: 'json' };

function exchangeQuote(exchange, id, now = Date.now()) {
  const spec = exchangeDefinition(exchange, id), at = new Date(now).toISOString();
  const leg = (symbol, price, rate) => ({ symbol, price, fundingPrice: price, fundingRate: rate, fundingIntervalHours: 1, nextFundingAt: new Date(Math.floor(now / 3_600_000 + 1) * 3_600_000).toISOString(), ...(exchange === 'lighter' ? { nextFundingEstimated: true } : {}) });
  const result = { exchange, monitorId: id, currency: spec.currency, priceBasis: spec.priceBasis, fundingPriceBasis: spec.fundingPriceBasis, fetchedAt: at, fundingFetchedAt: at, status: 'live',
    left: leg(spec.left, id === 'oil' ? 104 : 180, 0.0001), right: leg(spec.right, id === 'oil' ? 100 : 1200, 0.0002), fundingError: '' };
  if (exchange === 'variational') {
    result.timestampBasis = 'received';
    for (const item of [result.left, result.right]) item.fundingIntervalHours = 4;
  }
  return result;
}
function exchangeFundingHistory(exchange, now = Date.now()) {
  const spec = exchangeDefinition(exchange, 'oil'), at = new Date(now).toISOString();
  const unsupported = exchange === 'variational';
  const settled = Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000;
  const coverage = unsupported ? null : { from: now - 60 * 24 * 3_600_000, to: now };
  return { exchange, monitorId: 'oil', currency: spec.currency, fetchedAt: at, status: 'live', availability: unsupported ? 'unsupported' : 'supported',
    reason: unsupported ? 'Variational 暂无公开的市场已结算资金费历史接口；当前统计不作为历史结算。' : '',
    left: { symbol: spec.left, fetchedAt: unsupported ? null : at, error: '', coverage }, right: { symbol: spec.right, fetchedAt: unsupported ? null : at, error: '', coverage },
    rows: unsupported ? [] : [
      { time: settled + 17, leftRate: null, rightRate: -0.0002 },
      { time: settled, leftRate: 0.0001, rightRate: null },
      { time: settled - 3_600_000, leftRate: 0, rightRate: 0 },
      { time: settled - 7_200_000, leftRate: -0.0001, rightRate: 0.0002 },
      ...(exchange === 'lighter' ? [{ time: settled - 10_800_000, leftRate: -0.0000307223, rightRate: 1e-12 }] : []),
    ] };
}
const services = new Map(['oil', 'hynix'].map(id => [id, { handle(action) {
  const match = /^exchanges\/([^/]+)\/quote$/.exec(action);
  if (match && comparisonExchanges(id).includes(match[1])) return exchangeQuote(match[1], id);
  const funding = /^exchanges\/([^/]+)\/funding-history$/.exec(action);
  if (funding && id === 'oil' && comparisonExchanges(id).includes(funding[1])) return exchangeFundingHistory(funding[1]);
  if (id === 'oil' && action === 'quote') return { ...oilArchive.market, status: 'snapshot' };
  if (id === 'oil' && action === 'candles/15m') return { ...oilCandles, status: 'snapshot' };
  throw Error('Fixture unavailable');
} }]));
let variationalSession = { available: true, configured: false, revision: 0, expiresAt: null, updatedAt: null, status: 'missing', error: '' };
const app = await createPageHandler({ services });
const handler = app.handle;
const server = createServer((request, response) => {
  if (request.url === '/__stop' && request.method === 'POST') { response.end('stopped'); void stop(); return; }
  if (request.url === '/api/monitors/oil/exchanges/variational/session') {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET') { response.end(JSON.stringify(variationalSession)); return; }
    if (request.method === 'PUT') {
      let body = '';
      request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        let input;
        try { input = JSON.parse(body); } catch { response.writeHead(400).end(JSON.stringify({ error: '请求格式不正确。' })); return; }
        if (input.revision !== variationalSession.revision) { response.writeHead(409).end(JSON.stringify({ error: '配置已更新，请刷新。' })); return; }
        if (typeof input.token !== 'string' || !input.token.trim()) { response.writeHead(400).end(JSON.stringify({ error: '请填写 token。' })); return; }
        variationalSession = { available: true, configured: true, revision: variationalSession.revision + 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString(), status: 'ready', error: '' };
        response.end(JSON.stringify(variationalSession));
      });
      return;
    }
    response.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' })); return;
  }
  const match = /^\/api\/monitors\/(oil|hynix)\/(exchanges\/[^/]+\/(?:quote|funding-history))$/.exec(request.url);
  if (match) {
    try { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(services.get(match[1]).handle(match[2]))); }
    catch { response.writeHead(404).end(); }
    return;
  }
  // Browser scenarios never reach real upstreams, even for unrelated panel reads.
  if (request.url.startsWith('/api/')) { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Fixture unavailable' })); return; }
  void handler(request, response).catch(error => {
    console.error('Fixture page handler failed:', error);
    if (response.headersSent) { response.destroy(error); return; }
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Fixture rendering failed');
  });
});
await new Promise(resolve => server.listen(3192, '127.0.0.1', resolve));
console.log('Oil exchange fixture ready at http://127.0.0.1:3192');
async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
