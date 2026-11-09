import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createExecutionExchangeClient, ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { createHyperliquidExecutionClient } from '../server/trading-hyperliquid-execution.mjs';
import { createRhLighterExecutionClient } from '../server/trading-rh-lighter-execution.mjs';
import { createExecutionPositionWatch } from '../server/trading-execution-position-watch.mjs';
import { createAnthropicWatch } from '../server/trading-anthropic-watch.mjs';

const NOW = Date.UTC(2026, 10, 9, 8);
const at = value => new Date(value).toISOString();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const isError = code => error => error instanceof ExecutionExchangeError && error.code === code && error.uncertain === false;
const cexKeys = { apiKey: 'fixture-observation-key', apiSecret: 'fixture-observation-secret', passphrase: 'fixture-observation-passphrase' };
// Only synthetic fixture credentials and wallet addresses are used here.
const owner = '0x' + 'ab'.repeat(20);
const agentKey = '0x0123456789012345678901234567890123456789012345678901234567890123';
const agent = new Wallet(agentKey).address.toLowerCase();
const hlKeys = { address: owner, agentKey };
const rhKeys = { address: owner, accountIndex: 12345, apiKeyIndex: 5, apiKey: 'c3'.repeat(40) };
const bnPermissions = portfolio => ({ enableReading: true, enableWithdrawals: false, enableInternalTransfer: false,
  permitsUniversalTransfer: false, enableMargin: false, enableVanillaOptions: false, enableSpotAndMarginTrading: false,
  enableFutures: !portfolio, enablePortfolioMarginTrading: portfolio, enableFixApiTrade: false });
const bnPosition = patch => ({ symbol: 'ANTHROPICUSDT', positionSide: 'BOTH', marginAsset: 'USDT', positionAmt: '-2.5',
  markPrice: '120', liquidationPrice: '180', entryPrice: '100', notional: '-300', unRealizedProfit: '-50', leverage: '5', marginType: 'isolated', ...patch });
const okxPosition = patch => ({ instId: 'ANTHROPIC-USDT-SWAP', instType: 'SWAP', posSide: 'net', mgnMode: 'cross', ccy: 'USDT',
  pos: '20', markPx: '120', liqPx: '80', avgPx: '100', upl: '10', lever: '5', notionalUsd: '99999', ...patch });
const okxRule = patch => ({ instId: 'ANTHROPIC-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live',
  ctValCcy: 'ANTHROPIC', ctVal: '0.1', ctMult: '0.25', tickSz: '0.01', lotSz: '1', minSz: '1', maxLmtSz: '100000', ...patch });
const hlPosition = (coin, patch) => ({ type: 'oneWay', position: { coin, szi: coin === 'io:ANTH' ? '-2.5' : '1',
  positionValue: coin === 'io:ANTH' ? '300' : '120', entryPx: '100', unrealizedPnl: '-50', liquidationPx: '180',
  leverage: { type: 'isolated', value: 5 }, marginUsed: '60', ...patch } });
const rhPosition = patch => ({ market_id: 7, symbol: 'ANTHROPIC', position: '2.5', sign: -1, position_value: '300',
  liquidation_price: '180.123456789012345678999', avg_entry_price: '100', unrealized_pnl: '-50', initial_margin_fraction: '20', margin_mode: 1, allocated_margin: '60', ...patch });

function harness(exchange, handler = () => undefined, { timeoutMs = 1000, accountMode = 'standard' } = {}) {
  let time = NOW, streamStarts = 0;
  const calls = [], signs = [];
  const state = { accountMode, uid: '1234567890123456789', dual: false };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url), payload = init.body ? JSON.parse(init.body) : Object.fromEntries(parsed.searchParams);
    const call = { url: parsed, path: parsed.pathname, init, payload };
    calls.push(call);
    const override = await handler(call, { state, advance: ms => { time += ms; }, calls });
    if (override instanceof Response) return override;
    let result = override;
    if (result === undefined) {
      if (exchange === 'binance') {
        if (call.path.endsWith('/apiRestrictions')) result = bnPermissions(state.accountMode === 'portfolio-margin');
        else if (call.path.endsWith('/accountConfig')) result = { canTrade: true, dualSidePosition: state.dual };
        else if (call.path === '/api/v3/account') result = { uid: state.uid };
        else if (call.path.endsWith('/positionRisk')) result = [bnPosition()];
        else if (call.path.endsWith('/openOrders')) result = [];
        else if (call.path.endsWith('/openAlgoOrders')) result = [{ symbol: 'ANTHROPICUSDT' }];
      } else if (exchange === 'okx') {
        if (call.path === '/api/v5/account/config') result = [{ uid: state.uid, acctLv: '2', posMode: state.dual ? 'long_short_mode' : 'net_mode', perm: 'read_only,trade' }];
        else if (call.path === '/api/v5/account/positions') result = [okxPosition()];
        else if (call.path === '/api/v5/public/instruments') result = [okxRule()];
        else if (call.path === '/api/v5/trade/orders-pending') result = [];
        else if (call.path === '/api/v5/trade/orders-algo-pending') result = [{ instId: 'ANTHROPIC-USDT-SWAP' }];
      } else if (exchange === 'hyperliquid') {
        if (payload.type === 'userRole') result = payload.user === agent ? { role: 'agent', data: { user: owner } } : { role: 'user' };
        else if (payload.type === 'clearinghouseState') result = { assetPositions: [hlPosition(payload.dex === 'io' ? 'io:ANTH' : 'xyz:ANT')] };
      } else if (exchange === 'rh-lighter') {
        if (call.path === '/api/v1/accountsByL1Address') result = { sub_accounts: [{ index: 12345, l1_address: owner }, { index: 12346, l1_address: owner }] };
        else if (call.path === '/api/v1/orderBooks') result = { order_books: [{ market_id: 7, symbol: 'ANTHROPIC', market_type: 'perp' }, { market_id: 8, symbol: 'ANTHROPIC', market_type: 'spot' }] };
        else if (call.path === '/api/v1/account') result = { accounts: [{ index: 12345, l1_address: owner, positions: [rhPosition()] }] };
        else if (call.path === '/api/v1/accountActiveOrders') result = { orders: [] };
      }
    }
    assert.notEqual(result, undefined, `unexpected request ${call.path} ${payload.type ?? ''}`);
    return json(exchange === 'okx' ? { code: '0', data: result } : exchange === 'rh-lighter' ? { code: 200, ...result } : result);
  };
  const base = { ErrorClass: ExecutionExchangeError, fetchImpl, now: () => time, timeoutMs };
  const client = exchange === 'hyperliquid' ? createHyperliquidExecutionClient(base)
    : exchange === 'rh-lighter' ? createRhLighterExecutionClient({ ...base,
      signer: { async authToken(params) { signs.push('authToken'); return { authToken: `${params.deadline}:${params.accountIndex}:${params.apiKeyIndex}:${'ab'.repeat(40)}` }; } },
      stream: { forget() {}, close() {}, async book() { streamStarts += 1; assert.fail('observation must not start a stream'); }, async order() { streamStarts += 1; assert.fail('observation must not start a stream'); } },
    }) : createExecutionExchangeClient(exchange, { ...base,
      binanceStreams: { forget() {}, close() {}, async ready() { streamStarts += 1; } },
    });
  return { client, calls, signs, state, advance: ms => { time += ms; }, get streamStarts() { return streamStarts; } };
}

function readOnlyCalls(h, exchange) {
  assert.equal(h.streamStarts, 0);
  assert.ok(h.signs.every(method => method === 'authToken'));
  const allowed = {
    binance: ['/sapi/v1/account/apiRestrictions', '/fapi/v1/accountConfig', '/papi/v1/um/accountConfig', '/api/v3/account', '/fapi/v3/positionRisk', '/papi/v1/um/positionRisk'],
    okx: ['/api/v5/account/config', '/api/v5/account/positions', '/api/v5/public/instruments'],
    'rh-lighter': ['/api/v1/accountsByL1Address', '/api/v1/orderBooks', '/api/v1/account'],
  };
  for (const call of h.calls) {
    if (exchange === 'hyperliquid') {
      assert.equal(call.path, '/info');
      assert.ok(['userRole', 'clearinghouseState'].includes(call.payload.type));
      assert.ok(!Object.hasOwn(call.payload, 'vaultAddress'));
    } else {
      assert.equal(call.init.method, 'GET');
      assert.ok(allowed[exchange].includes(call.path), call.path);
    }
    assert.equal(call.init.redirect, 'error');
  }
}

for (const accountMode of ['standard', 'portfolio-margin']) {
  test(`Binance ${accountMode} ANT observation binds verified UID and exact execution scope without order reads or stream startup`, async () => {
    const h = harness('binance', call => call.path.endsWith('/positionRisk') ? [bnPosition(accountMode === 'portfolio-margin' ? { marginAsset: undefined } : {})] : undefined, { accountMode });
    const result = await h.client.positionSnapshot(cexKeys, { accountMode });
    assert.deepEqual(result, { identity: h.state.uid, fetchedAt: at(NOW), positions: [{ symbol: 'ANTHROPICUSDT', side: 'short', quantity: '2.5', quantityUnit: 'ANTHROPIC',
      entryPrice: '100', markPrice: '120', notional: '300', unrealizedPnl: '-50', leverage: '5', marginMode: 'isolated', liquidationPrice: '180', liquidationKnown: true, riskFetchedAt: at(NOW) }] });
    const positionCall = h.calls.find(call => call.path.endsWith('/positionRisk'));
    assert.equal(positionCall.url.host, accountMode === 'standard' ? 'fapi.binance.com' : 'papi.binance.com');
    assert.equal(positionCall.payload.symbol, 'ANTHROPICUSDT');
    for (const call of h.calls) {
      const params = new URLSearchParams(call.url.search), signature = params.get('signature'); params.delete('signature');
      assert.equal(signature, createHmac('sha256', cexKeys.apiSecret).update(params.toString()).digest('hex'));
      assert.equal(call.init.headers['X-MBX-APIKEY'], cexKeys.apiKey);
    }
    assert.ok(!JSON.stringify(result).includes(cexKeys.apiKey));
    readOnlyCalls(h, 'binance');
    await assert.rejects(h.client.account(cexKeys, { accountMode, symbols: ['ANTHROPICUSDT'] }), isError('external_orders'));
  });
}

test('Binance observation never accepts missing UID and scopes cached identity to full credentials plus account mode', async () => {
  for (const uid of [undefined, null, '', '0', 'API-key-id', {}]) {
    const h = harness('binance'); h.state.uid = uid;
    await assert.rejects(h.client.positionSnapshot(cexKeys), isError('permissions'));
    assert.ok(!h.calls.some(call => call.path.endsWith('/positionRisk')));
    readOnlyCalls(h, 'binance');
  }
  const h = harness('binance');
  await h.client.positionSnapshot(cexKeys);
  h.state.accountMode = 'portfolio-margin'; h.state.uid = '222';
  assert.equal((await h.client.positionSnapshot(cexKeys, { accountMode: 'portfolio-margin' })).identity, '222');
  h.state.uid = '333';
  assert.equal((await h.client.positionSnapshot({ ...cexKeys, apiSecret: 'another-fixture-secret' }, { accountMode: 'portfolio-margin' })).identity, '333');
  assert.equal(h.calls.filter(call => call.path === '/api/v3/account').length, 3);
});

test('Binance snapshot uses the same native hedge side and quantity checks as execution', async () => {
  const h = harness('binance', call => call.path.endsWith('/positionRisk') ? [bnPosition({ positionSide: 'LONG', positionAmt: '3' }), bnPosition({ positionSide: 'SHORT', positionAmt: '-2' })] : undefined);
  h.state.dual = true;
  const result = await h.client.positionSnapshot(cexKeys);
  assert.deepEqual(result.positions.map(row => [row.side, row.quantity]), [['long', '3'], ['short', '2']]);
  for (const patch of [{ positionSide: 'LONG' }, { marginAsset: 'USDC' }, { symbol: 'CLUSDT' }, { positionAmt: undefined }]) {
    const invalid = harness('binance', call => call.path.endsWith('/positionRisk') ? [bnPosition(patch)] : undefined);
    await assert.rejects(invalid.client.positionSnapshot(cexKeys), error => ['account_mode', 'invalid_data'].includes(error.code));
  }
});

test('OKX observation includes both margin modes under its execution UID and multiplies native contract value exactly', async () => {
  const h = harness('okx', (call, control) => {
    if (call.path.endsWith('/positions')) return [okxPosition(), okxPosition({ mgnMode: 'isolated', pos: '-10' })];
    if (call.path.endsWith('/instruments')) { control.advance(12_000); return [okxRule()]; }
  });
  const result = await h.client.positionSnapshot(cexKeys, { accountMode: 'cross' });
  assert.equal(result.identity, h.state.uid); assert.equal(result.fetchedAt, at(NOW));
  assert.deepEqual(result.positions.map(row => [row.side, row.quantity, row.quantityUnit, row.contractSize, row.notional, row.marginMode, row.riskFetchedAt]),
    [['long', '20', '张', '0.025', '60', 'cross', at(NOW)], ['short', '10', '张', '0.025', '30', 'isolated', at(NOW)]]);
  assert.equal(result.positions[0].unrealizedPnl, '10');
  assert.ok(!JSON.stringify(result).includes(cexKeys.passphrase));
  readOnlyCalls(h, 'okx');
  await assert.rejects(h.client.account(cexKeys, { accountMode: 'cross', symbols: ['ANTHROPICUSDT'] }), isError('account_mode'));
});

test('OKX observation refuses unverified UID, duplicate positions, wrong contract and absent contract units', async () => {
  for (const patch of [{ ctVal: undefined }, { ctMult: undefined }, { ctValCcy: 'OTHER' }, { settleCcy: 'USDC' }, { instId: 'CL-USDT-SWAP' }]) {
    const h = harness('okx', call => call.path.endsWith('/instruments') ? [okxRule(patch)] : undefined);
    await assert.rejects(h.client.positionSnapshot(cexKeys), error => ['invalid_data', 'not_tradable'].includes(error.code));
    readOnlyCalls(h, 'okx');
  }
  for (const rows of [[okxPosition(), okxPosition()], [okxPosition({ instId: 'CL-USDT-SWAP' })]]) {
    const h = harness('okx', call => call.path.endsWith('/positions') ? rows : undefined);
    await assert.rejects(h.client.positionSnapshot(cexKeys), error => ['invalid_data', 'account_mode'].includes(error.code));
  }
  const h = harness('okx'); h.state.uid = undefined;
  await assert.rejects(h.client.positionSnapshot(cexKeys), isError('invalid_data'));
  assert.equal(h.calls.length, 1);
});

test('OKX hedge observation keeps long and short sizes and active strategies only block execution preflight', async () => {
  const h = harness('okx', call => call.path.endsWith('/positions') ? [okxPosition({ posSide: 'long', pos: '3' }), okxPosition({ posSide: 'short', pos: '2' })] : undefined);
  h.state.dual = true;
  const result = await h.client.positionSnapshot(cexKeys, { accountMode: 'isolated' });
  assert.deepEqual(result.positions.map(row => [row.side, row.quantity, row.marginMode]), [['long', '3', 'cross'], ['short', '2', 'cross']]);
  readOnlyCalls(h, 'okx');
  await assert.rejects(h.client.account(cexKeys, { accountMode: 'cross', symbols: ['ANTHROPICUSDT'] }), isError('external_orders'));
});

test('Hyperliquid observation verifies API wallet and ordinary master, reads only native HIP-3 states and keeps the oldest receipt', async () => {
  const h = harness('hyperliquid', async (call, control) => {
    if (call.payload.type === 'clearinghouseState' && call.payload.dex === 'xyz') {
      await new Promise(resolve => setImmediate(resolve));
      control.advance(12_000);
      return { assetPositions: [hlPosition('xyz:ANT'), hlPosition('io:ANTH'), hlPosition('xyz:OTHER')] };
    }
  });
  const result = await h.client.positionSnapshot(hlKeys);
  assert.equal(result.identity, owner); assert.equal(result.fetchedAt, at(NOW));
  assert.deepEqual(result.positions.map(row => [row.symbol, row.side, row.quantity, row.markPrice, row.riskFetchedAt]),
    [['io:ANTH', 'short', '2.5', '120', at(NOW)], ['xyz:ANT', 'long', '1', '120', at(NOW + 12_000)]]);
  assert.ok(result.positions.every(row => row.marginMode === 'isolated' && row.leverage === '5' && row.marginUsed === '60'));
  assert.ok(h.calls.filter(call => call.payload.type === 'clearinghouseState').every(call => call.payload.user === owner));
  assert.ok(!JSON.stringify(result).includes(agentKey));
  readOnlyCalls(h, 'hyperliquid');
});

test('Hyperliquid observation refuses agent ownership mismatches, vaults and subaccounts', async () => {
  for (const role of ['vault', 'subAccount']) {
    const h = harness('hyperliquid', call => call.payload.type === 'userRole' && call.payload.user === owner ? { role } : undefined);
    await assert.rejects(h.client.positionSnapshot(hlKeys), isError('account_mode'));
    assert.ok(!h.calls.some(call => call.payload.type === 'clearinghouseState'));
  }
  const h = harness('hyperliquid', call => call.payload.type === 'userRole' && call.payload.user === agent ? { role: 'agent', data: { user: '0x' + 'cd'.repeat(20) } } : undefined);
  await assert.rejects(h.client.positionSnapshot(hlKeys), isError('permissions'));
  readOnlyCalls(h, 'hyperliquid');
});

test('Hyperliquid observation refuses duplicate or non-one-way position evidence', async () => {
  for (const rows of [[hlPosition('io:ANTH'), hlPosition('io:ANTH')], [{ ...hlPosition('io:ANTH'), type: 'hedge' }]]) {
    const h = harness('hyperliquid', call => call.payload.type === 'clearinghouseState' ? { assetPositions: rows } : undefined);
    await assert.rejects(h.client.positionSnapshot(hlKeys, { symbols: ['io:ANTH'] }), error => ['invalid_data', 'account_mode'].includes(error.code));
  }
});

test('RH observation binds wallet plus exact child account, preserves native risk and never authorizes a trade', async () => {
  const h = harness('rh-lighter');
  const result = await h.client.positionSnapshot(rhKeys);
  assert.deepEqual(result, { identity: owner, accountIndex: 12345, fetchedAt: at(NOW), positions: [{ symbol: 'ANTHROPIC', side: 'short', quantity: '2.5', quantityUnit: 'ANTHROPIC',
    entryPrice: '100', markPrice: '120', notional: '300', unrealizedPnl: '-50', leverage: '5', marginMode: 'isolated', marginUsed: '60', liquidationPrice: '180.123456789012345678', liquidationKnown: true, riskFetchedAt: at(NOW) }] });
  const query = h.calls.find(call => call.path === '/api/v1/account').url.searchParams;
  assert.deepEqual(Object.fromEntries(query), { by: 'index', value: '12345' });
  assert.ok(!JSON.stringify(result).includes(rhKeys.apiKey));
  readOnlyCalls(h, 'rh-lighter');
  await h.client.verify(rhKeys);
  assert.equal(h.calls.filter(call => call.path === '/api/v1/accountActiveOrders').length, 1, 'observing a public account must not prime execution permission evidence');
  assert.equal(h.calls.filter(call => call.path === '/api/v1/accountsByL1Address').length, 2);
});

test('RH observation rejects a sibling child account, foreign owner and conflicting account identity', async () => {
  for (const patch of [{ index: 12346 }, { l1_address: '0x' + 'cd'.repeat(20) }, { account_index: 12346 }]) {
    const h = harness('rh-lighter', call => call.path === '/api/v1/account' ? { accounts: [{ index: 12345, l1_address: owner, positions: [rhPosition()], ...patch }] } : undefined);
    await assert.rejects(h.client.positionSnapshot(rhKeys), isError('permissions'));
    readOnlyCalls(h, 'rh-lighter');
  }
  const missing = harness('rh-lighter', call => call.path === '/api/v1/accountsByL1Address' ? { sub_accounts: [{ index: 12346, l1_address: owner }] } : undefined);
  await assert.rejects(missing.client.positionSnapshot(rhKeys), isError('permissions'));
  assert.equal(missing.calls.length, 1); assert.equal(missing.signs.length, 0);
});

test('RH observation requires the exact native market id and symbol pair', async () => {
  for (const patch of [{ symbol: 'OTHER' }, { symbol: undefined }, { market_id: 9 }, { market_id: undefined }, { sign: 0 }, { position: undefined }]) {
    const h = harness('rh-lighter', call => call.path === '/api/v1/account' ? { accounts: [{ index: 12345, l1_address: owner, positions: [rhPosition(patch)] }] } : undefined);
    await assert.rejects(h.client.positionSnapshot(rhKeys), isError('invalid_data'));
    readOnlyCalls(h, 'rh-lighter');
  }
});

for (const exchange of ['binance', 'okx', 'hyperliquid', 'rh-lighter']) {
  const credentials = exchange === 'hyperliquid' ? hlKeys : exchange === 'rh-lighter' ? rhKeys : cexKeys;
  test(`${exchange} optional observation fields remain null without fabricated zeros or rejecting a real position`, async () => {
    const h = harness(exchange, call => {
      if (exchange === 'binance' && call.path.endsWith('/positionRisk')) return [{ symbol: 'ANTHROPICUSDT', marginAsset: 'USDT', positionSide: 'BOTH', positionAmt: '1' }];
      if (exchange === 'okx' && call.path.endsWith('/positions')) return [{ instId: 'ANTHROPIC-USDT-SWAP', instType: 'SWAP', posSide: 'net', mgnMode: 'cross', pos: '1' }];
      if (exchange === 'hyperliquid' && call.payload.type === 'clearinghouseState') return { assetPositions: [{ type: 'oneWay', position: { coin: call.payload.dex === 'io' ? 'io:ANTH' : 'xyz:ANT', szi: '1' } }] };
      if (exchange === 'rh-lighter' && call.path === '/api/v1/account') return { accounts: [{ index: 12345, l1_address: owner, positions: [{ market_id: 7, symbol: 'ANTHROPIC', sign: 1, position: '1' }] }] };
    });
    const result = await h.client.positionSnapshot(credentials);
    assert.ok(result.positions.length > 0);
    for (const row of result.positions) {
      assert.equal(row.quantity, '1');
      for (const field of ['entryPrice', 'markPrice', 'notional', 'unrealizedPnl', 'leverage', 'liquidationPrice']) assert.equal(row[field], null, field);
      assert.equal(row.marginMode, exchange === 'okx' ? 'cross' : null);
      assert.equal(row.liquidationKnown, false);
      assert.equal(row.riskFetchedAt, at(NOW));
    }
    readOnlyCalls(h, exchange);
  });

  test(`${exchange} observation distinguishes explicit no-liquidation evidence from missing or malformed values without renewing risk time`, async () => {
    const validNone = ['0', '0.000000', ...(exchange === 'hyperliquid' ? [null] : exchange === 'okx' ? [''] : []),
      ...(exchange === 'rh-lighter' ? ['0.0000000000000000000000000'] : [])];
    const invalid = [undefined, 'invalid-liquidation', '-1', 0, 42, true, [], {}, 'NaN', 'Infinity', '1e2', ' 120', '0.0000000000000000001',
      ...(['binance', 'rh-lighter', 'okx'].includes(exchange) ? [null] : []), ...(exchange !== 'okx' ? [''] : [])];
    const highPrecision = '180.123456789012345678999';
    if (exchange !== 'rh-lighter') invalid.push(highPrecision);
    const cases = [...validNone.map(value => [value, true, null]), ...invalid.map(value => [value, false, null]), ['120.500', true, '120.5'],
      ...(exchange === 'rh-lighter' ? [[highPrecision, true, '180.123456789012345678']] : [])];
    for (const [value, known, price] of cases) {
      const h = harness(exchange, call => {
        if (exchange === 'binance' && call.path.endsWith('/positionRisk')) return [bnPosition({ liquidationPrice: value })];
        if (exchange === 'okx' && call.path.endsWith('/positions')) return [okxPosition({ liqPx: value })];
        if (exchange === 'hyperliquid' && call.payload.type === 'clearinghouseState') return { assetPositions: [hlPosition(call.payload.dex === 'io' ? 'io:ANTH' : 'xyz:ANT', { liquidationPx: value })] };
        if (exchange === 'rh-lighter' && call.path === '/api/v1/account') return { accounts: [{ index: 12345, l1_address: owner, positions: [rhPosition({ liquidation_price: value })] }] };
      });
      const result = await h.client.positionSnapshot(credentials);
      for (const row of result.positions) {
        assert.equal(row.liquidationKnown, known, `${exchange}: ${JSON.stringify(value)}`);
        assert.equal(row.liquidationPrice, price);
        assert.equal(row.markPrice, '120');
        assert.equal(row.riskFetchedAt, at(NOW), 'a validity flag does not change the actual sampling time');
      }
      assert.equal(result.fetchedAt, at(NOW));
      readOnlyCalls(h, exchange);
    }
  });

  test(`${exchange} observation limits symbols before IO and honors abort and bounded request timeout`, async () => {
    const h = harness(exchange);
    for (const symbols of [[], ['CLUSDT'], ['ANTHROPICUSDT', 'OTHER']]) await assert.rejects(h.client.positionSnapshot(credentials, { symbols }), isError('input'));
    assert.equal(h.calls.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.client.positionSnapshot(credentials, { signal: controller.signal }), isError('aborted'));
    assert.equal(h.calls.length, 0);
    const stalled = harness(exchange, () => new Promise(() => {}), { timeoutMs: 10 });
    await assert.rejects(stalled.client.positionSnapshot(credentials), isError('timeout'));
    assert.ok(stalled.calls.length <= 2, 'no unbounded retry');
  });
}

test('Bybit gains no ANT position observation capability', () => {
  const client = createExecutionExchangeClient('bybit');
  assert.equal(client.positionSnapshot, undefined);
  client.close();
});

test('RH disconnect while a position response is pending rejects the late snapshot', async () => {
  let release, started;
  const pending = new Promise(resolve => { started = resolve; });
  const h = harness('rh-lighter', call => call.path === '/api/v1/account' ? new Promise(resolve => { release = resolve; started(); }) : undefined);
  const result = h.client.positionSnapshot(rhKeys);
  await pending;
  h.client.forget();
  release({ accounts: [{ index: 12345, l1_address: owner, positions: [rhPosition()] }] });
  await assert.rejects(result, isError('aborted'));
});

test('real Hyperliquid adapter through position cache preserves liquidation alerts across malformed data and restart', async () => {
  const tempRoot = path.resolve(tmpdir());
  const dataDir = mkdtempSync(path.join(tempRoot, 'ant-liquidation-integration-'));
  const posts = [], warnings = [], venues = [];
  let current = NOW, liquidation = '110', venue, watch;
  const create = () => {
    venue = harness('hyperliquid', call => call.payload.type === 'clearinghouseState' ? { assetPositions: call.payload.dex === 'io'
      ? [hlPosition('io:ANTH', { szi: '-10', positionValue: '1000', liquidationPx: liquidation })] : [] } : undefined);
    venue.advance(current - NOW); venues.push(venue);
    const positions = createExecutionPositionWatch({ now: () => current,
      readConnections: () => [{ exchange: 'hyperliquid', connected: true, revision: 1, identity: owner, accountMode: 'agent' }],
      read: (exchange, binding, { signal }) => {
        assert.equal(exchange, 'hyperliquid'); assert.equal(binding.identity, owner);
        return venue.client.positionSnapshot(hlKeys, { accountMode: binding.accountMode, signal });
      },
    });
    watch = createAnthropicWatch({ dataDir, executionPositions: positions, now: () => current, intervalMs: 0,
      log: { warn: (...args) => warnings.push(args) },
      readCex: () => assert.fail('execution observations must not read independent CEX accounts'),
      readAddress: () => assert.fail('execution observations must not read independent wallets'),
      fetcher: async () => assert.fail('the watch must use the execution adapter and injected notification transport'),
      feishu: { alertChannel: () => ({ configured: true, title: 'Fixture liquidation alerts' }), postAlert: async card => posts.push(structuredClone(card)) },
      encrypt: value => ({ sealed: JSON.stringify(value) }), decrypt: value => JSON.parse(value.sealed),
    });
    watch.initialize();
  };
  const advance = ms => { current += ms; venue.advance(ms); };
  const row = () => watch.state().sources.find(source => source.exchange === 'hyperliquid').positions[0];
  const message = index => posts[index].elements[0].text.content;
  try {
    create();
    watch.save({ enabled: true, thresholdPercent: 20, repeatMinutes: 30 });
    await watch.poll();
    assert.equal(posts.length, 1); assert.equal(posts[0].header.template, 'red');
    assert.match(message(0), /🔴.*距强平 10\.00%/);
    assert.deepEqual([row().markPrice, row().liquidationPrice, row().liquidationKnown, row().alerting, row().riskUnknown], ['100', '110', true, true, false]);

    liquidation = 'invalid-liquidation'; advance(1000); await watch.poll();
    assert.deepEqual([row().markPrice, row().liquidationPrice, row().liquidationKnown, row().alerting, row().riskUnknown], ['100', null, false, true, true]);
    assert.equal(row().riskFetchedAt, at(current));
    assert.equal(posts.length, 2); assert.equal(posts[1].header.template, 'red');
    assert.match(message(1), /强平价缺失或无效.*保留预警/);
    assert.doesNotMatch(message(1), /🟢|解除预警|不再提供强平价/);

    advance(31 * 60_000); await watch.poll();
    assert.equal(posts.length, 2, 'persistent unknown liquidation risk does not repeat after the notification interval');
    await watch.close(); create(); await watch.poll();
    assert.equal(posts.length, 2, 'persisted unknown notice is not resent or cleared when adapter, cache and watch restart');
    assert.equal(row().alerting, true); assert.equal(row().riskUnknown, true);

    liquidation = null; advance(1000); await watch.poll();
    assert.deepEqual([row().markPrice, row().liquidationPrice, row().liquidationKnown, row().alerting, row().riskUnknown], ['100', null, true, false, false]);
    assert.equal(posts.length, 3); assert.equal(posts[2].header.template, 'green');
    assert.match(message(2), /🟢.*不再提供强平价.*解除预警/);
    assert.deepEqual(warnings, []);
    for (const adapter of venues) readOnlyCalls(adapter, 'hyperliquid');
  } finally {
    await watch?.close();
    assert.equal(path.dirname(path.resolve(dataDir)), tempRoot);
    assert.ok(path.basename(dataDir).startsWith('ant-liquidation-integration-'));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
