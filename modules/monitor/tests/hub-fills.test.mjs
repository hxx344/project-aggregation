import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFillsReply, createFillsRequester, createFillsPoller, retainFillsReply, emptyFillsView, FILLS_TIMEOUT_MS, FILLS_REFRESH_MS, FILLS_FOLLOW_UP_MS } from '../lib/hub-fills-contract.ts';
import { MODULE_CAPABILITIES, canUseHostCapability } from '../lib/hub-bridge.ts';
import { fill, fillsReply } from './oil-trades-fixtures.mjs';

test('sourceId is mandatory, bounded and preserved on both fills and coverage', () => {
  const parsed = parseFillsReply(fillsReply());
  assert.equal(parsed.items[0].sourceId, 'asset'); assert.equal(parsed.coverage[0].sourceId, 'asset');
  for (const sourceId of [undefined, null, 7, '', ' ', ' asset', 'asset ', 'asset\nother', 'a'.repeat(161)]) {
    assert.equal(parseFillsReply(fillsReply({ items: [fill({ sourceId })] })), null);
    assert.equal(parseFillsReply(fillsReply({ coverage: [{ ...fillsReply().coverage[0], sourceId }] })), null);
  }
});

test('fills require a negotiated host capability, and preserve exact redacted decimal fields', () => {
  assert.ok(MODULE_CAPABILITIES.includes('fills'));
  assert.equal(canUseHostCapability(false, ['fills'], 'fills'), false);
  assert.equal(canUseHostCapability(true, ['positions'], 'fills'), false);
  assert.equal(canUseHostCapability(true, ['fills'], 'fills'), true);
  const exact = fill({ quantity: '9007199254740993.000000000000000001', price: '0.00000000000000000001', positionBefore: null, positionAfter: null, fee: null, feeCurrency: null });
  const parsed = parseFillsReply(fillsReply({ items: [{ ...exact, apiKey: 'never forward' }], secret: 'no', coverage: [{ ...fillsReply().coverage[0], apiKey: 'no' }] }));
  assert.deepEqual(parsed.items, [exact]); assert.equal('secret' in parsed, false); assert.equal('apiKey' in parsed.coverage[0], false);
  for (const exchangeId of ['bybit', 'okx']) {
    const item = fill({ exchangeId, symbol: exchangeId === 'okx' ? 'CL-USDT-SWAP' : 'CLUSDT', quantityUnit: exchangeId === 'okx' ? '张' : 'CL' });
    assert.ok(parseFillsReply(fillsReply({ items: [item] })));
  }
  assert.ok(parseFillsReply(fillsReply({ items: [fill({ exchangeId: 'bybit', priceCurrency: 'USDC', symbol: 'CLPERP' })] })));
  assert.equal(parseFillsReply(fillsReply({ items: [fill({ fee: '-0.1', feeCurrency: null })] })).items[0].feeCurrency, null);
});

function pollerFixture() {
  const sent = [], timers = new Map(); let now = 0, sequence = 0, id = 0;
  const advance = ms => {
    const target = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = target;
  };
  const poller = createFillsPoller({
    send: message => sent.push(message), onReply() {}, createId: () => `req-${++id}`,
    schedule(callback, ms) { const handle = ++sequence; timers.set(handle, { callback, at: now + ms }); return handle; },
    cancel: handle => timers.delete(handle),
  }, 'oil');
  return { poller, sent, timers, advance, reply: pending => poller.receive(fillsReply({ pending, requestId: sent.at(-1).requestId })) };
}

test('continuous pending follows up every 25 seconds at most six times, then resumes the five-minute cycle', () => {
  const { poller, sent, timers, advance, reply } = pollerFixture();
  assert.equal(sent.length, 0); poller.start(); poller.start(); assert.equal(sent.length, 1);
  reply(true);
  for (let followUp = 1; followUp <= 6; followUp++) {
    advance(24_999); assert.equal(sent.length, followUp);
    advance(1); assert.equal(sent.length, followUp + 1);
    reply(true);
  }
  advance(149_999); assert.equal(sent.length, 7, 'the seventh follow-up is forbidden even while pending');
  advance(1); assert.equal(sent.length, 8, 'the normal five-minute request still runs');
  reply(true); advance(25_000); assert.equal(sent.length, 9, 'a new normal cycle resets the follow-up budget');
  poller.dispose(); assert.equal(timers.size, 0);
});

test('pending false stops follow-ups immediately and the next pending cycle has its full budget', () => {
  const { poller, sent, advance, reply } = pollerFixture();
  poller.start(); reply(true);
  for (let i = 0; i < 2; i++) { advance(25_000); reply(true); }
  advance(25_000); reply(false);
  advance(224_999); assert.equal(sent.length, 4, 'no more follow-ups after completed data');
  advance(1); assert.equal(sent.length, 5);
  reply(true);
  for (let i = 0; i < 6; i++) { advance(25_000); reply(true); }
  assert.equal(sent.length, 11);
  advance(25_000); assert.equal(sent.length, 11);
  poller.dispose();
});

test('foreground deactivation cleanup stops queued and in-flight follow-ups; activation requests immediately', () => {
  const { poller, sent, timers, advance, reply } = pollerFixture();
  poller.start(); reply(true); advance(10_000);
  // useHubFills disposes this poller when active becomes false.
  poller.dispose(); assert.equal(timers.size, 0);
  advance(900_000); assert.equal(sent.length, 1); assert.equal(poller.retry(), null);
  poller.start(); assert.equal(sent.length, 2);
  reply(true); advance(25_000); assert.equal(sent.length, 3);
  poller.dispose(); assert.equal(reply(true), false, 'a late pending reply cannot restart an inactive poller');
  advance(900_000); assert.equal(sent.length, 3); assert.equal(timers.size, 0);
});

test('malformed replies, misleading symbols, non-decimals and incomplete positions are rejected', () => {
  const invalid = [
    { type: 'positions' }, { market: 'hynix' }, { requestId: 'a b' }, { status: 'live' }, { generatedAt: 'today' },
    { lookbackStart: '2026-02-30T00:00:00.000Z' }, { pending: 1 }, { incomplete: null }, { truncated: 'false' },
    { items: Array.from({ length: 2001 }, (_, i) => fill({ key: String(i) })) }, { items: [fill(), fill()] },
    { coverage: [{ ...fillsReply().coverage[0], status: 'complete' }] }, { coverage: [{ ...fillsReply().coverage[0], fetchedAt: 'bad' }] },
  ];
  const itemInvalid = [
    { quantity: '1e2' }, { price: '+1' }, { quantity: '0' }, { quantity: '-1' }, { price: 'NaN' }, { price: 100 },
    { fee: '' }, { realizedPnl: ' 0' }, { feeCurrency: 'bad currency' }, { positionBefore: null },
    { stale: 'no' }, { time: '2026-02-30T00:00:00.000Z' }, { base: 'BTC' }, { symbol: 'CLOUDUSDT' },
    { symbol: 'CLUSD1' }, { quantityUnit: '张' }, { exchangeId: 'aster' }, { account: 'a\nb' },
    { symbol: 'CLUSDC', priceCurrency: 'USDC' },
  ];
  for (const fields of invalid) assert.equal(parseFillsReply(fillsReply(fields)), null, JSON.stringify(fields).slice(0, 100));
  for (const fields of itemInvalid) assert.equal(parseFillsReply(fillsReply({ items: [fill(fields)] })), null, JSON.stringify(fields));
  assert.deepEqual(parseFillsReply(fillsReply({ status: 'unauthorized' })).items, []);
});

function requesterFixture() {
  const sent = [], replies = [], timers = new Map(); let id = 0, timerId = 0;
  const requester = createFillsRequester({
    send: value => sent.push(value), onReply: value => replies.push(value), createId: () => `req-${++id}`,
    schedule(callback, ms) { const handle = ++timerId; timers.set(handle, { ms, callback() { timers.delete(handle); callback(); } }); return handle; },
    cancel: handle => timers.delete(handle),
  });
  return { requester, sent, replies, timers };
}
test('latest id and market must match; handshake retries only unanswered fills and times out at 20 seconds', () => {
  const { requester, sent, replies, timers } = requesterFixture();
  assert.equal(FILLS_TIMEOUT_MS, 20_000); assert.equal(FILLS_REFRESH_MS, 300_000); assert.equal(FILLS_FOLLOW_UP_MS, 25_000);
  assert.equal(requester.retry(), null);
  requester.request('oil'); requester.retry();
  assert.deepEqual(sent, [{ type: 'fills-request', requestId: 'req-1', market: 'oil' }, { type: 'fills-request', requestId: 'req-2', market: 'oil' }]);
  assert.equal(timers.size, 1);
  assert.equal(requester.receive(fillsReply()), false);
  assert.equal(requester.receive(fillsReply({ requestId: 'req-2', market: 'hynix' })), false);
  assert.equal(requester.receive(fillsReply({ requestId: 'req-2' })), true);
  assert.equal(requester.retry(), null); assert.equal(timers.size, 0);
  requester.request('oil');
  const timer = [...timers.values()][0]; assert.equal(timer.ms, 20_000); timer.callback();
  assert.equal(replies.at(-1).timedOut, true); assert.equal(requester.retry(), null);
  assert.equal(requester.receive(fillsReply({ requestId: 'req-3' })), false);
  requester.request('oil'); requester.dispose(); assert.equal(timers.size, 0); assert.equal(requester.retry(), null);
});

test('failed refreshes preserve the last successful fills, coverage and original source time', () => {
  const good = retainFillsReply(null, parseFillsReply(fillsReply()));
  const failure = parseFillsReply(fillsReply({ status: 'unavailable' }));
  const stale = retainFillsReply(good, failure);
  assert.equal(stale.retained, true); assert.deepEqual(stale.items, good.items);
  assert.equal(stale.generatedAt, good.generatedAt); assert.equal(stale.coverage[0].fetchedAt, good.coverage[0].fetchedAt);
  assert.deepEqual(retainFillsReply(stale, failure), stale);
  const recovered = retainFillsReply(stale, parseFillsReply(fillsReply({ items: [] })));
  assert.equal(recovered.retained, false); assert.deepEqual(recovered.items, []);
  assert.equal(retainFillsReply(emptyFillsView('loading'), failure).retained, false);
});
