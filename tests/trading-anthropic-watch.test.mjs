import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnthropicWatch, liquidationDistance, parseHyperliquidState, validateAlertConfig } from '../server/trading-anthropic-watch.mjs';

const ADDRESS = '0x' + 'a'.repeat(40);
const quiet = { warn() {} };
const hlPosition = (coin, szi, liquidationPx, positionValue = '1000') => ({ type: 'oneWay', position: { coin, szi, entryPx: '100', positionValue, unrealizedPnl: '0', liquidationPx, leverage: { type: 'isolated', value: 3 }, marginUsed: '333' } });

function harness({ cex = [], configured = true } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'anthropic-watch-'));
  let time = Date.parse('2026-11-06T00:00:00Z');
  const books = { io: [], xyz: [] }, posts = [], requests = [], ownPosts = [];
  let postFailure = null, hlFailure = null, gate = null, address = ADDRESS;
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).startsWith('https://open.feishu.cn/') && h.ownFail) return h.ownFail();
    if (String(url).startsWith('https://open.feishu.cn/')) { ownPosts.push({ url, text: body.card.elements[0].text.content, signed: !!body.sign }); return new Response(JSON.stringify({ code: 0 }), { status: 200 }); }
    requests.push(body);
    if (hlFailure) return hlFailure();
    return new Response(JSON.stringify({ assetPositions: books[body.dex] }), { status: 200 });
  };
  const feishu = {
    alertChannel: () => ({ configured: h.digest, title: '工作台汇总' }),
    async postAlert(card) { if (gate) await gate; if (postFailure) throw postFailure; posts.push(card.elements[0].text.content); },
  };
  const source = { value: cex };
  const create = () => {
    const watch = createAnthropicWatch({ dataDir, readCex: () => source.value, readAddress: () => address, feishu, encrypt: value => ({ sealed: JSON.stringify(value) }), decrypt: value => JSON.parse(value.sealed), log: quiet, fetcher, now: () => time, intervalMs: 0 });
    watch.initialize(); return watch;
  };
  const h = { digest: configured, books, posts, ownPosts, requests, source, dataDir, advance: ms => { time += ms; }, now: () => time, fail: error => { postFailure = error; },
    hlFail: make => { hlFailure = make; }, hold: promise => { gate = promise; }, setAddress: value => { address = value; },
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
    assert.equal(h.watch.state().sources.at(-1).positions[0].alerting, false);
    h.books.io = [hlPosition('io:ANTH', '-10', '110')];
    await h.watch.poll();
    assert.equal(h.posts.length, 3);
    h.setAddress('0x' + 'b'.repeat(40)); h.books.io = [];
    await h.watch.poll();
    h.advance(10 * 60_000); await h.watch.poll();
    assert.equal(h.posts.length, 3, "the previous account's leg is not reported as gone or interrupted");
    assert.deepEqual(h.watch.state().sources.at(-1).positions, []);
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
