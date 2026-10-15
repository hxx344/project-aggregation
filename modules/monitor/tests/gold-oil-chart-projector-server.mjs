// Companion for CLI browser regressions whose fixtures mutate during a scenario.
// Run from the repository root: node modules/monitor/tests/gold-oil-chart-projector-server.mjs
// Playwright CLI's VM cannot import modules. This loopback-only helper projects
// supplied test data in memory; it never reads collectors, writes storage or trades.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseGoldOilChartRange, projectGoldOilChartData } from '../lib/gold-oil-chart-data.ts';

export function createGoldOilChartProjectorServer() {
  return createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (request.url !== '/project') return send(404, { error: 'Unknown fixture endpoint' });
    if (request.method !== 'POST') return send(405, { error: 'Use POST to project test fixture data' });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) return send(413, { error: 'Fixture input exceeds 16 MB' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      return send(200, projectGoldOilChartData(input.history, input.funding, parseGoldOilChartRange(input.range),
        input.oilType ?? 'cl', input.exchange ?? 'binance', input.errors ?? {}));
    } catch (error) { return send(400, { error: error.message }); }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createGoldOilChartProjectorServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3192, '127.0.0.1', resolve); });
  console.log('Read-only chart projector fixture ready at http://127.0.0.1:3192/project');
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
