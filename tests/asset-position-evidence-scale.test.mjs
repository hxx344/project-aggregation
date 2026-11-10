import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../modules/asset/lib/sqlite.ts';
import { createPositionsService } from '../modules/asset/lib/hub-positions.ts';
import { position } from '../modules/asset/lib/positions-values.ts';
import { summarizeCycle } from '../modules/asset/lib/positions-cycle.ts';
import { boundPositionEvidence, POSITION_EVIDENCE_ROWS, POSITION_EVIDENCE_BYTES, POSITION_RESPONSE_TARGET_BYTES } from '../modules/asset/lib/positions-evidence.ts';
import { createAssetPositions, normalizeAssetPositions } from '../server/asset-positions.mjs';

const at = Date.parse('2026-11-10T00:00:00Z'), iso = value => new Date(value).toISOString();
const allPositions = report => report.exchanges.flatMap(exchange => exchange.accounts.flatMap(account => account.scopes.flatMap(scope => scope.positions)));
const byteLength = value => Buffer.byteLength(JSON.stringify(value));
function fullCycle(count = 200) {
  return summarizeCycle({ current: String(count), currency: 'USDT', complete: true, openingFraction: null, since: at - 3600000,
    fundingAttributable: true, notes: [], updatedAt: iso(at), cash: [],
    fills: Array.from({ length: count }, (_, index) => ({ id: String(index), time: at - 3600000 + index, side: 'buy', quantity: '1', price: '100', realizedPnl: '0', fee: '-0.01', feeCurrency: 'USDT' })) });
}
function report(positions) {
  return { schemaVersion: 1, generatedAt: iso(at), exchanges: [{ id: 'okx', name: 'OKX', accounts: [{ id: 'default', name: '账户', configured: true, revision: 'a'.repeat(64), scopes: [
    { id: 'SWAP', label: '永续', status: 'live', refreshing: false, fetchedAt: iso(at), error: null, positions },
  ] }] }] };
}

test('real Asset read of 50 positions x 200 cycle rows stays within the unchanged Hub HTTP transport limit', async t => {
  const database = openDatabase(':memory:', fileURLToPath(new URL('../modules/asset/drizzle', import.meta.url)));
  t.after(() => database.close());
  await database.prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?)').bind('owner', 'okx', 'fixture-encrypted', iso(at)).run();
  const cycles = new Map(), positions = Array.from({ length: 50 }, (_, index) => ({ ...position(`TOKEN${index}-USDT-SWAP`, 'long', '200', '张'), pnlCurrency: 'USDT' }));
  const service = createPositionsService({ now: () => at, read: async (_credentials, scope) => scope === 'SWAP' ? positions : [],
    cycle: async (_credentials, _scope, request) => { const cycle = fullCycle(); cycles.set(request.position.id, cycle); return cycle; } });
  const unseal = async () => ({ exchange: 'okx', apiKey: 'fixture-key', apiSecret: 'fixture-secret', passphrase: 'fixture-pass' });
  await service.read(database, 'owner', unseal); await service.idle();
  const bounded = await service.read(database, 'owner', unseal), boundedPositions = allPositions(bounded);
  assert.equal(boundedPositions.length, 50);
  assert.ok(boundedPositions.every(item => item.cycle.evidence.rows.length === 20 && item.cycle.evidence.totalRows === 200 && item.cycle.evidence.truncated));
  assert.ok([...cycles.values()].every(cycle => cycle.evidence.rows.length === 200 && cycle.evidence.truncated === false), 'projection does not trim cached summaries');
  assert.equal(boundedPositions.reduce((sum, item) => sum + item.cycle.evidence.rows.length, 0), POSITION_EVIDENCE_ROWS);
  const unbounded = structuredClone(bounded);
  for (const item of allPositions(unbounded)) item.cycle = cycles.get(item.id);
  const oldBytes = byteLength(unbounded), newBytes = byteLength(bounded);
  assert.ok(oldBytes > 2 * 1024 * 1024); assert.ok(newBytes < POSITION_RESPONSE_TARGET_BYTES);
  assert.equal(allPositions(normalizeAssetPositions(unbounded, at)).length, 50, 'the original failure was transport size, not malformed rows');
  let payload = unbounded, requests = 0;
  const server = http.createServer((request, response) => { assert.equal(request.url, '/api/hub/positions'); requests++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const target = { project: { id: 'asset', name: 'Asset', enabled: true, adapter: 'asset', embedded: true, apiUrl: `http://127.0.0.1:${server.address().port}` }, revision: 'same' };
  const reader = createAssetPositions({ listTargets: () => [target], now: () => at, cacheMs: 0 });
  t.after(() => reader.close());
  const oversized = await reader.state(); assert.equal(oversized.sources[0].status, 'unavailable'); assert.equal(oversized.sources[0].data, null);
  payload = bounded;
  const result = await reader.state(); assert.equal(result.sources[0].status, 'ready'); assert.equal(allPositions(result.sources[0].data).length, 50);
  assert.ok(allPositions(result.sources[0].data).every(item => item.cycle.fees === '-2' && item.cycle.evidence.totalRows === 200));
  assert.equal(requests, 2);
  t.diagnostic(`same 50x200 input: unbounded=${oldBytes} bytes; bounded=${newBytes} bytes; returned rows=${POSITION_EVIDENCE_ROWS}`);
});

test('single-position and flip evidence retain every row and amount; UTF-8 metadata/rows share the global byte budget', () => {
  const cycle = fullCycle(), single = report([{ ...position('CL-USDT-SWAP', 'long', '200', '张'), cycle }]);
  assert.deepEqual(boundPositionEvidence(single), single);
  const flip = summarizeCycle({ current: '2', currency: 'USDT', complete: true, openingFraction: '0.6', since: at - 2000, fundingAttributable: true, notes: [], updatedAt: iso(at), cash: [],
    fills: [{ id: 'close', time: at - 1000, side: 'sell', quantity: '1', price: '110', realizedPnl: '5', fee: '-0.1', feeCurrency: 'USDT' },
      { id: 'flip', time: at - 2000, side: 'buy', quantity: '5', price: '100', realizedPnl: '-7', fee: '-1', feeCurrency: 'USDT' }] });
  const flipped = report([{ ...position('CL-USDT-SWAP', 'long', '2', '张'), cycle: flip }]);
  assert.deepEqual(boundPositionEvidence(flipped), flipped); assert.equal(flip.evidence.rows[0].closingQuantity, '0'); assert.equal(flip.evidence.rows[1].closingQuantity, '1');
  const wide = { ...cycle, evidence: { ...cycle.evidence, rows: cycle.evidence.rows.map(row => ({ ...row, id: '证'.repeat(190), reason: '因'.repeat(290) })) } };
  const many = report(Array.from({ length: 50 }, (_, index) => ({ ...position(`TOKEN${index}-USDT-SWAP`, 'long', '200', '张'), cycle: wide })));
  const overview = structuredClone(many); for (const item of allPositions(overview)) delete item.cycle.evidence;
  const bounded = boundPositionEvidence(many);
  assert.ok(byteLength(bounded) - byteLength(overview) <= POSITION_EVIDENCE_BYTES);
  assert.ok(allPositions(bounded).reduce((sum, item) => sum + (item.cycle.evidence?.rows.length ?? 0), 0) < POSITION_EVIDENCE_ROWS, 'UTF-8 bytes may truncate before the row limit');
  assert.ok(allPositions(bounded).every(item => item.cycle.evidence?.totalRows === 200 && item.cycle.evidence.truncated));
  const largeOverview = report(Array.from({ length: 2000 }, (_, index) => ({ ...position(`TOKEN${index}-USDT-SWAP`, 'long', '200', '张'), cycle: { ...cycle, note: 'N'.repeat(300) } })));
  const overviewOnly = { ...largeOverview, exchanges: largeOverview.exchanges.map(exchange => ({ ...exchange, accounts: exchange.accounts.map(account => ({ ...account,
    scopes: account.scopes.map(scope => ({ ...scope, positions: scope.positions.map(item => { const { evidence: _evidence, ...summary } = item.cycle; return { ...item, cycle: summary }; }) })),
  })) })) };
  const largeBounded = boundPositionEvidence(largeOverview);
  assert.equal(allPositions(largeBounded).length, 2000); assert.ok(byteLength(largeBounded) <= Math.max(POSITION_RESPONSE_TARGET_BYTES, byteLength(overviewOnly)), 'optional evidence never pushes an overview past its remaining transport budget');
  assert.ok(allPositions(largeBounded).every(item => item.cycle.net === cycle.net && item.cycle.note === 'N'.repeat(300)), 'overview and financial caveats take priority');
});
