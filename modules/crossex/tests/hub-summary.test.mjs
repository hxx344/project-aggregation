import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, epoch } from './fixtures.mjs';
import { getJson } from '../server/clients.mjs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

test('light summary distinguishes absent, stale, partial quotes and directory failure', async t => {
  const f = fixture(t);
  assert.equal(f.engine.summary().health.state, 'offline'); assert.equal(f.engine.summary().updatedAt, null);
  await f.engine.tick(); assert.equal(f.engine.summary().health.state, 'online');
  const mixed = feed(epoch); mixed.quotes[0].bidAskAt = epoch - 12000; mixed.signals = [];
  f.setFeed(mixed); await f.engine.tick();
  const partial = f.engine.summary(); assert.equal(partial.health.state, 'partial'); assert.match(partial.health.message, /盘口过期/);
  assert.equal(partial.updatedAt, new Date(epoch).toISOString()); assert.equal(partial.health.staleAfterSeconds, 10);
  f.advance(11000); assert.equal(f.engine.summary().health.state, 'stale');
  f.offline(true); await f.engine.tick(); assert.equal(f.engine.summary().health.state, 'offline');
  f.offline(false); f.advance(900001); f.setFeed(feed(f.now())); f.setCatalog([]); await f.engine.tick();
  assert.equal(f.engine.summary().health.state, 'partial'); assert.match(f.engine.summary().health.message, /目录/);
});

test('summary never reads closed rows; history is optional and unchanged versions omit its payload', async t => {
  const f = fixture(t); await f.engine.tick();
  const full = f.engine.view(), light = f.engine.view({ includeHistory: false });
  assert.equal(typeof full.historyVersion, 'string'); assert.equal(light.history, undefined); assert.equal(light.events, undefined);
  const unchanged = f.engine.view({ historyVersion: full.historyVersion }); assert.equal(unchanged.history, undefined); assert.equal(unchanged.events, undefined);
  f.store.event(f.now(), 'test change'); const changed = f.engine.view({ historyVersion: full.historyVersion }); assert.equal(changed.events[0].message, 'test change');
  const original = f.store.positions; f.store.positions = status => { assert.equal(status, 'open'); return original(status); };
  assert.equal(f.engine.summary().metrics.find(item => item.key === 'positions').value, 0); f.store.positions = original;
  await f.reopen(); assert.notEqual(f.engine.view().historyVersion, full.historyVersion);
});

test('gzip response byte limits apply to decoded JSON, not the smaller compressed payload', async t => {
  const value = { quotes: 'x'.repeat(10000) }, bytes = gzipSync(JSON.stringify(value));
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); res.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.ok(bytes.length < 1024); await assert.rejects(getJson(url, { maxBytes: 1024 }), /过大/);
  assert.deepEqual(await getJson(url, { maxBytes: 20000 }), value);
});
