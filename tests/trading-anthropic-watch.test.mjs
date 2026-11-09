import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnthropicWatch, liquidationDistance, parseHyperliquidState, parseRhLighterAccounts, validateAlertConfig } from '../server/trading-anthropic-watch.mjs';

const ADDRESS = '0x' + 'a'.repeat(40);
const quiet = { warn() {} };
const hlPosition = (coin, szi, liquidationPx, positionValue = '1000') => ({ type: 'oneWay', position: { coin, szi, entryPx: '100', positionValue, unrealizedPnl: '0', liquidationPx, leverage: { type: 'isolated', value: 3 }, marginUsed: '333' } });

function harness({ cex = [], configured = true, readProtection = () => null } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'anthropic-watch-'));
  let time = Date.parse('2026-11-06T00:00:00Z');
  const books = { io: [], xyz: [] }, posts = [], cards = [], requests = [], ownPosts = [], rhRequests = [];
  let postFailure = null, hlFailure = null, rhFailure = null, gate = null, address = ADDRESS, rhAddress = null;
  const fetcher = async (url, init) => {
    if (String(url).startsWith('https://api.rh.lighter.xyz/')) {
      rhRequests.push(String(url));
      if (rhFailure) return rhFailure();
      return new Response(JSON.stringify({ code: 200, total: h.rhAccounts.length, accounts: h.rhAccounts }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    if (String(url).startsWith('https://open.feishu.cn/') && h.ownFail) return h.ownFail();
    if (String(url).startsWith('https://open.feishu.cn/')) { ownPosts.push({ url, text: body.card.elements[0].text.content, signed: !!body.sign }); return new Response(JSON.stringify({ code: 0 }), { status: 200 }); }
    requests.push(body);
    if (hlFailure) return hlFailure();
    return new Response(JSON.stringify({ assetPositions: books[body.dex] }), { status: 200 });
  };
  const feishu = {
    alertChannel: () => ({ configured: h.digest, title: '工作台汇总' }),
    async postAlert(card) { if (gate) await gate; if (postFailure) throw postFailure; posts.push(card.elements[0].text.content); cards.push(card); },
  };
  const source = { value: cex };
  const create = () => {
    const watch = createAnthropicWatch({ dataDir, readCex: () => source.value, readAddress: exchange => exchange === 'hyperliquid' ? address : exchange === 'rh-lighter' ? rhAddress : null, readProtection, feishu, encrypt: value => ({ sealed: JSON.stringify(value) }), decrypt: value => JSON.parse(value.sealed), log: quiet, fetcher, now: () => time, intervalMs: 0 });
    watch.initialize(); return watch;
  };
  const h = { digest: configured, books, posts, cards, ownPosts, requests, source, dataDir, advance: ms => { time += ms; }, now: () => time, fail: error => { postFailure = error; },
    hlFail: make => { hlFailure = make; }, hold: promise => { gate = promise; }, setAddress: value => { address = value; },
    rhAccounts: [], rhRequests, rhFail: make => { rhFailure = make; }, setRhAddress: value => { rhAddress = value; },
    restart: async () => { await h.watch.close(); h.watch = create(); },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
  h.watch = create();
  return h;
}

test('Hyperliquid state keeps only the Anthropic coin of its dex and reads short size and liquidation price', () => {
  const rows = parseHyperliquidState({ assetPositions: [hlPosition('io:ANTH', '-10', '120'), hlPosition('xyz:ANT', '5', '50'), hlPosition('BTC', '1', '1')] }, 'io');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].side, rows[0].quantity, rows[0].markPrice, rows[0].liquidationPrice, rows[0].marginMode], ['hyperliquid:io:ANTH:short', 'short', '10', '100', '120', 'isolated']);
  assert.equal(parseHyperliquidState({ assetPositions: [hlPosition('io:ANTH', '1', null)] }, 'io')[0].liquidationPrice, null);
  assert.throws(() => parseHyperliquidState({ assetPositions: [hlPosition('io:ANTH', '1', '1'), hlPosition('io:ANTH', '2', '1')] }, 'io'));
});

test('distance to liquidation is measured from the mark against the position side', () => {
  assert.equal(liquidationDistance({ side: 'long', markPrice: '100', liquidationPrice: '80' }), 20);
  assert.equal(liquidationDistance({ side: 'short', markPrice: '100', liquidationPrice: '110' }), 10);
  assert.ok(liquidationDistance({ side: 'short', markPrice: '100', liquidationPrice: '95' }) < 0);
  assert.equal(liquidationDistance({ side: 'long', markPrice: '100', liquidationPrice: null }), null);
});

test('a failed protection projection preserves positions and alert evidence without disclosing the account proof', () => {
  const h = harness({ readProtection: () => { throw new Error('unreadable rule'); } });
  try {
    h.source.value = [{ exchange: 'okx', connected: true, state: 'live', fetchedAt: new Date(h.now()).toISOString(), error: null, accountIdentity: 'a'.repeat(64),
      positions: [{ id: 'okx:fixture', exchange: 'okx', symbol: 'ANTHROPICUSDT', side: 'long', quantity: '10', markPrice: '100', liquidationPrice: '50' }] }];
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    const state = h.watch.state(), row = state.sources[0].positions[0];
    assert.equal(row.quantity, '10'); assert.equal(row.protection.alert.state, 'ready'); assert.equal(row.protection.reduction.state, 'unknown');
    assert.equal(JSON.stringify(state).includes('a'.repeat(64)), false); assert.equal(JSON.stringify(state).includes('accountIdentity'), false);
    assert.equal(h.requests.length + h.rhRequests.length + h.posts.length + h.ownPosts.length, 0);
  } finally { h.cleanup(); }
});

test('alert config is bounded and enabling needs the Feishu robot', () => {
  assert.throws(() => validateAlertConfig({ enabled: true, thresholdPercent: 0.5, repeatMinutes: 30 }));
  assert.throws(() => validateAlertConfig({ enabled: true, thresholdPercent: 20, repeatMinutes: 1 }));
  assert.throws(() => validateAlertConfig({ enabled: true, thresholdPercent: 20, repeatMinutes: 30, extra: 1 }));
  const h = harness({ configured: false });
  try { assert.throws(() => h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 }), { status: 409 }); }
  finally { h.cleanup(); }
});

test('alerts once below the threshold, repeats after the interval, clears above the hysteresis and reports a vanished leg', async () => {
  const h = harness();
  try {
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.books.io = [hlPosition('io:ANTH', '-10', '130')];
    await h.watch.poll();
    assert.deepEqual(h.requests.map(body => [body.type, body.user, body.dex]).sort(), [['clearinghouseState', ADDRESS, 'io'], ['clearinghouseState', ADDRESS, 'xyz']]);
    assert.equal(h.posts.length, 0, 'distance 30% is above the threshold');

    h.books.io = [hlPosition('io:ANTH', '-10', '115')];
    await h.watch.poll();
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0], /Hyperliquid io:ANTH 做空：距强平 15\.00%（阈值 20%）/);
    assert.equal(h.watch.state().sources.find(source => source.exchange === 'hyperliquid').positions[0].alerting, true);

    h.advance(29 * 60_000); await h.watch.poll();
    assert.equal(h.posts.length, 1, 'no repeat inside the interval');
    h.advance(60_000); await h.watch.poll();
    assert.equal(h.posts.length, 2); assert.match(h.posts[1], /仍距强平/);

    h.books.io = [hlPosition('io:ANTH', '-10', '121')];
    await h.watch.poll();
    assert.equal(h.posts.length, 2, '21% is inside the hysteresis band and keeps the alert');
    h.books.io = [hlPosition('io:ANTH', '-10', '125')];
    await h.watch.poll();
    assert.equal(h.posts.length, 3); assert.match(h.posts[2], /解除预警/);

    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    await h.watch.poll();
    h.books.io = [];
    await h.watch.poll();
    assert.equal(h.posts.length, 5); assert.match(h.posts[4], /仓位已不在账户中/);
  } finally { h.cleanup(); }
});

test('read-only legs alert on stale monitoring and on recovery', async () => {
  const position = { id: 'okx:ANTHROPICUSDT:one-way:short:cross', exchange: 'okx', symbol: 'ANTHROPICUSDT', side: 'short', quantity: '3', quantityUnit: '张', contractSize: '1',
    entryPrice: '100', markPrice: '100', notional: '300', unrealizedPnl: '0', leverage: '2', marginMode: 'cross', liquidationPrice: '150' };
  const h = harness();
  try {
    const at = () => new Date(h.now()).toISOString();
    h.source.value = [{ exchange: 'okx', connected: true, state: 'live', fetchedAt: at(), error: null, positions: [position] }];
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    await h.watch.poll();
    assert.equal(h.posts.length, 0);
    const lastRead = at();
    h.advance(120_000);
    h.source.value = [{ exchange: 'okx', connected: true, state: 'stale', fetchedAt: lastRead, error: '交易所读取超时', positions: [position] }];
    await h.watch.poll();
    assert.equal(h.posts.length, 0, 'two minutes is still inside the stale window');
    h.advance(120_000); await h.watch.poll();
    assert.equal(h.posts.length, 1); assert.match(h.posts[0], /OKX：仓位读取已中断 4 分钟/);
    h.advance(60_000); await h.watch.poll();
    assert.equal(h.posts.length, 1, 'one interruption notice');
    h.source.value = [{ exchange: 'okx', connected: true, state: 'live', fetchedAt: at(), error: null, positions: [position] }];
    await h.watch.poll();
    assert.equal(h.posts.length, 2); assert.match(h.posts[1], /OKX：仓位读取已恢复/);
  } finally { h.cleanup(); }
});

test('Binance quantity events cannot renew risk freshness or clear an active liquidation warning', async () => {
  const h = harness();
  try {
    const at = () => new Date(h.now()).toISOString();
    const position = { id: 'binance:ANTHROPICUSDT:one-way:short', exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short', quantity: '3',
      entryPrice: '100', markPrice: '100', liquidationPrice: '110', riskFetchedAt: at() };
    h.source.value = [{ exchange: 'binance', connected: true, state: 'live', fetchedAt: at(), error: null, positions: [position] }];
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    await h.watch.poll(); assert.equal(h.posts.length, 1); assert.match(h.posts[0], /距强平 10.00%/);
    h.advance(1000);
    position.quantity = '4'; position.markPrice = position.liquidationPrice = position.riskFetchedAt = null;
    await h.watch.poll(); assert.equal(h.posts.length, 1, 'unknown risk is not recovery');
    assert.equal(h.watch.state().sources.find(source => source.exchange === 'binance').state, 'stale');
    assert.equal(h.watch.state().sources.find(source => source.exchange === 'binance').positions[0].alerting, true);
    position.markPrice = '100'; position.liquidationPrice = '130'; position.riskFetchedAt = new Date(h.now() - 80_000).toISOString();
    h.source.value[0].fetchedAt = at();
    await h.watch.poll(); assert.equal(h.posts.length, 1, 'new snapshot time cannot make an old risk observation current');
    position.riskFetchedAt = at();
    await h.watch.poll(); assert.equal(h.posts.length, 2); assert.match(h.posts[1], /距强平已回到 30.00%，解除预警/);
  } finally { h.cleanup(); }
});

test('a failed claim sends nothing; a definite refusal retries later; an uncertain send is not repeated', async () => {
  const h = harness();
  try {
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    const statePath = path.join(h.dataDir, 'anthropic-watch', 'state.json');
    mkdirSync(statePath, { recursive: true });
    await h.watch.poll();
    assert.equal(h.posts.length, 0, 'no send without a durable claim');
    assert.match(h.watch.state().alerts.error, /预警状态无法保存/);
    rmSync(statePath, { recursive: true });

    h.fail(new Error('飞书发送失败（19024）'));
    await h.watch.poll();
    h.fail(null);
    await h.watch.poll();
    assert.equal(h.posts.length, 0, 'retry waits one minute after a refusal');
    h.advance(60_000); await h.watch.poll();
    assert.equal(h.posts.length, 1, 'the refused alert is sent on retry');

    h.books.io = [hlPosition('io:ANTH', '-10', '130')];
    await h.watch.poll();
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    h.fail(Object.assign(new Error('飞书连接失败或超时'), { uncertain: true }));
    await h.watch.poll();
    h.fail(null);
    h.advance(5 * 60_000); await h.watch.poll();
    assert.equal(h.posts.length, 2, 'only the recovery; the uncertain alert is not resent');
    assert.deepEqual(h.watch.state().alerts.history.slice(0, 2).map(entry => entry.status), ['uncertain', 'sent']);
  } finally { h.cleanup(); }
});

test('a restart keeps claimed alerts and interruption notices without resending them', async () => {
  const h = harness();
  try {
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    // The claim is on disk before the send; an uncertain send keeps it, as a crash after the claim would.
    h.fail(Object.assign(new Error('飞书连接失败或超时'), { uncertain: true }));
    await h.watch.poll();
    h.fail(null);
    await h.restart();
    assert.equal(h.watch.state().alerts.config.enabled, true, 'the setting survives the restart');
    await h.watch.poll();
    assert.equal(h.posts.length, 0, 'the claimed alert is not sent again after the restart');
    assert.equal(h.watch.state().sources.find(source => source.exchange === 'hyperliquid').positions[0].alerting, true);
    h.advance(30 * 60_000); await h.watch.poll();
    assert.equal(h.posts.length, 1); assert.match(h.posts[0], /仍距强平/);
    assert.equal(h.watch.state().alerts.history[0].status, 'sent');
  } finally { h.cleanup(); }
});

test('after a restart or reconnect an unread source waits the full window before an interruption notice', async () => {
  const position = { id: 'okx:ANTHROPICUSDT:one-way:short:cross', exchange: 'okx', symbol: 'ANTHROPICUSDT', side: 'short', quantity: '3', quantityUnit: '张', contractSize: '1',
    entryPrice: '100', markPrice: '100', notional: '300', unrealizedPnl: '0', leverage: '2', marginMode: 'cross', liquidationPrice: '115' };
  const h = harness();
  try {
    const at = () => new Date(h.now()).toISOString();
    h.source.value = [{ exchange: 'okx', connected: true, state: 'live', fetchedAt: at(), error: null, positions: [position] }];
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    await h.watch.poll();
    assert.equal(h.posts.length, 1, 'alert at 15%');
    const lastRead = at();
    h.advance(60 * 60_000);
    await h.restart();
    h.source.value = [{ exchange: 'okx', connected: true, state: 'stale', fetchedAt: lastRead, error: null, positions: [position] }];
    await h.watch.poll();
    assert.equal(h.posts.length, 1, 'an hour of downtime is not reported before the first read after the restart');
    h.advance(30_000);
    h.source.value = [{ exchange: 'okx', connected: true, state: 'live', fetchedAt: at(), error: null, positions: [position] }];
    await h.watch.poll();
    assert.equal(h.posts.length, 2, 'the fresh read sends the due repeat only'); assert.match(h.posts[1], /仍距强平/);

    h.source.value = [{ exchange: 'okx', connected: true, state: 'loading', fetchedAt: null, error: null, positions: [] }];
    await h.watch.poll();
    h.advance(150_000); await h.watch.poll();
    assert.equal(h.posts.length, 2, 'a reconnect still loading is not an interruption yet');
    h.advance(30_000); await h.watch.poll();
    assert.equal(h.posts.length, 3); assert.match(h.posts[2], /OKX：仓位读取已中断，暂时无法监控/);
  } finally { h.cleanup(); }
});

test('Hyperliquid read failures keep the last rows and mark the source stale', { timeout: 10_000 }, async () => {
  const h = harness();
  try {
    h.books.io = [hlPosition('io:ANTH', '-10', '130')];
    await h.watch.poll();
    const read = () => h.watch.state().sources.find(source => source.exchange === 'hyperliquid');
    assert.equal(read().state, 'live');
    // 1.25 MB of whitespace without a content-length: only the streaming bound can refuse it.
    const huge = () => { let left = 5; return new Response(new ReadableStream({ pull(controller) { if (left-- > 0) controller.enqueue(new Uint8Array(256 * 1024).fill(32)); else controller.close(); } }), { status: 200 }); };
    const cases = [
      [() => { throw new DOMException('timed out', 'TimeoutError'); }, /读取超时/],
      [() => new Response('{}', { status: 429 }), /请求过于频繁/],
      [() => new Response('{}', { status: 500 }), /HTTP 500/],
      [huge, /响应过大/],
      [() => new Response('{}', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } }), /响应过大/],
      [() => new Response('not json', { status: 200 }), /无法识别/],
      [() => new Response(JSON.stringify({ assetPositions: 'x' }), { status: 200 }), /无法识别/],
    ];
    for (const [make, message] of cases) {
      h.hlFail(make);
      await h.watch.poll();
      const source = read();
      assert.equal(source.state, 'stale', String(message));
      assert.match(source.error, message);
      assert.deepEqual(source.positions.map(row => [row.symbol, row.liquidationPrice]), [['io:ANTH', '130']], 'the last rows stay');
    }
    h.hlFail(null); await h.watch.poll();
    assert.equal(read().state, 'live'); assert.equal(read().error, null);
  } finally { h.cleanup(); }
});

test('an alerted leg without a liquidation price clears, and a changed account drops its alerts', async () => {
  const h = harness();
  try {
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    await h.watch.poll();
    h.books.io = [hlPosition('io:ANTH', '-10', null)];
    await h.watch.poll();
    assert.equal(h.posts.length, 2); assert.match(h.posts[1], /不再提供强平价.*解除预警/);
    assert.equal(h.watch.state().sources.find(source => source.exchange === 'hyperliquid').positions[0].alerting, false);
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    await h.watch.poll();
    assert.equal(h.posts.length, 3);
    h.setAddress('0x' + 'b'.repeat(40)); h.books.io = [];
    await h.watch.poll();
    h.advance(10 * 60_000); await h.watch.poll();
    assert.equal(h.posts.length, 3, "the previous account's leg is not reported as gone or interrupted");
    assert.deepEqual(h.watch.state().sources.find(source => source.exchange === 'hyperliquid').positions, []);
  } finally { h.cleanup(); }
});

test('a refused send cannot restore alerts that switching off just cleared; tests do not overlap', { timeout: 10_000 }, async () => {
  const h = harness();
  try {
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    await h.watch.poll();
    h.advance(30 * 60_000);
    let release;
    h.hold(new Promise(resolve => { release = resolve; }));
    h.fail(new Error('飞书发送失败（19024）'));
    const pending = h.watch.poll();
    await new Promise(resolve => setImmediate(resolve));
    h.watch.save({ enabled: false, thresholdPercent: 20, repeatMinutes: 30 });
    release(); await pending;
    h.hold(null); h.fail(null);
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    await h.watch.poll();
    assert.equal(h.posts.length, 2); assert.doesNotMatch(h.posts[1], /仍距强平/, 'switching on again reports afresh');

    // A save that keeps alerts on does not swallow a refused send.
    h.books.io = [];
    h.hold(new Promise(resolve => { release = resolve; }));
    h.fail(new Error('飞书发送失败（19024）'));
    const refused = h.watch.poll();
    await new Promise(resolve => setImmediate(resolve));
    h.watch.save({ enabled: true, thresholdPercent: 25, repeatMinutes: 30 });
    release(); await refused;
    h.hold(null); h.fail(null);
    h.advance(60_000); await h.watch.poll();
    assert.equal(h.posts.length, 3); assert.match(h.posts[2], /仓位已不在账户中/, 'the refused gone notice is sent on the next check');

    h.hold(new Promise(resolve => { release = resolve; }));
    const first = h.watch.test();
    await assert.rejects(h.watch.test(), { status: 409 });
    release(); await first;
    h.hold(null);
    await h.watch.test();
    assert.equal(h.posts.length, 5);
  } finally { h.cleanup(); }
});

test('an own robot replaces the digest robot, is never returned, blocks sending when unreadable and falls back when cleared', async () => {
  const h = harness();
  const hook = 'https://open.feishu.cn/open-apis/bot/v2/hook/own-robot-token';
  try {
    assert.equal(h.watch.state().alerts.channel.source, 'digest');
    assert.throws(() => h.watch.setChannel({ webhookUrl: 'https://example.com/hook', signingSecret: '' }), { status: 400 });
    assert.throws(() => h.watch.setChannel({ webhookUrl: hook }), { status: 400 });
    const saved = h.watch.setChannel({ webhookUrl: hook, signingSecret: 'own-secret' });
    assert.deepEqual(saved.alerts.channel, { configured: true, source: 'own', host: 'open.feishu.cn', error: null });
    assert.doesNotMatch(JSON.stringify(saved), /own-robot-token|own-secret/);
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    await h.watch.poll();
    assert.equal(h.posts.length, 0, 'the digest robot is not used');
    assert.equal(h.ownPosts.length, 1); assert.equal(h.ownPosts[0].url, hook); assert.ok(h.ownPosts[0].signed);
    assert.match(h.ownPosts[0].text, /距强平 10\.00%/);
    await h.watch.test();
    assert.equal(h.ownPosts.length, 2);

    // Unreadable after a restart: no fallback to the digest's group, the error is shown, sending is blocked.
    const file = path.join(h.dataDir, 'anthropic-watch', 'channel.json');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, JSON.stringify({ value: { sealed: '{broken' } }));
    await h.restart();
    const broken = h.watch.state().alerts.channel;
    assert.deepEqual([broken.configured, broken.source], [false, 'own']); assert.match(broken.error, /无法读取/);
    await assert.rejects(h.watch.test(), { status: 409, message: /无法读取/ });
    h.advance(30 * 60_000); await h.watch.poll();
    assert.equal(h.posts.length, 0); assert.equal(h.ownPosts.length, 2);

    // A robot saved again is used; clearing it falls back to the digest robot and keeps alerts on.
    writeFileSync(file, original); await h.restart();
    assert.equal(h.watch.state().alerts.channel.source, 'own');
    const cleared = h.watch.clearChannel();
    assert.deepEqual(cleared.alerts.channel, { configured: true, source: 'digest', host: null, error: null });
    assert.equal(cleared.alerts.config.enabled, true);
    await h.watch.poll();
    assert.equal(h.posts.length, 1, 'the due repeat goes to the digest robot'); assert.match(h.posts[0], /仍距强平/);

    // Without a digest robot, clearing switches alerts off.
    h.watch.setChannel({ webhookUrl: hook, signingSecret: '' });
    h.digest = false;
    const off = h.watch.clearChannel();
    assert.deepEqual([off.alerts.channel.configured, off.alerts.channel.source, off.alerts.config.enabled], [false, null, false]);
    await h.restart();
    assert.equal(h.watch.state().alerts.config.enabled, false, 'switching off is durable');
  } finally { await h.watch.close(); h.cleanup(); }
});

test('an own robot that breaks after startup refuses definitely without the digest robot; a lost response is not resent', async () => {
  const h = harness();
  const hook = 'https://open.feishu.cn/open-apis/bot/v2/hook/own-robot-token';
  const file = path.join(h.dataDir, 'anthropic-watch', 'channel.json');
  const last = () => h.watch.state().alerts.history[0];
  try {
    h.watch.setChannel({ webhookUrl: hook, signingSecret: '' });
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    await h.watch.poll();
    assert.equal(h.ownPosts.length, 1);
    const original = readFileSync(file, 'utf8');
    for (const broken of [null, JSON.stringify({ value: { sealed: '{broken' } }), JSON.stringify({ value: { sealed: JSON.stringify({ webhookUrl: 'https://example.com/x', signingSecret: '' }) } })]) {
      if (broken === null) rmSync(file); else writeFileSync(file, broken);
      h.advance(30 * 60_000); await h.watch.poll();
      assert.equal(h.posts.length, 0, 'never falls back to the digest robot');
      assert.equal(last().status, 'failed'); assert.match(last().error, /预警机器人无法读取/);
      writeFileSync(file, original);
      h.advance(60_000); await h.watch.poll();
      assert.match(h.ownPosts.at(-1).text, /仍距强平/, 'the refused repeat is sent once the robot is readable again');
    }
    assert.equal(h.ownPosts.length, 4);

    h.ownFail = () => { throw new TypeError('fetch failed'); };
    h.advance(30 * 60_000); await h.watch.poll();
    assert.equal(last().status, 'uncertain');
    h.ownFail = null;
    h.advance(60_000); await h.watch.poll();
    assert.equal(h.ownPosts.length, 4, 'a possibly delivered repeat is not resent');

    writeFileSync(file, 'null'); await h.restart();
    assert.match(h.watch.state().alerts.channel.error, /无法读取/, 'a non-object file is unreadable, not absent');
    h.watch.save({ enabled: false, thresholdPercent: 20, repeatMinutes: 30 });
    assert.throws(() => h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 }), { status: 409, message: /无法读取/ });
    assert.equal(h.posts.length, 0);
  } finally { await h.watch.close(); h.cleanup(); }
});

const rhPosition = (symbol, sign, position, liquidation, extra = {}) => ({ market_id: symbol === 'ANTHROPIC' ? 38 : 0, symbol, initial_margin_fraction: '33.33', sign, position,
  avg_entry_price: '100.0', position_value: '1000.000000', unrealized_pnl: '-1.5', liquidation_price: liquidation, margin_mode: 0, allocated_margin: '0.000000', ...extra });

for (const exchange of ['hyperliquid', 'rh-lighter']) {
  const setPosition = (h, { mark = true, liquidation = '110', gone = false } = {}) => {
    if (exchange === 'hyperliquid') h.books.io = gone ? [] : [hlPosition('io:ANTH', '-10', liquidation, mark ? '1000' : '0')];
    else {
      h.setRhAddress('0x' + 'c'.repeat(40));
      h.rhAccounts = [{ index: 7, positions: gone ? [] : [rhPosition('ANTHROPIC', -1, '10', liquidation ?? '0', { position_value: mark ? '1000' : '0' })] }];
    }
  };

  test(`${exchange} missing marks keep the liquidation warning, deduplicate unknown notices and survive restart`, async () => {
    const h = harness();
    const row = () => h.watch.state().sources.find(source => source.exchange === exchange).positions[0];
    try {
      h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
      setPosition(h); await h.watch.poll();
      assert.equal(h.posts.length, 1); assert.match(h.posts[0], /🔴.*距强平 10\.00%/);
      setPosition(h, { mark: false }); await h.watch.poll();
      assert.equal(row().alerting, true, 'a missing mark cannot release a known liquidation warning');
      assert.deepEqual([row().markPrice, row().liquidationPrice, row().distancePercent, row().riskUnknown], [null, '110', null, true]);
      assert.equal(h.posts.length, 2); assert.match(h.posts[1], /⚠️.*标记价缺失.*无法计算.*保留预警/);
      assert.doesNotMatch(h.posts[1], /🟢|解除预警|不再提供强平价/);
      assert.equal(h.cards[1].header.template, 'red', 'the unknown notice is not a green recovery card');
      h.advance(31 * 60_000); await h.watch.poll();
      await h.restart(); await h.watch.poll();
      assert.equal(h.posts.length, 2, 'persistent unknown risk does not repeat or turn into recovery after restart');
      assert.equal(row().alerting, true);
      setPosition(h, { mark: false, liquidation: null }); await h.watch.poll();
      assert.equal(row().riskUnknown, true, 'a missing mark takes precedence over an absent liquidation price');
      assert.equal(row().alerting, true); assert.equal(h.posts.length, 2);

      setPosition(h, { liquidation: '121' }); await h.watch.poll();
      assert.equal(row().riskUnknown, false); assert.equal(row().alerting, true);
      assert.equal(h.posts.length, 2, 'valid data in the hysteresis band still does not clear the warning');
      await h.restart();
      setPosition(h, { mark: false }); await h.watch.poll();
      assert.equal(h.posts.length, 3, 'a new interruption after valid data is reported even across restart');
      assert.match(h.posts[2], /无法计算.*保留预警/);
      setPosition(h, { liquidation: '130' }); await h.watch.poll();
      assert.equal(row().alerting, false); assert.equal(row().riskUnknown, false);
      assert.match(h.posts[3], /🟢.*距强平已回到 30\.00%，解除预警/);

      setPosition(h); await h.watch.poll();
      setPosition(h, { mark: false }); await h.watch.poll();
      setPosition(h, { liquidation: null }); await h.watch.poll();
      assert.equal(row().alerting, false); assert.equal(row().riskUnknown, false);
      assert.match(h.posts.at(-1), /不再提供强平价.*解除预警/, 'a valid mark preserves the established no-liquidation-price contract');
      setPosition(h); await h.watch.poll();
      setPosition(h, { mark: false }); await h.watch.poll();
      setPosition(h, { gone: true }); await h.watch.poll();
      assert.match(h.posts.at(-1), /仓位已不在账户中/, 'a fresh missing position retains the gone warning');
    } finally { await h.watch.close(); h.cleanup(); }
  });

  test(`${exchange} unknown notices preserve durable claims and definite or uncertain failure handling`, async () => {
    const h = harness();
    const row = () => h.watch.state().sources.find(source => source.exchange === exchange).positions[0];
    const statePath = path.join(h.dataDir, 'anthropic-watch', 'state.json');
    try {
      h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
      setPosition(h); await h.watch.poll();
      const original = readFileSync(statePath, 'utf8');
      rmSync(statePath); mkdirSync(statePath);
      setPosition(h, { mark: false }); await h.watch.poll();
      assert.equal(h.posts.length, 1, 'unknown notice requires a durable claim');
      assert.equal(row().alerting, true);
      rmSync(statePath, { recursive: true }); writeFileSync(statePath, original);
      h.fail(new Error('飞书发送失败（19024）')); await h.watch.poll();
      assert.equal(row().alerting, true);
      assert.equal(h.watch.state().alerts.history[0].status, 'failed');
      h.fail(null); await h.watch.poll(); assert.equal(h.posts.length, 1);
      h.advance(60_000); await h.watch.poll();
      assert.equal(h.posts.length, 2); assert.match(h.posts[1], /无法计算.*保留预警/);
      setPosition(h, { liquidation: '121' }); await h.watch.poll();
      setPosition(h, { mark: false });
      h.fail(Object.assign(new Error('飞书连接失败或超时'), { uncertain: true })); await h.watch.poll();
      assert.equal(h.watch.state().alerts.history[0].status, 'uncertain');
      assert.equal(row().alerting, true);
      h.fail(null); await h.restart(); h.advance(31 * 60_000); await h.watch.poll();
      assert.equal(h.posts.length, 2, 'an uncertain unknown notice is not resent after restart');
      assert.equal(row().alerting, true);
    } finally { await h.watch.close(); h.cleanup(); }
  });

  test(`${exchange} test notifications distinguish missing marks from a known absent liquidation price`, async () => {
    const h = harness();
    try {
      setPosition(h, { mark: false, liquidation: null }); await h.watch.poll(); await h.watch.test();
      assert.match(h.posts[0], /标记价缺失.*无法计算/); assert.doesNotMatch(h.posts[0], /未提供强平价/);
      setPosition(h, { liquidation: null }); await h.watch.poll(); await h.watch.test();
      assert.match(h.posts[1], /未提供强平价/);
    } finally { await h.watch.close(); h.cleanup(); }
  });

  test(`${exchange} a resumed source with missing marks cannot announce restored monitoring`, async () => {
    const h = harness();
    const fail = exchange === 'hyperliquid' ? h.hlFail : h.rhFail;
    try {
      h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
      setPosition(h); await h.watch.poll();
      setPosition(h, { mark: false }); await h.watch.poll();
      fail(() => { throw new TypeError('fetch failed'); });
      h.advance(180_000); await h.watch.poll();
      assert.match(h.posts.at(-1), /仓位读取已中断/);
      const count = h.posts.length;
      fail(null); await h.watch.poll();
      assert.equal(h.posts.length, count, 'successful transport without a usable mark does not restore monitoring');
      setPosition(h, { liquidation: '130' }); await h.watch.poll();
      assert.equal(h.posts.length, count + 1);
      assert.match(h.posts.at(-1), /仓位读取已恢复/);
      assert.match(h.posts.at(-1), /距强平已回到 30\.00%，解除预警/);
    } finally { await h.watch.close(); h.cleanup(); }
  });
}

test('Lighter RH accounts keep only the Anthropic market of each account under the address', () => {
  const rows = parseRhLighterAccounts({ accounts: [
    { index: 7, positions: [rhPosition('ANTHROPIC', -1, '10.00000', '120.123456789012345678901'), rhPosition('ETH', 1, '1', '0')] },
    { index: 9, positions: [rhPosition('ANTHROPIC', 1, '10', '0', { margin_mode: 1, allocated_margin: '250.5', initial_margin_fraction: '20.00' })] },
    { index: 11, positions: [rhPosition('ANTHROPIC', 1, '0.00000', '0')] },
  ] });
  assert.deepEqual(rows.map(row => [row.id, row.side, row.quantity, row.markPrice, row.liquidationPrice, row.leverage, row.marginMode, row.marginUsed]), [
    ['rh-lighter:ANTHROPIC:7:short', 'short', '10', '100', '120.123456789012345678', '3', 'cross', null],
    ['rh-lighter:ANTHROPIC:9:long', 'long', '10', '100', null, '5', 'isolated', '250.5'],
  ]);
  assert.throws(() => parseRhLighterAccounts({ accounts: [{ index: 7, positions: [rhPosition('ANTHROPIC', 1, '1', '0'), rhPosition('ANTHROPIC', 1, '2', '0')] }] }));
  assert.throws(() => parseRhLighterAccounts({ accounts: [{ index: 7, positions: [rhPosition('ANTHROPIC', 0, '1', '0')] }] }));
  assert.throws(() => parseRhLighterAccounts({ accounts: 'x' }));
});

test('Lighter RH legs are read for the connected L1 address, alert, and keep the last rows on failures', { timeout: 10_000 }, async () => {
  const h = harness();
  try {
    const RH = '0x' + 'c'.repeat(40);
    const read = () => h.watch.state().sources.find(source => source.exchange === 'rh-lighter');
    await h.watch.poll();
    assert.deepEqual([read().state, read().connected, h.rhRequests.length], ['unconfigured', false, 0], 'no connection, no request');
    h.watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    h.setRhAddress(RH);
    h.rhAccounts = [{ index: 7, positions: [rhPosition('ANTHROPIC', -1, '10', '110')] }];
    await h.watch.poll();
    assert.equal(new URL(h.rhRequests[0]).searchParams.get('value'), RH);
    assert.equal(new URL(h.rhRequests[0]).searchParams.get('by'), 'l1_address');
    assert.equal(read().state, 'live');
    assert.equal(read().positions[0].alerting, true);
    assert.equal(h.posts.length, 1); assert.match(h.posts[0], /Lighter RH ANTHROPIC 账户 7 做空：距强平 10\.00%/);

    const cases = [
      [() => new Response('{}', { status: 429 }), /Lighter RH 请求过于频繁/],
      [() => new Response(JSON.stringify({ code: 23000, message: 'too many requests' }), { status: 400 }), /Lighter RH 请求过于频繁/],
      [() => new Response(JSON.stringify({ code: 23000, message: 'too many requests' }), { status: 200 }), /Lighter RH 请求过于频繁/],
      [() => new Response(JSON.stringify({ code: 20001, message: 'invalid param' }), { status: 400 }), /Lighter RH 返回 HTTP 400/],
      [() => new Response('{}', { status: 502 }), /Lighter RH 返回 HTTP 502/],
      [() => new Response(JSON.stringify({ accounts: [{ index: 7, positions: 'x' }] }), { status: 200 }), /Lighter RH 仓位数据无法识别/],
      [() => { throw new DOMException('timed out', 'TimeoutError'); }, /Lighter RH 读取超时/],
    ];
    for (const [make, message] of cases) {
      h.advance(60_000); h.rhFail(make); await h.watch.poll();
      assert.equal(read().state, 'stale', String(message)); assert.match(read().error, message);
      assert.deepEqual(read().positions.map(row => row.liquidationPrice), ['110'], 'the last rows stay');
    }
    h.advance(60_000); h.rhFail(() => new Response('{}', { status: 405 })); await h.watch.poll();
    const sent = h.rhRequests.length;
    h.advance(59_000); await h.watch.poll();
    assert.equal(h.rhRequests.length, sent, 'no Lighter RH read inside the 60 s cooldown');
    assert.match(read().error, /Lighter RH 请求过于频繁/);
    h.advance(1000);
    h.rhFail(() => new Response(JSON.stringify({ code: 21100, message: 'account not found' }), { status: 400 }));
    await h.watch.poll();
    assert.equal(h.rhRequests.length, sent + 1, 'the cooldown ends after 60 s');
    assert.deepEqual([read().state, read().positions], ['live', []], 'an address without accounts has no positions');
    assert.match(h.posts.at(-1), /Lighter RH ANTHROPIC 账户 7 做空：仓位已不在账户中/);
    assert.ok(h.watch.state().sources.find(source => source.exchange === 'hyperliquid'), 'Hyperliquid is still listed');
  } finally { await h.watch.close(); h.cleanup(); }
});
