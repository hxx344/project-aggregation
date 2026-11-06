// Local browser fixture: the real monitor HTTP handler over 60 days of 15-minute oil candles and an embedded Hynix trend.
// No collectors, database, credentials or live APIs.
// node --experimental-strip-types tests/oil-window-server.mjs [3197]
import { createServer } from 'node:http';
import { createPageHandler } from '../server/page-handler.mjs';
import { createHandler } from '../server/http.mjs';
import { createIntradaySnapshot, OIL_CANDLE_MS } from '../modules/oil/intraday.mjs';

const port = Number(process.argv[2] ?? 3197);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Expected a local fixture port');
const credentials = { username: 'admin', password: 'oil-window-fixture' };
const hour = 3_600_000, renderedAt = Date.now(), last = Math.floor(renderedAt / OIL_CANDLE_MS) * OIL_CANDLE_MS - OIL_CANDLE_MS;
const bars = 60 * 96;
const candles = { ...createIntradaySnapshot(Array.from({ length: bars }, (_, index) => ({ time: last - (bars - 1 - index) * OIL_CANDLE_MS, brent: 70 + index % 5 / 10, wti: 66 })), new Date(renderedAt).toISOString()), status: 'live' };
const lastHour = Math.floor(renderedAt / hour) * hour - hour;
const history = { status: 'live', fetchedAt: new Date(renderedAt).toISOString(), interval: '1h', firstAvailable: new Date(lastHour - 199 * hour).toISOString(), warnings: [],
  points: Array.from({ length: 200 }, (_, index) => ({ time: lastHour - (199 - index) * hour, ordinary: 1000, adr: 104 + index % 3, equivalent: 100, spread: 4 + index % 3, premium: 4 + index % 3 })) };
const quote = () => {
  const fetchedAt = new Date().toISOString(), leg = (coin, markPx) => ({ coin, markPx, fundingRate: 0, fundingIntervalHours: 4, nextFundingAt: new Date(Date.now() + hour).toISOString() });
  return { source: 'Binance', currency: 'USDT', status: 'live', fetchedAt, brent: leg('BZUSDT', 71), wti: leg('CLUSDT', 66), collection: { maxAgeMs: 75_000 } };
};
const unavailable = () => { throw new Error('Fixture dataset unavailable'); };
const services = new Map([
  ['oil', { actions: { quote: ['GET'], 'candles/15m': ['GET'] }, async handle(action) { return action === 'candles/15m' ? candles : action === 'quote' ? quote() : unavailable(); } }],
  ['hynix', { actions: { history: ['GET'] }, async handle(action) { return action === 'history' ? history : unavailable(); } }],
]);
const pages = await createPageHandler({ services });
const handle = createHandler({ services, ...credentials, pageHandler: pages.handle });
const server = createServer((request, response) => {
  if (request.url === '/__stop' && request.method === 'POST') { response.end('stopped'); void stop(); return; }
  void handle(request, response);
});
await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
process.stdout.write(`Oil candle window fixture ready at http://127.0.0.1:${port}\n`);
async function stop() {
  server.closeAllConnections();
  await new Promise(accept => server.close(accept));
  await pages.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
