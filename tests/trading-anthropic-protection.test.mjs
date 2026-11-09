import test from 'node:test';
import assert from 'node:assert/strict';
import { positionProtection } from '../server/trading-anthropic-protection.mjs';

const NOW = Date.parse('2026-11-09T08:00:00Z'), iso = time => new Date(time).toISOString();
const ADDRESS = '0x' + 'a'.repeat(40), OTHER = '0x' + 'b'.repeat(40);
function fixture(exchange = 'rh-lighter') {
  const position = { exchange, symbol: exchange === 'rh-lighter' ? 'ANTHROPIC' : exchange === 'hyperliquid' ? 'io:ANTH' : 'ANTHROPICUSDT', side: 'long', quantity: '10', markPrice: '100', liquidationPrice: '50', marginMode: 'cross', ...(exchange === 'rh-lighter' ? { account: 11 } : {}) };
  const identity = ['okx', 'binance'].includes(exchange) ? '42' : ADDRESS;
  const accountMode = { binance: 'standard', okx: 'cross', hyperliquid: 'agent', 'rh-lighter': 'api-key' }[exchange];
  return { now: NOW, staleMs: 75_000, position,
    source: { exchange, origin: 'execution', connected: true, state: 'live', fetchedAt: iso(NOW - 1000), error: null,
      executionBinding: { revision: 2, identity, accountMode, accountIndex: exchange === 'rh-lighter' ? 11 : null }, positions: [position] },
    alerts: { config: { enabled: true }, channel: { configured: true, error: null }, error: null },
    reduction: { available: true, maintenance: false, config: { enabled: true, legs: [{ exchange, symbol: position.symbol, side: position.side }] },
      connections: [{ exchange, connected: true, revision: 2, identity, accountMode, keyLabel: '11#4', locked: false }],
      bindings: { [exchange]: { revision: 2, identity } }, state: { phase: 'armed', reason: null },
      live: { checkedAt: iso(NOW), validUntil: iso(NOW + 9000), legs: [{ exchange, symbol: position.symbol, side: position.side, quantity: '10.0' }] } },
  };
}

test('coverage requires a proven account, exact native contract and side, including Lighter subaccounts', () => {
  for (const exchange of ['binance', 'okx', 'hyperliquid', 'rh-lighter']) {
    const f = fixture(exchange), before = structuredClone(f), value = positionProtection(f);
    assert.equal(value.reduction.state, 'ready', exchange); assert.equal(value.alert.state, 'ready');
    assert.deepEqual(f, before, 'projection does not mutate snapshots or rule state');
    f.position.side = 'short'; assert.equal(positionProtection(f).reduction.state, 'unconfigured');
    f.position.side = 'long'; f.position.symbol = 'xyz:ANT'; assert.equal(positionProtection(f).reduction.state, 'unconfigured');
  }
  const rh = fixture(); rh.position.account = 12;
  assert.equal(positionProtection(rh).reduction.state, 'unmatched');
  rh.position.account = 11; rh.source.executionBinding.identity = OTHER;
  assert.equal(positionProtection(rh).reduction.state, 'unmatched');
  rh.source.executionBinding.identity = ADDRESS;
  for (const label of [null, 'free-label', '11#157', '11#0', '0#4', '9007199254740993#4']) {
    rh.reduction.connections[0].keyLabel = label; assert.equal(positionProtection(rh).reduction.state, 'unknown');
  }
});

test('execution UID, connection generation and account scope are checked for both CEX venues', () => {
  const f = fixture('okx'); f.source.executionBinding.identity = '43';
  assert.equal(positionProtection(f).reduction.state, 'unmatched');
  f.source.executionBinding.identity = null; assert.equal(positionProtection(f).reduction.state, 'unknown');
  f.source.executionBinding.identity = '42'; f.position.marginMode = 'isolated';
  assert.equal(positionProtection(f).reduction.state, 'unmatched');
  f.position.marginMode = 'cross'; f.source.positions.push({ ...f.position, marginMode: 'isolated' });
  assert.equal(positionProtection(f).reduction.state, 'unknown', 'same-direction cross and isolated holdings cannot be silently combined');
  const binance = fixture('binance'); assert.equal(positionProtection(binance).reduction.state, 'ready');
  binance.source.executionBinding.identity = null;
  assert.equal(positionProtection(binance).reduction.state, 'unknown'); assert.match(positionProtection(binance).reduction.reason, /UID/);
  binance.source.executionBinding.identity = '42'; binance.source.executionBinding.accountMode = 'portfolio-margin';
  assert.equal(positionProtection(binance).reduction.state, 'unknown');
  binance.source.executionBinding.accountMode = 'standard'; binance.source.executionBinding.revision++;
  assert.equal(positionProtection(binance).reduction.state, 'unknown');
  binance.source.executionBinding.revision--; delete binance.source.executionBinding;
  assert.equal(positionProtection(binance).reduction.state, 'unknown', 'a source label alone cannot prove account ownership');
});

test('normal polling gaps report bounded monitoring without extending executable evidence', () => {
  const f = fixture('binance'); f.reduction.monitorUntil = iso(NOW + 60_000);
  const live = structuredClone(f.reduction.live), ready = positionProtection(f).reduction;
  assert.equal(ready.state, 'ready'); assert.equal(ready.validUntil, live.validUntil); assert.equal(ready.monitorUntil, iso(NOW + 60_000));
  f.now = NOW + 10_000; assert.equal(positionProtection(f).reduction.state, 'monitoring');
  assert.deepEqual(f.reduction.live, live, 'a display state never renews the original risk or book timestamps');
  f.reduction.state.reason = '读取失败'; assert.equal(positionProtection(f).reduction.state, 'blocked');
  f.reduction.state.reason = null; f.now = NOW + 60_000; assert.equal(positionProtection(f).reduction.state, 'stale');
  f.reduction.monitorUntil = iso(NOW + 120_000); f.now = NOW + 75_000;
  assert.equal(positionProtection(f).reduction.state, 'blocked', 'stale source positions still revoke monitoring coverage');
});

test('enabled configuration cannot hide account changes, maintenance, quantity errors, warnings or unfinished tasks', () => {
  for (const [change, state, reason] of [
    [f => { f.reduction.connections[0].revision++; }, 'unknown', /下单连接已变化/],
    [f => { f.reduction.connections[0].connected = false; }, 'unknown', /连接/],
    [f => { f.reduction.available = false; }, 'unknown', /运行资格/],
    [f => { f.reduction.maintenance = true; }, 'blocked', /维护/],
    [f => { f.reduction.connections[0].writeProtection = { identityVerified: false }; }, 'blocked', /写入保护/],
    [f => { f.reduction.state.reason = '批次过多，至少一批数量小于合约步长'; f.reduction.live = null; }, 'blocked', /批次过多/],
    [f => { f.reduction.live.warning = '存在其它活动委托'; }, 'blocked', /活动委托/],
    [f => { f.reduction.live.warning = '最低名义金额豁免未确认'; }, 'blocked', /豁免/],
    [f => { f.reduction.locked = true; }, 'blocked', /未结束/],
    [f => { f.position.liquidationKnown = false; }, 'blocked', /强平价缺失或无效/],
    [f => { f.reduction.live = null; }, 'pending', /等待/],
    [f => { f.reduction.live.legs[0].quantity = '9'; }, 'pending', /数量/],
    [f => { f.reduction.config.enabled = false; f.reduction.bindings = null; }, 'disabled', /未启用/],
    [f => { f.reduction.state.phase = 'review'; f.reduction.job = { status: 'attention' }; }, 'blocked', /执行状态/],
    [f => { f.reduction.state.phase = 'reducing'; f.reduction.job = { status: 'running' }; }, 'running', /批次/],
  ]) {
    const f = fixture(); change(f); const value = positionProtection(f).reduction;
    assert.equal(value.state, state); assert.match(value.reason, reason);
  }
});

test('the other rule leg must retain its account binding and write protection too', () => {
  const f = fixture();
  f.reduction.config.legs.push({ exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short' });
  const other = { exchange: 'binance', connected: true, revision: 3, identity: '42' };
  f.reduction.connections.push(other); f.reduction.bindings.binance = { revision: 3, identity: '42' };
  assert.equal(positionProtection(f).reduction.state, 'ready');
  other.revision = 4; assert.equal(positionProtection(f).reduction.state, 'unknown');
  other.revision = 3; other.connected = false; assert.equal(positionProtection(f).reduction.state, 'unknown');
  other.connected = true; other.writeProtection = { identityVerified: true, reason: 'unresolved' };
  assert.equal(positionProtection(f).reduction.state, 'blocked');
});

test('risk, quotes and source clocks expire independently; failed reads preserve the original evidence time', () => {
  const f = fixture(), original = f.source.fetchedAt;
  f.now += 9000; assert.equal(positionProtection(f).reduction.state, 'stale');
  assert.equal(positionProtection(f).alert.state, 'ready');
  f.source.state = 'stale'; f.source.error = '读取失败';
  const value = positionProtection(f); assert.equal(value.alert.state, 'blocked'); assert.equal(value.alert.checkedAt, original);
  assert.equal(value.reduction.state, 'blocked'); assert.equal(value.reduction.checkedAt, iso(NOW));
  for (const patch of [{ markPrice: null }, { liquidationPrice: null }, { markPrice: '0' }, { riskFetchedAt: iso(NOW - 75_001) }, { riskFetchedAt: iso(NOW + 1001) }]) {
    const next = fixture(); Object.assign(next.position, patch); assert.equal(positionProtection(next).alert.state, 'blocked'); assert.equal(positionProtection(next).reduction.state, 'blocked');
  }
  const future = fixture(); future.source.fetchedAt = iso(NOW + 2000); assert.equal(positionProtection(future).alert.state, 'blocked');
});

test('alert configuration and failures remain independent of automatic reduction', () => {
  const f = fixture(); f.alerts.config.enabled = false;
  assert.equal(positionProtection(f).alert.state, 'disabled'); assert.equal(positionProtection(f).reduction.state, 'ready');
  f.alerts.config.enabled = true; f.alerts.channel.configured = false;
  assert.equal(positionProtection(f).alert.state, 'blocked');
  f.alerts.channel.configured = true; f.alerts.error = '预警状态无法保存';
  assert.equal(positionProtection(f).alert.state, 'blocked');
  f.reduction = null; assert.equal(positionProtection(f).reduction.state, 'unknown');
});
