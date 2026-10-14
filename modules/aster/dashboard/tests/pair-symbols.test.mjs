import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cycleDraft, parseCycleDraft } from '../lib/cycle.ts';
import {
  DEFAULT_PAIR_SYMBOL,
  fetchPairSymbols,
  parsePairSymbols,
} from '../lib/pair-symbols.ts';
import {
  pairConfigurationChanges,
  pairDraft,
  pairNetQuantity,
  parsePairDraft,
  selectPairSymbol,
} from '../lib/pairs.ts';

const silver = {
  ...DEFAULT_PAIR_SYMBOL,
  symbol: 'XAGUSD1',
  display_name: '白银 XAGUSD1',
};
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
  for (const value of [
    null,
    [],
    { symbols: [] },
    { symbols: [silver, silver] },
    { symbols: [{ ...silver, symbol: 'xagusd1' }] },
    { symbols: [{ ...silver, display_name: '' }] },
    { symbols: [{ ...silver, min_notional: 500 }] },
    { symbols: [{ ...silver, min_notional: 'NaN' }] },
    { symbols: [{ ...silver, default_order_notional: '0' }] },
    { symbols: [{ ...silver, default_spread_limit: '-1' }] },
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
  const selected = selectPairSymbol(draft(), silver, catalog);
  assert.throws(
    () => parsePairDraft(selected, accounts, [], undefined, []),
    /支持的配对标的/,
  );
  assert.throws(() => parsePairDraft(selected, accounts, []), /支持的配对标的/);
});

test('gold and silver serialize the exact selected symbol for every pair mode', () => {
  for (const symbol of catalog) {
    for (const mode of ['monitor', 'ordinary', 'cycle']) {
      const selected = selectPairSymbol({ ...draft(), mode }, symbol, catalog);
      const config = parsePairDraft(selected, accounts, [], undefined, catalog);
      const request = JSON.parse(JSON.stringify(config));
      assert.equal(request.symbol, symbol.symbol);
      assert.equal(request.cycle.symbol, symbol.symbol);
      assert.equal(request.ordinary.enabled, mode === 'ordinary');
      assert.equal(request.cycle.enabled, mode === 'cycle');
      assert.equal(Object.hasOwn(request, 'enabled'), false);
    }
  }
});

test('symbol selection follows catalog defaults without overwriting edited amounts', () => {
  const custom = {
    ...silver,
    min_notional: '750',
    default_order_notional: '1500',
    default_threshold: '12000',
    default_spread_limit: '0.0004',
  };
  const selected = selectPairSymbol(draft(), custom, [
    DEFAULT_PAIR_SYMBOL,
    custom,
  ]);
  assert.equal(selected.threshold, '12000');
  assert.equal(selected.order_notional, '1500');
  assert.equal(selected.spread_limit, '0.0004');
  assert.equal(selected.cycle.symbol, 'XAGUSD1');
  assert.equal(
    selectPairSymbol({ ...draft(), order_notional: '2000.01' }, custom, catalog)
      .order_notional,
    '2000.01',
  );
  assert.throws(
    () =>
      parsePairDraft(
        { ...selected, order_notional: '749.999999999999999999' },
        accounts,
        [],
        undefined,
        [custom],
      ),
    /750/,
  );
});

test('saved silver groups keep their symbol and remain editable without a catalog', () => {
  const saved = {
    ...parsePairDraft(
      selectPairSymbol(draft(), silver, catalog),
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
  assert.equal(parsed.cycle.symbol, 'XAGUSD1');
  const changes = pairConfigurationChanges(parsed);
  assert.equal(changes.name, '白银组改名');
  assert.equal(changes.symbol, 'XAGUSD1');
  assert.equal(changes.cycle.symbol, 'XAGUSD1');
  assert.throws(
    () =>
      parsePairDraft(
        selectPairSymbol(edited, DEFAULT_PAIR_SYMBOL, catalog),
        accounts,
        [saved],
        saved.id,
        [],
      ),
    /支持的配对标的/,
  );
});

test('switching a saved pair preserves all settings and PATCH excludes its identity and activation', () => {
  const customSilver = {
    ...silver,
    default_order_notional: '1500',
    default_threshold: '12000',
    default_spread_limit: '0.0004',
  };
  const choices = [DEFAULT_PAIR_SYMBOL, customSilver];
  for (const mode of ['monitor', 'ordinary', 'cycle']) {
    const saved = {
      ...parsePairDraft(
        {
          ...draft(),
          name: '保留组名称',
          mode,
          margin_enabled: true,
          balance_threshold: '25.125',
          max_transfer: '2500',
          cycle: {
            ...draft().cycle,
            min_notional: '1600',
            max_notional: '2600',
            daily_volume_limit: '15000',
          },
        },
        accounts,
        [],
        undefined,
        choices,
      ),
      enabled: false,
    };
    const original = pairDraft(saved);
    const selected = selectPairSymbol(original, customSilver, choices, {
      applyDefaults: false,
    });
    assert.deepEqual(selected, {
      ...original,
      symbol: 'XAGUSD1',
      cycle: { ...original.cycle, symbol: 'XAGUSD1' },
    });
    assert.deepEqual(pairDraft(saved), original);
    const parsed = parsePairDraft(
      selected,
      accounts,
      [saved],
      saved.id,
      choices,
    );
    const request = JSON.parse(
      JSON.stringify(pairConfigurationChanges(parsed)),
    );
    assert.deepEqual(request, {
      name: saved.name,
      symbol: 'XAGUSD1',
      ordinary: saved.ordinary,
      cycle: { ...saved.cycle, symbol: 'XAGUSD1' },
      margin: saved.margin,
    });
    assert.equal(parsed.id, saved.id);
    assert.equal(parsed.long_account_id, saved.long_account_id);
    assert.equal(parsed.short_account_id, saved.short_account_id);
    assert.equal(
      parsePairDraft(
        selectPairSymbol(selected, DEFAULT_PAIR_SYMBOL, choices, {
          applyDefaults: false,
        }),
        accounts,
        [saved],
        saved.id,
        choices,
      ).symbol,
      'XAUUSD1',
    );
  }
});

test('saved pairs reject unknown changes and mismatched cycle symbols even in monitor mode', () => {
  const saved = {
    ...parsePairDraft(draft(), accounts, [], undefined, catalog),
    enabled: false,
  };
  for (const mode of ['monitor', 'ordinary', 'cycle']) {
    const original = { ...pairDraft(saved), mode };
    assert.throws(
      () =>
        parsePairDraft(
          {
            ...original,
            symbol: 'UNKNOWN',
            cycle: { ...original.cycle, symbol: 'UNKNOWN' },
          },
          accounts,
          [saved],
          saved.id,
          catalog,
        ),
      /支持的配对标的/,
    );
    assert.throws(
      () =>
        parsePairDraft(
          { ...original, symbol: 'XAGUSD1' },
          accounts,
          [saved],
          saved.id,
          catalog,
        ),
      /必须与配对组一致/,
    );
    assert.throws(
      () =>
        parsePairDraft(
          { ...original, cycle: { ...original.cycle, symbol: 'XAGUSD1' } },
          accounts,
          [saved],
          saved.id,
          [],
        ),
      /必须与配对组一致/,
    );
  }
});

test('pair/cycle mismatches and unknown symbols are rejected, including disabled cycles', () => {
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), symbol: 'XAGUSD1' },
        accounts,
        [],
        undefined,
        catalog,
      ),
    /必须与配对组一致/,
  );
  assert.throws(
    () =>
      parsePairDraft(
        { ...draft(), symbol: 'UNKNOWN' },
        accounts,
        [],
        undefined,
        catalog,
      ),
    /支持的配对标的/,
  );
  assert.throws(
    () => parseCycleDraft({ ...cycleDraft(), symbol: 'XAGUSD1' }),
    /支持的循环品种/,
  );
  for (const symbol of ['XAUUSD1', 'SPCXUSD1', 'CLUSD1'])
    assert.equal(parseCycleDraft({ ...cycleDraft(), symbol }).symbol, symbol);
});

test('legacy pair records and drafts without a symbol retain the gold default', () => {
  const oldDraft = draft();
  delete oldDraft.symbol;
  const config = parsePairDraft(oldDraft, accounts, []);
  delete config.symbol;
  const restored = pairDraft(config);
  assert.equal(restored.symbol, 'XAUUSD1');
  assert.equal(restored.cycle.symbol, 'XAUUSD1');
});

test('net quantities isolate gold and silver precisely and preserve unknown data', () => {
  const position = (symbol, side, qty) => ({ symbol, side, qty });
  const snapshots = {
    long: {
      positions: [
        position('XAUUSD1', 'LONG', '2'),
        position('XAGUSD1', 'LONG', '99.000000000000000001'),
      ],
    },
    short: {
      positions: [
        position('XAUUSD1', 'SHORT', '1'),
        position('XAGUSD1', 'SHORT', '99'),
      ],
    },
  };
  assert.equal(pairNetQuantity(snapshots, 'XAUUSD1'), '1');
  assert.equal(pairNetQuantity(snapshots, 'XAGUSD1'), '0.000000000000000001');
  assert.equal(pairNetQuantity({ long: snapshots.long }, 'XAGUSD1'), null);
  snapshots.short.positions[1].qty = 'unknown';
  assert.equal(pairNetQuantity(snapshots, 'XAGUSD1'), null);
  assert.equal(pairNetQuantity(snapshots, 'XAUUSD1'), '1');
});
