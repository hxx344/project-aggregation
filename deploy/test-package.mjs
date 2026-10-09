import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const root = path.resolve(process.argv[2]);
const dataDir = await mkdtemp(path.join(tmpdir(), 'ci-package-data-'));
let app;
try {
  const { createApp } = await import(pathToFileURL(path.join(root, 'server/app.mjs')));
  app = await createApp({ dataDir, initialPassword: 'package-test-only-123456', logger: () => {}, intervalMs: 0,
    sourceIntervalMs: 0, refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = suffix => new Promise((resolve, reject) => {
    http.get(base + suffix, { agent: false, headers: { Host: `hub.localhost:${app.server.address().port}`, Authorization: `Basic ${Buffer.from('admin:package-test-only-123456').toString('base64')}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    }).on('error', reject);
  });
  assert.equal((await request('/api/health')).status, 200);
  const page = await request('/');
  assert.equal(page.status, 200);
  const html = page.text;
  assert.match(html, /<html/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  assert.ok(assets.length > 0, 'Built frontend must be served');
  for (const asset of assets) {
    assert.ok((await readFile(path.join(root, 'dist', asset))).length > 0);
    assert.equal((await request(asset)).status, 200);
  }
  console.log('Extracted deployment package: backend, health, frontend and assets passed.');
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
}
