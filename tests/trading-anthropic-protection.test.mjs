import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { positionProtection } from '../server/trading-anthropic-protection.mjs';

const NOW = Date.parse('2026-11-09T08:00:00Z'), iso = time => new Date(time).toISOString();
const ADDRESS = '0x' + 'a'.repeat(40), OTHER = '0x' + 'b'.repeat(40);
const proof = uid => createHash('sha256').update(`okx:${uid}`).digest('hex');
function fixture(exchange = 'rh-lighter') {
  const position = { exchange, symbol: exchange === 'rh-lighter' ? 'ANTHROPIC' : exchange === 'hyperliquid' ? 'io:ANTH' : 'ANTHROPICUSDT', side: 'long', quantity: '10', markPrice: '100', liquidationPrice: '50', marginMode: 'cross', ...(exchange === 'rh-lighter' ? { account: 11 } : {}) };
  const identity = ['okx', 'binance'].includes(exchange) ? '42' : ADDRESS;
  return { now: NOW, staleMs: 75_000, position,
    source: { exchange, connected: true, state: 'live', fetchedAt: iso(NOW - 1000), error: null, address: ADDRESS, accountIdentity: exchange === 'okx' ? proof(identity) : null, positions: [position] },
    alerts: { config: { enabled: true }, channel: { configured: true, error: null }, error: null },
    reduction: { available: true, maintenance: false, config: { enabled: true, legs: [{ exchange, symbol: position.symbol, side: position.side }] },
      connections: [{ exchange, connected: true, revision: 2, identity, accountMode: 'cross', keyLabel: '11#4', locked: false }],
      bindings: { [exchange]: { revision: 2, identity } }, state: { phase: 'armed', reason: null },
      live: { checkedAt: iso(NOW), validUntil: iso(NOW + 9000), legs: [{ exchange, symbol: position.symbol, side: position.side, quantity: '10.0' }] } },
  };
}

test('coverage requires a proven account, exact native contract and side, including Lighter subaccounts', () => {
  for (const exchange of ['okx', 'hyperliquid', 'rh-lighter']) {
    const f = fixture(exchange), before = structuredClone(f), value = positionProtection(f);
    assert.equal(value.reduction.state, 'ready', exchange); assert.equal(value.alert.state, 'ready');
    assert.deepEqual(f, before, 'projection does not mutate snapshots or rule state');
    f.position.side = 'short'; assert.equal(positionProtection(f).reduction.state, 'unconfigured');
    f.position.side = 'long'; f.position.symbol = 'xyz:ANT'; assert.equal(positionProtection(f).reduction.state, 'unconfigured');
  }
  const rh = fixture(); rh.position.account = 12;
  assert.equal(positionProtection(rh).reduction.state, 'unmatched');
  rh.position.account = 11; rh.source.address = OTHER;
  assert.equal(positionProtection(rh).reduction.state, 'unmatched');
  rh.source.address = ADDRESS;
  for (const label of [null, 'free-label', '11#157', '11#0', '0#4', '9007199254740993#4']) {
    rh.reduction.connections[0].keyLabel = label; assert.equal(positionProtection(rh).reduction.state, 'unknown');
  }
});

test('OKX UID and margin scope are checked, while absent Binance UID is explicitly unknown', () => {
  const f = fixture('okx'); f.source.accountIdentity = proof('43');
  assert.equal(positionProtection(f).reduction.state, 'unmatched');
  f.source.accountIdentity = null; assert.equal(positionProtection(f).reduction.state, 'unknown');
  f.source.accountIdentity = proof('42'); f.position.marginMode = 'isolated';
  assert.equal(positionProtection(f).reduction.state, 'unmatched');
  f.position.marginMode = 'cross'; f.source.positions.push({ ...f.position, marginMode: 'isolated' });
  assert.equal(positionProtection(f).reduction.state, 'unknown', 'same-direction cross and isolated holdings cannot be silently combined');
  const binance = fixture('binance'); assert.equal(positionProtection(binance).reduction.state, 'unknown');
  assert.match(positionProtection(binance).reduction.reason, /UID/);
});

test('enabled configuration cannot hide account changes, maintenance, quantity errors, warnings or unfinished tasks', () => {
  for (const [change, state, reason] of [
    [f => { f.reduction.connections[0].revision++; }, 'unknown', /绑定/],
    [f => { f.reduction.connections[0].connected = false; }, 'unknown', /连接/],
    [f => { f.reduction.available = false; }, 'unknown', /运行资格/],
    [f => { f.reduction.maintenance = true; }, 'blocked', /维护/],
    [f => { f.reduction.connections[0].writeProtection = { identityVerified: false }; }, 'blocked', /写入保护/],
    [f => { f.reduction.state.reason = '批次过多，至少一批数量小于合约步长'; f.reduction.live = null; }, 'blocked', /批次过多/],
    [f => { f.reduction.live.warning = '存在其它活动委托'; }, 'blocked', /活动委托/],
    [f => { f.reduction.live.warning = '最低名义金额豁免未确认'; }, 'blocked', /豁免/],
    [f => { f.reduction.locked = true; }, 'blocked', /未结束/],
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
