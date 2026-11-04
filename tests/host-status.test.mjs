import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHostStatus } from '../server/host-status.mjs';
import { createApp } from '../server/app.mjs';

const GiB = 1024 ** 3;
const core = (busy, idle) => ({ model: ' Test CPU ', times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
const fsInfo = (blocks, bfree, bavail) => ({ bsize: 4096, blocks, bfree, bavail });
function fixture({ ticks, disks = {}, devices = {}, meminfo = 'SwapTotal:  2097152 kB\nSwapFree:   1048576 kB\n' }) {
  let at = 0, index = 0;
  const host = createHostStatus({ dataDir: '/data', now: () => at, cpus: () => ticks[Math.min(index++, ticks.length - 1)],
    totalmem: () => 8 * GiB, freemem: () => 2 * GiB, loadavg: () => [0.123, 0.5, 1], uptime: () => 90061.7, meminfo: async () => meminfo,
    statDisk: async target => { if (!disks[target]) throw new Error('missing'); return disks[target]; },
    statPath: async target => ({ dev: devices[target] ?? 1 }), wait: async () => {} });
  return { host, advance: ms => { at += ms; } };
}

test('host status reports CPU between readings, memory, swap and disks without paths', async () => {
  const { host, advance } = fixture({
    ticks: [[core(100, 900), core(100, 900)], [core(150, 950), core(150, 950)], [core(240, 960), core(240, 960)]],
    disks: { '/data': fsInfo(1000, 400, 300), '/': fsInfo(2000, 1500, 1400) }, devices: { '/data': 2, '/': 1 },
  });
  const first = await host.read();
  assert.equal(first.cpu.usagePercent, 50); assert.equal(first.cpu.cores, 2); assert.equal(first.cpu.model, 'Test CPU');
  assert.deepEqual(first.cpu.loadAverage, [0.12, 0.5, 1]);
  assert.deepEqual(first.memory, { totalBytes: 8 * GiB, availableBytes: 2 * GiB, usedBytes: 6 * GiB, usedPercent: 75, swap: { totalBytes: 2 * GiB, usedBytes: GiB, usedPercent: 50 } });
  assert.deepEqual(first.disks, [
    { id: 'data', label: '数据目录', totalBytes: 1000 * 4096, availableBytes: 300 * 4096, usedBytes: 600 * 4096, usedPercent: 66.7 },
    { id: 'root', label: '系统盘', totalBytes: 2000 * 4096, availableBytes: 1400 * 4096, usedBytes: 500 * 4096, usedPercent: 26.3 },
  ]);
  assert.equal(first.uptimeSeconds, 90061);
  assert.equal(JSON.stringify(first).includes('/data'), false);
  // Within a second the previous value stands and the counters are not consumed.
  advance(500); assert.equal((await host.read()).cpu.usagePercent, 50);
  advance(1000); assert.equal((await host.read()).cpu.usagePercent, 90);
});

test('host status merges the data directory into the system disk and keeps a failed disk visible', async () => {
  const same = fixture({ ticks: [[core(0, 10)]], disks: { '/data': fsInfo(10, 5, 5), '/': fsInfo(10, 5, 5) } });
  assert.deepEqual((await same.host.read()).disks.map(disk => disk.label), ['数据目录（系统盘）']);
  const broken = fixture({ ticks: [[core(0, 10)]], disks: { '/': fsInfo(10, 5, 5) }, meminfo: 'MemTotal: 1 kB\n' });
  const value = await broken.host.read();
  assert.deepEqual(value.disks[0], { id: 'data', label: '数据目录', error: '无法读取' });
  assert.equal(value.disks[1].label, '系统盘');
  assert.equal(value.memory.swap, null);
  assert.equal(value.cpu.usagePercent, null, 'idle counters with no change give no usage');
});

test('host status endpoint needs a same-origin session and is read-only', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'host-status-'));
  const app = await createApp({ dataDir, initialPassword: 'host-status-test-password', refreshInterval: 0, assetSyncIntervalMs: 0,
    tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, logger: { info() {}, warn() {}, error() {} },
    updatesClient: { status: async () => { throw new Error('host status must not request updater status'); } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`, route = origin + '/api/system/host';
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'host-status-test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
  assert.equal((await fetch(route)).status, 401);
  assert.equal((await fetch(route, { headers: { Cookie: cookie, Origin: 'https://wrong.example' } })).status, 403);
  assert.equal((await fetch(route + '?x=1', { headers: { Cookie: cookie } })).status, 400);
  assert.equal((await fetch(route, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken } })).status, 405);
  const response = await fetch(route, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.equal(value.schemaVersion, 1);
  assert.ok(value.memory.totalBytes > 0 && value.cpu.cores > 0);
  assert.equal(value.disks[0].id, 'data');
  assert.equal(JSON.stringify(value).includes(dataDir), false);
});
