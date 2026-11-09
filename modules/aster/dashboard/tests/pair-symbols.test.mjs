import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PAIR_SYMBOL,
  fetchPairSymbols,
  parsePairSymbols,
} from '../lib/pair-symbols.ts';
import {
  pairConfigurationChanges,
  pairDraft,
  parsePairDraft,
} from '../lib/pairs.ts';

const silver = { symbol: 'XAGUSD1', display_name: '白银 XAGUSD1' };
const catalog = [DEFAULT_PAIR_SYMBOL, silver];
const accounts = [
  { id: 'a', name: 'A', mode: 'paper', enabled: false },
  { id: 'b', name: 'B', mode: 'paper', enabled: false },
];
const draft = () => ({
  ...pairDraft(),
  id: 'silver_pair',
  name: '白银配对',
  long_account_id: 'a',
  short_account_id: 'b',
});

test('server catalog controls new pair choices and rejects unusable responses', () => {
  assert.deepEqual(parsePairSymbols({ symbols: catalog }), catalog);
  // Retired opening defaults from older servers are ignored, not validated.
  assert.deepEqual(
    parsePairSymbols({
      symbols: [
        { ...silver, min_notional: 'NaN', default_order_notional: '0' },
      ],
    }),
    [silver],
  );
  for (const value of [
    null,
    [],
    { symbols: [] },
    { symbols: [silver, silver] },
    { symbols: [{ ...silver, symbol: 'xagusd1' }] },
    { symbols: [{ ...silver, display_name: '' }] },
  ])
    assert.throws(() => parsePairSymbols(value), /配对标的/);
});

test('catalog requests use the pair route, same-origin credentials and caller cancellation', async () => {
  const controller = new AbortController();
  const result = await fetchPairSymbols(
    controller.signal,
    async (url, options) => {
      assert.equal(url, '/api/pairs/supported-symbols');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      return Response.json({ symbols: catalog });
    },
  );
  assert.deepEqual(result, catalog);
  controller.abort();
  await assert.rejects(
    fetchPairSymbols(controller.signal, async () =>
      Response.json({ symbols: catalog }),
    ),
    { name: 'AbortError' },
  );
});

test('HTTP, authentication and malformed catalog failures never invent supported choices', async () => {
  for (const [response, expected] of [
    [
      Response.json({ detail: '旧服务没有目录' }, { status: 404 }),
      /旧服务没有目录/,
    ],
    [Response.json({ symbols: catalog }, { status: 401 }), /重新登录/],
    [new Response('unavailable', { status: 503 }), /读取失败/],
    [Response.json({ symbols: [] }), /未提供可用/],
    [new Response('invalid JSON'), /未提供可用/],
  ])
    await assert.rejects(
      fetchPairSymbols(new AbortController().signal, async () => response),
      expected,
    );
  const selected = { ...draft(), symbol: silver.symbol };
  assert.throws(
    () => parsePairDraft(selected, accounts, [], undefined, []),
    /支持的配对标的/,
  );
  assert.throws(() => parsePairDraft(selected, accounts, []), /支持的配对标的/);
});

test('gold and silver serialize the exact selected symbol without enabling the group', () => {
  for (const symbol of catalog) {
    const selected = { ...draft(), symbol: symbol.symbol };
    const config = parsePairDraft(selected, accounts, [], undefined, catalog);
    const request = JSON.parse(JSON.stringify(config));
    assert.equal(request.symbol, symbol.symbol);
    assert.equal(Object.hasOwn(request, 'ordinary'), false);
    assert.equal(Object.hasOwn(request, 'enabled'), false);
  }
});

test('saved silver groups keep their symbol and remain editable without a catalog', () => {
  const saved = {
    ...parsePairDraft(
      { ...draft(), symbol: silver.symbol },
      accounts,
      [],
      undefined,
      catalog,
    ),
    enabled: false,
  };
  const edited = { ...pairDraft(saved), name: '白银组改名' };
  const parsed = parsePairDraft(edited, accounts, [saved], saved.id, []);
  assert.equal(parsed.symbol, 'XAGUSD1');
  const changes = pairConfigurationChanges(parsed);
  assert.equal(changes.name, '白银组改名');
  assert.equal(changes.symbol, 'XAGUSD1');
  assert.throws(
    () =>
      parsePairDraft(
        { ...edited, symbol: DEFAULT_PAIR_SYMBOL.symbol },
        accounts,
        [saved],
        saved.id,
        [],
      ),
    /支持的配对标的/,
  );
});

test('switching a saved pair preserves all settings and PATCH excludes its identity and activation', () => {
  const saved = {
    ...parsePairDraft(
      {
        ...draft(),
        name: '保留组名称',
        margin_enabled: true,
        balance_threshold: '25.125',
        max_transfer: '2500',
      },
      accounts,
      [],
      undefined,
      catalog,
    ),
    enabled: false,
  };
  const original = pairDraft(saved);
  const selected = { ...original, symbol: 'XAGUSD1' };
  assert.deepEqual(pairDraft(saved), original);
  const parsed = parsePairDraft(selected, accounts, [saved], saved.id, catalog);
  const request = JSON.parse(JSON.stringify(pairConfigurationChanges(parsed)));
  assert.deepEqual(request, {
    name: saved.name,
    symbol: 'XAGUSD1',
    margin: saved.margin,
    adl: saved.adl,
  });
  assert.equal(parsed.id, saved.id);
  assert.equal(parsed.long_account_id, saved.long_account_id);
  assert.equal(parsed.short_account_id, saved.short_account_id);
  assert.throws(
    () =>
      parsePairDraft(
        { ...selected, symbol: 'UNKNOWN' },
        accounts,
        [saved],
        saved.id,
        catalog,
      ),
    /支持的配对标的/,
  );
});

test('legacy pair records and drafts without a symbol retain the gold default', () => {
  const oldDraft = draft();
  delete oldDraft.symbol;
  const config = parsePairDraft(oldDraft, accounts, []);
  delete config.symbol;
  const restored = pairDraft(config);
  assert.equal(restored.symbol, 'XAUUSD1');
});
