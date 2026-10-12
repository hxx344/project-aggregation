import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, book, catalog, epoch } from './fixtures.mjs';
import { pairKey, validSignal, transferEligibility } from '../server/model.mjs';
import { opportunityStaleReason } from '../src/freshness.ts';

const evidence = (at = epoch) => ({ networks: ['BTC'], checkedAt: at, expiresAt: at + 180000 });
function qualified(at = epoch) {
  const value = feed(at);
  value.crossexFilter = { requireSpotTransfer: true, blockedBases: [], excluded: 0, revision: 1 };
  value.signals[0].spotTransfer = evidence(at);
  return value;
}
const withdrawn = at => ({ ...qualified(at), signals: [] });

test('transfer certificates are strict, bounded, and cannot be replaced by a recent BBO', () => {
  const value = qualified(), signal = value.signals[0];
  assert.equal(validSignal(signal, value, epoch), true);
  for (const proof of [undefined, null, {}, { ...evidence(), networks: [] }, { ...evidence(), networks: ['BTC', 'BTC'] },
    { ...evidence(), networks: ['   '] }, { ...evidence(), networks: ['BTC/ETH'] }, { ...evidence(), networks: [1] },
    evidence(epoch + 1), evidence(epoch - 180000), { ...evidence(), checkedAt: '1790000000000' },
    { ...evidence(), expiresAt: epoch + 180001 }, { ...evidence(), expiresAt: epoch + 5000 }]) {
    const bad = { ...signal, spotTransfer: proof };
    assert.equal(validSignal(bad, value, epoch), false, JSON.stringify(proof));
    assert.equal(transferEligibility(bad, value, epoch).state, 'blocked');
  }
  for (const policy of [null, {}, { requireSpotTransfer: 'false', blockedBases: [] }, { requireSpotTransfer: false, blockedBases: 'BTC' },
    { requireSpotTransfer: false, blockedBases: ['btc'] }, { requireSpotTransfer: false, blockedBases: ['BTC'], revision: 2 },
    { requireSpotTransfer: false, blockedBases: [], revision: -1 }]) assert.equal(validSignal(signal, { ...value, crossexFilter: policy }, epoch), false);
  const legacy = feed(); assert.equal(transferEligibility(legacy.signals[0], legacy, epoch).state, 'unverified');
  legacy.crossexFilter = { requireSpotTransfer: false, blockedBases: [] };
  assert.equal(validSignal(legacy.signals[0], legacy, epoch), true);
  assert.equal(transferEligibility(legacy.signals[0], legacy, epoch).state, 'disabled');
});

test('candidate ranking puts an eligible lower spread ahead of an ineligible high spread', async t => {
  const f = fixture(t), value = qualified(), other = structuredClone(value.signals[0]);
  other.base = 'ETH'; other.id = 'unverified-high-spread'; delete other.spotTransfer;
  for (const leg of ['long', 'short']) { other[leg].base = 'ETH'; other[leg].symbol = 'ETHUSDT'; }
  other.short.bid = 120; other.short.ask = 121; other.pairKey = pairKey(other);
  value.signals.unshift(other); value.quotes.push(other.long, other.short);
  f.setFeed(value); f.setCatalog([...catalog, ...catalog.map(rule => ({ ...rule, symbol: rule.symbol.replace('BTC', 'ETH') }))]);
  await f.engine.tick();
  const rows = f.engine.view().opportunities;
  assert.equal(rows[0].base, 'BTC'); assert.equal(rows[0].eligible, true); assert.equal(rows[0].transfer.state, 'verified');
  assert.equal(rows[1].eligible, false); assert.match(rows[1].reason, /证据/);
});

for (const change of ['withdrawn', 'blocked', 'enabled-without-proof', 'expired-proof', 'wrong-pair']) {
  test(`remembered signal rejects ${change} on the final source read, retaining quotes`, async t => {
    const f = fixture(t); await f.engine.tick(); f.advance(1000);
    const next = qualified(f.now());
    if (change === 'withdrawn') next.signals = [];
    if (change === 'blocked') next.crossexFilter.blockedBases = ['BTC'];
    if (change === 'enabled-without-proof') delete next.signals[0].spotTransfer;
    if (change === 'expired-proof') next.signals[0].spotTransfer = evidence(f.now() - 180000);
    if (change === 'wrong-pair') { [next.signals[0].long, next.signals[0].short] = [next.signals[0].short, next.signals[0].long]; next.signals[0].pairKey = pairKey(next.signals[0]); }
    f.setFeed(next); // No background refresh: opening itself must read the latest policy.
    await assert.rejects(f.engine.open(`signal-${epoch}`, `remembered-${change}`), /机会|屏蔽|证据/);
    assert.equal(f.store.positions().length, 0); assert.equal(f.engine.view().source.quoteCount, 2);
  });
}

for (const staged of [false, true]) test(`a policy withdrawal during depth stops ${staged ? 'staged creation' : 'atomic entry'}`, async t => {
  const f = fixture(t); f.setFeed(qualified());
  if (staged) await f.engine.settings({ config: { executionMode: 'staged' } });
  await f.engine.tick();
  f.setDepth(q => { f.setFeed(withdrawn(f.now())); return book(q, f.now()); });
  await assert.rejects(f.engine.open(`signal-${epoch}`, `depth-withdrawal-${staged}`), /资格变化.*撤回/);
  assert.equal(f.store.positions().length, 0); assert.equal(f.store.executions().length, 0);
});

test('a previously advertised policy cannot disappear across restart and authorize new entries', async t => {
  const f = fixture(t); f.setFeed(qualified()); await f.engine.tick(); await f.reopen();
  f.setFeed(feed()); await f.engine.tick();
  assert.equal(f.engine.view().source.state, 'live');
  await assert.rejects(f.engine.open(`signal-${epoch}`, 'missing-policy-after-restart'), /策略缺失/);
  const disabled = feed(); disabled.crossexFilter = { requireSpotTransfer: false, blockedBases: [], excluded: 0, revision: 2 };
  f.setFeed(disabled); assert.equal((await f.engine.open(`signal-${epoch}`, 'explicitly-disabled-policy')).status, 'open');
});

test('automatic entry cannot bypass missing transfer evidence', async t => {
  const f = fixture(t), next = qualified(); delete next.signals[0].spotTransfer; f.setFeed(next);
  await f.engine.settings({ config: { enabled: true } }); await f.engine.tick(); assert.equal(f.store.positions().length, 0);
});

async function staged(t, scenario = 'normal') {
  const f = fixture(t); f.setFeed(qualified());
  await f.engine.settings({ config: { executionMode: 'staged', executionScenario: scenario, executionDelayMs: 0 } }); await f.engine.tick();
  return { f, task: await f.engine.open(`signal-${epoch}`, 'qualified-staged-entry') };
}
async function step(f, value = qualified(f.now() + 1000)) { f.advance(1000); f.setFeed(value); await f.engine.tick(); }

test('staged entries renew current pair evidence beyond the original signal expiry', async t => {
  const { f, task } = await staged(t);
  for (let i = 0; i < 40; i++) await step(f);
  const completed = f.store.findExecution(task.id);
  assert.equal(completed.state, 'completed'); assert.ok(completed.fills.at(-1).at > epoch + 10000);
  assert.ok(f.store.findPosition(task.positionId).entryTransfer.checkedAt > epoch);
});

test('withdrawal during staged depth makes no new receipt, and retry still rechecks', async t => {
  const { f, task } = await staged(t);
  f.setDepth(q => { f.setFeed(withdrawn(f.now())); return book(q, f.now()); });
  await step(f);
  assert.equal(f.store.findExecution(task.id).orders.length, 0);
  for (let i = 0; i < 3; i++) await step(f, withdrawn(f.now() + 1000));
  assert.equal(f.store.findExecution(task.id).state, 'blocked');
  await f.engine.executionAction(task.id, 'retry', 'retry-withdrawn-entry'); await step(f, withdrawn(f.now() + 1000));
  assert.equal(f.store.findExecution(task.id).orders.length, 0);
});

test('unknown receipts reconcile exactly once after withdrawal and restart; cancel and close still work', async t => {
  const { f, task } = await staged(t, 'unknown-short');
  await step(f); await step(f); await step(f);
  assert.equal(f.store.findExecution(task.id).orders.at(-1).state, 'UNKNOWN');
  await f.reopen();
  await step(f, withdrawn(f.now() + 1000)); await step(f, withdrawn(f.now() + 1000));
  const reconciled = f.store.findExecution(task.id); assert.equal(reconciled.fills.length, 2);
  await step(f, withdrawn(f.now() + 1000)); assert.equal(f.store.findExecution(task.id).orders.length, 2);
  await f.engine.executionAction(task.id, 'cancel', 'cancel-withdrawn-task'); await step(f, withdrawn(f.now() + 1000));
  const cancelled = f.store.findExecution(task.id); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.fills.length, 2);
  assert.equal(f.engine.view().positions[0].valuation.stale, false);
  f.offline(true);
  const close = await f.engine.closePosition(task.positionId, 'exit-withdrawn-staged');
  for (let i = 0; i < 20; i++) { f.advance(1000); await f.engine.tick(); }
  assert.equal(f.store.findExecution(close.id).state, 'completed'); assert.equal(f.store.findPosition(task.positionId).status, 'closed');
});

test('entry pause blocks new staged receipts without blocking reconciliation', async t => {
  const { f, task } = await staged(t); await step(f);
  await f.engine.settings({ config: { entryPaused: true } }); await step(f); await step(f);
  const value = f.store.findExecution(task.id); assert.equal(value.fills.length, 1); assert.equal(value.orders.length, 1); assert.match(value.error, /新仓已暂停/);
});

test('browser clocks expire an individual signal and transfer certificate independently', () => {
  const row = { ...qualified().signals[0], transfer: transferEligibility(qualified().signals[0], qualified(), epoch) };
  assert.equal(opportunityStaleReason(row, epoch), '');
  assert.match(opportunityStaleReason(row, epoch + 10000), /机会已到期/);
  assert.match(opportunityStaleReason({ ...row, transfer: { ...row.transfer, expiresAt: epoch } }, epoch), /充提证据已到期/);
});
