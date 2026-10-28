import test from 'node:test';
import assert from 'node:assert/strict';
import { CYCLE_MISMATCH, locateCycle, newestFirst, summarizeCycle } from '../lib/positions-cycle.ts';
import type { CycleFill } from '../lib/positions-cycle.ts';
import { position } from '../lib/positions-values.ts';
import { CycleRetry, readPositionCycle } from '../lib/positions-cycle-readers.ts';
import type { Credentials } from '../lib/validation.ts';

const at = Date.parse('2026-06-01T00:00:00.000Z');
const hour = 3_600_000, day = 24 * hour;
const fill = (id: string, time: number, side: 'buy' | 'sell', quantity: string, price: string, realizedPnl = '0', fee = '0', extra: Partial<CycleFill> = {}): CycleFill =>
  ({ id, time, side, quantity, price, realizedPnl, fee, feeCurrency: 'USDT', ...extra });
const base = { currency: 'USDT', cash: [], fundingAttributable: true, notes: [], updatedAt: new Date(at).toISOString() };

test('a cycle starts at the fill that opened the position from zero and sums only its closes', () => {
  const fills = [fill('3', at - hour, 'buy', '1', '105', '0', '-0.05'), fill('2', at - 2 * hour, 'sell', '1', '110', '10', '-0.1'), fill('1', at - 3 * hour, 'buy', '3', '100', '0', '-0.3'),
    fill('0', at - 4 * hour, 'sell', '4', '90', '-2', '-0.4')].sort(newestFirst);
  const located = locateCycle('3', fills);
  assert.deepEqual(located, { index: 2, openingFraction: null });
  const cycle = summarizeCycle({ ...base, current: '3', fills: fills.slice(0, 3), complete: true, openingFraction: null, since: at - 3 * hour,
    cash: [{ id: 'f1', time: at - 90 * 60_000, kind: 'funding', amount: '-0.25', currency: 'USDT' }, { id: 'f0', time: at - 5 * hour, kind: 'funding', amount: '9', currency: 'USDT' }] });
  assert.equal(cycle.status, 'complete'); assert.equal(cycle.closedQuantity, '1'); assert.equal(cycle.closePrice, '110');
  assert.equal(cycle.realizedPnl, '10'); assert.equal(cycle.fees, '-0.45'); assert.equal(cycle.funding, '-0.25'); assert.equal(cycle.net, '9.3');
  assert.equal(cycle.since, new Date(at - 3 * hour).toISOString()); assert.equal(cycle.note, null);
});

test('a fill that flips the position contributes only its opening share of fees and none of its realized PnL', () => {
  const fills = [fill('2', at - hour, 'sell', '1', '120', '4', '-0.1'), fill('1', at - 2 * hour, 'buy', '5', '100', '-7', '-1')];
  const located = locateCycle('2', fills);
  assert.deepEqual(located, { index: 1, openingFraction: '0.6' });
  const cycle = summarizeCycle({ ...base, current: '2', fills, complete: true, openingFraction: located!.openingFraction, since: fills[1].time });
  assert.equal(cycle.closedQuantity, '1'); assert.equal(cycle.realizedPnl, '4'); assert.equal(cycle.fees, '-0.7'); assert.equal(cycle.net, '3.3');
});

test('a short cycle, partial lookback, foreign fee currency and replay mismatch are explicit', () => {
  const short = [fill('2', at - hour, 'buy', '0.5', '80', '1.5'), fill('1', at - 2 * hour, 'sell', '2', '83')];
  const located = locateCycle('-1.5', short);
  assert.equal(located?.index, 1);
  const cycle = summarizeCycle({ ...base, current: '-1.5', fills: short, complete: true, openingFraction: null, since: short[1].time });
  assert.equal(cycle.closedQuantity, '0.5'); assert.equal(cycle.closePrice, '80'); assert.equal(cycle.realizedPnl, '1.5');
  const partial = summarizeCycle({ ...base, current: '-1.5', fills: [{ ...short[0], feeCurrency: 'BNB', fee: '-0.001' }], complete: false, openingFraction: null, since: at - 85 * day });
  assert.equal(partial.status, 'partial'); assert.equal(partial.closedQuantity, '0.5'); assert.equal(partial.fees, null); assert.equal(partial.net, null);
  assert.match(partial.note!, /其他币种/); assert.match(partial.note!, /85 天/);
  assert.equal(locateCycle('3', [fill('1', at, 'buy', '1', '1')]), null);
  assert.throws(() => summarizeCycle({ ...base, current: '-1.5', fills: [{ ...short[0], sizeAfter: '-1' }, short[1]], complete: true, openingFraction: null, since: short[1].time }), { message: CYCLE_MISMATCH });
  const unattributed = summarizeCycle({ ...base, current: '-1.5', fills: short, complete: true, openingFraction: null, since: short[1].time, fundingAttributable: false });
  assert.equal(unattributed.funding, null); assert.equal(unattributed.net, null); assert.match(unattributed.note!, /资金费无法拆分/);
});

const keys = { apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' };
const held = (side: 'long' | 'short', quantity: string, symbol = 'BTCUSDT', unit = 'BTC', currency = 'USDT') => ({ ...position(symbol, side, quantity, unit), pnlCurrency: currency });
function mock(handler: (url: URL) => unknown) {
  const calls: URL[] = [];
  const fetcher = (async (url: string | URL) => { const parsed = new URL(String(url)); calls.push(parsed); return Response.json(await handler(parsed)); }) as typeof fetch;
  return { fetcher, calls };
}
const inRange = (url: URL, time: number) => time >= Number(url.searchParams.get('startTime') ?? url.searchParams.get('begin') ?? 0)
  && time <= Number(url.searchParams.get('endTime') ?? url.searchParams.get('end') ?? Infinity);

test('Binance walks weekly windows back to the opening fill, follows the hedge side and reads funding from the opening', async () => {
  const trades = [
    { symbol: 'BTCUSDT', id: 5, side: 'SELL', positionSide: 'LONG', price: '110', qty: '1', realizedPnl: '10', commission: '0.11', commissionAsset: 'USDT', time: at - day },
    { symbol: 'BTCUSDT', id: 4, side: 'SELL', positionSide: 'SHORT', price: '109', qty: '1', realizedPnl: '0', commission: '0.1', commissionAsset: 'USDT', time: at - 2 * day },
    { symbol: 'BTCUSDT', id: 3, side: 'BUY', positionSide: 'LONG', price: '100', qty: '3', realizedPnl: '0', commission: '0.3', commissionAsset: 'USDT', time: at - 9 * day },
  ];
  const income = [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: '-0.2', asset: 'USDT', time: at - 3 * day, tranId: 1 }];
  for (const scope of ['um', 'pm-um']) {
    const { fetcher, calls } = mock(url => url.pathname.endsWith('userTrades') ? trades.filter(row => inRange(url, row.time)) : income.filter(row => inRange(url, row.time)));
    const cycle = await readPositionCycle({ exchange: 'binance', ...keys }, scope, { position: held('long', '2'), siblings: [], snapshotAt: at }, { fetcher, now: () => at, spacing: false });
    const tradeCalls = calls.filter(url => url.pathname.endsWith('userTrades'));
    assert.equal(tradeCalls.length, 2, 'stops after the window holding the opening fill');
    assert.equal(tradeCalls[0].hostname, scope === 'um' ? 'fapi.binance.com' : 'papi.binance.com');
    for (const url of calls) assert.ok(Number(url.searchParams.get('endTime')) - Number(url.searchParams.get('startTime')) < 7 * day);
    assert.equal(calls.find(url => url.pathname.endsWith('income'))!.searchParams.get('startTime'), String(at - 9 * day));
    assert.equal(cycle.status, 'complete'); assert.equal(cycle.closedQuantity, '1'); assert.equal(cycle.realizedPnl, '10');
    assert.equal(cycle.fees, '-0.41'); assert.equal(cycle.funding, null, 'an opposite leg traded during the cycle'); assert.match(cycle.note!, /资金费无法拆分/);
  }
});

test('Binance one-way funding is attributed, fresh fills ask for a retry and errors become a sanitized note', async () => {
  const trades = [{ symbol: 'ETHUSDT', id: 1, side: 'SELL', positionSide: 'BOTH', price: '3000', qty: '2', realizedPnl: '0', commission: '0.6', commissionAsset: 'USDT', time: at - hour }];
  const income = [{ symbol: 'ETHUSDT', incomeType: 'FUNDING_FEE', income: '0.3', asset: 'USDT', time: at - 30 * 60_000, tranId: 9 }];
  const handler = (url: URL) => url.pathname.endsWith('userTrades') ? trades.filter(row => inRange(url, row.time)) : income.filter(row => inRange(url, row.time));
  const request = { position: held('short', '2', 'ETHUSDT', 'ETH'), siblings: [], snapshotAt: at };
  const credential: Credentials = { exchange: 'binance', ...keys };
  const cycle = await readPositionCycle(credential, 'um', request, { fetcher: mock(handler).fetcher, now: () => at, spacing: false });
  assert.equal(cycle.closedQuantity, '0'); assert.equal(cycle.closePrice, null); assert.equal(cycle.fees, '-0.6'); assert.equal(cycle.funding, '0.3'); assert.equal(cycle.net, '-0.3');
  await assert.rejects(readPositionCycle(credential, 'um', { ...request, snapshotAt: at - hour }, { fetcher: mock(handler).fetcher, now: () => at, spacing: false }), CycleRetry);
  const failed = await readPositionCycle(credential, 'um', request, { fetcher: mock(() => ({ code: -1, msg: 'PRIVATE upstream detail' })).fetcher, now: () => at, spacing: false });
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.realizedPnl, null); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  const mismatch = await readPositionCycle(credential, 'um', { ...request, position: held('short', '3', 'ETHUSDT', 'ETH') }, { fetcher: mock(handler).fetcher, now: () => at, spacing: false });
  assert.equal(mismatch.status, 'partial', 'no zero crossing within the lookback');
  assert.equal((await readPositionCycle(credential, 'cm', request, { now: () => at })).status, 'unavailable');
});

test('an int64 Binance funding tranId still counts, and malformed fills get a format note rather than a mismatch', async () => {
  const trades = [{ symbol: 'ETHUSDT', id: 1, side: 'SELL', positionSide: 'BOTH', price: '3000', qty: '2', realizedPnl: '0', commission: '0.6', commissionAsset: 'USDT', time: at - hour }];
  // 2^60 is serialized exactly but JSON.parse rounds it to an unsafe number.
  const income = [{ symbol: 'ETHUSDT', incomeType: 'FUNDING_FEE', income: '0.3', asset: 'USDT', time: at - 30 * 60_000, tranId: 2 ** 60 }];
  const request = { position: held('short', '2', 'ETHUSDT', 'ETH'), siblings: [], snapshotAt: at };
  const credential: Credentials = { exchange: 'binance', ...keys };
  const read = (rows: unknown[]) => readPositionCycle(credential, 'um', request, { fetcher: mock(url => url.pathname.endsWith('userTrades') ? rows : income.filter(row => inRange(url, row.time))).fetcher, now: () => at, spacing: false });
  const cycle = await read(trades);
  assert.equal(cycle.status, 'complete'); assert.equal(cycle.funding, '0.3');
  const malformed = await read([{ ...trades[0], price: 3000 }]);
  assert.equal(malformed.status, 'unavailable'); assert.match(malformed.note!, /格式无法识别/);
});
test('Bybit reads the unified ledger with cursor pages, checks each post-trade size and counts settlement funding', async () => {
  const row = (id: string, time: number, extra: Record<string, unknown>) => ({ id, symbol: 'SOLUSDT', category: 'linear', currency: 'USDT', transactionTime: String(time), ...extra });
  const ledger = [
    row('4', at - hour, { type: 'SETTLEMENT', side: 'None', funding: '1.2E-1', cashFlow: '0', fee: '0' }),
    row('3', at - 2 * hour, { type: 'TRADE', side: 'Buy', qty: '4', size: '-6', tradePrice: '150', cashFlow: '20', fee: '0.06', funding: '' }),
    row('2', at - 3 * hour, { type: 'TRADE', side: 'Sell', qty: '10', size: '-10', tradePrice: '155', cashFlow: '0', fee: '0.15', funding: '' }),
    row('1', at - 4 * hour, { type: 'TRANSFER_IN', side: 'None', qty: '', size: '', cashFlow: '100', fee: '0', funding: '' }),
  ];
  const { fetcher, calls } = mock(url => {
    assert.equal(url.pathname, '/v5/account/transaction-log'); assert.equal(url.searchParams.get('accountType'), 'UNIFIED'); assert.equal(url.searchParams.get('baseCoin'), 'SOL');
    const page = url.searchParams.get('cursor') ? ledger.slice(2) : ledger.slice(0, 2);
    return { retCode: 0, result: { list: page, nextPageCursor: url.searchParams.get('cursor') ? '' : 'next' } };
  });
  const request = { position: held('short', '6', 'SOLUSDT', 'SOL'), siblings: [], snapshotAt: at };
  const cycle = await readPositionCycle({ exchange: 'bybit', ...keys, region: 'global' }, 'linear-usdt', request, { fetcher, now: () => at, spacing: false });
  assert.equal(calls.length, 2);
  assert.equal(cycle.status, 'complete'); assert.equal(cycle.closedQuantity, '4'); assert.equal(cycle.closePrice, '150');
  assert.equal(cycle.realizedPnl, '20'); assert.equal(cycle.fees, '-0.21'); assert.equal(cycle.funding, '0.12'); assert.equal(cycle.net, '19.91');
  const wrong = mock(() => ({ retCode: 0, result: { list: [{ ...ledger[1], size: '-5' }, ledger[2]], nextPageCursor: '' } }));
  assert.match((await readPositionCycle({ exchange: 'bybit', ...keys, region: 'global' }, 'linear-usdt', request, { fetcher: wrong.fetcher, now: () => at, spacing: false })).note!, /对不上/);
  const hedged = await readPositionCycle({ exchange: 'bybit', ...keys, region: 'global' }, 'linear-usdt', { ...request, siblings: [held('long', '1', 'SOLUSDT', 'SOL')] }, { fetcher, now: () => at, spacing: false });
  assert.equal(hedged.status, 'unavailable'); assert.match(hedged.note!, /多空两边/);
});

test('OKX pages fills by billId until the opening fill and reads funding bills from the opening', async () => {
  const fills = [
    { instId: 'BTC-USDT-SWAP', billId: '30', ts: String(at - hour), side: 'buy', posSide: 'net', fillSz: '1', fillPx: '60000', fillPnl: '30', fee: '-0.3', feeCcy: 'USDT' },
    { instId: 'BTC-USDT-SWAP', billId: '20', ts: String(at - 2 * hour), side: 'sell', posSide: 'net', fillSz: '3', fillPx: '61000', fillPnl: '0', fee: '-0.9', feeCcy: 'USDT' },
  ];
  const bills = [{ instId: 'BTC-USDT-SWAP', billId: '7', ts: String(at - 90 * 60_000), type: '8', subType: '174', pnl: '0.4', ccy: 'USDT' }];
  const { fetcher, calls } = mock(url => ({ code: '0', data: url.pathname.endsWith('fills-history') ? fills.filter(row => !url.searchParams.get('after') || BigInt(row.billId) < BigInt(url.searchParams.get('after')!)) : bills }));
  const cycle = await readPositionCycle({ exchange: 'okx', ...keys, passphrase: 'synthetic' }, 'SWAP', { position: held('short', '2', 'BTC-USDT-SWAP', '张（BTC/张）'), siblings: [], snapshotAt: at }, { fetcher, now: () => at, spacing: false });
  assert.deepEqual(calls.map(url => url.pathname), ['/api/v5/trade/fills-history', '/api/v5/account/bills-archive']);
  assert.equal(calls[1].searchParams.get('begin'), String(at - 2 * hour)); assert.equal(calls[1].searchParams.get('type'), '8');
  assert.equal(cycle.closedQuantity, '1'); assert.equal(cycle.closePrice, '60000'); assert.equal(cycle.realizedPnl, '30');
  assert.equal(cycle.fees, '-1.2'); assert.equal(cycle.funding, '0.4'); assert.equal(cycle.net, '29.2');
});

test('fills and funding stamped ahead of the local clock are still read, so the cycle retries or counts them', async () => {
  const ahead = at + 30_000, opts = (fetcher: typeof fetch) => ({ fetcher, now: () => at, spacing: false });
  const trade = (id: number, time: number) => ({ symbol: 'ETHUSDT', id, side: 'BUY', positionSide: 'BOTH', price: '3000', qty: '1', realizedPnl: '0', commission: '0.3', commissionAsset: 'USDT', time });
  const trades = [trade(2, ahead), trade(1, at - hour)];
  const binance = mock(url => url.pathname.endsWith('userTrades') ? trades.filter(row => inRange(url, row.time)) : []);
  await assert.rejects(readPositionCycle({ exchange: 'binance', ...keys }, 'um', { position: held('long', '2', 'ETHUSDT', 'ETH'), siblings: [], snapshotAt: at }, opts(binance.fetcher)), CycleRetry);
  assert.equal(binance.calls[0].searchParams.get('endTime'), null, 'the newest trade window has no local upper bound');

  const row = (id: string, time: number, size: string) => ({ id, symbol: 'SOLUSDT', category: 'linear', currency: 'USDT', transactionTime: String(time), type: 'TRADE', side: 'Buy', qty: '1', size, tradePrice: '150', cashFlow: '0', fee: '0.01', funding: '' });
  const ledger = [row('2', ahead, '2'), row('1', at - hour, '1')];
  const bybit = mock(url => ({ retCode: 0, result: { list: ledger.filter(item => inRange(url, Number(item.transactionTime))), nextPageCursor: '' } }));
  await assert.rejects(readPositionCycle({ exchange: 'bybit', ...keys, region: 'global' }, 'linear-usdt', { position: held('long', '2', 'SOLUSDT', 'SOL'), siblings: [], snapshotAt: at }, opts(bybit.fetcher)), CycleRetry);
  assert.equal(bybit.calls[0].searchParams.get('endTime'), null);

  const okxFill = (billId: string, ts: number) => ({ instId: 'BTC-USDT-SWAP', billId, ts: String(ts), side: 'buy', posSide: 'net', fillSz: '1', fillPx: '60000', fillPnl: '0', fee: '-0.3', feeCcy: 'USDT' });
  const okx = (fills: unknown[]) => mock(url => {
    const before = (ts: string) => !url.searchParams.get('end') || Number(ts) < Number(url.searchParams.get('end'));
    const bills = [{ instId: 'BTC-USDT-SWAP', billId: '7', ts: String(ahead), type: '8', subType: '174', pnl: '0.4', ccy: 'USDT' }];
    return { code: '0', data: (url.pathname.endsWith('fills-history') ? fills as { ts: string }[] : bills).filter(item => before(item.ts)) };
  });
  const credential: Credentials = { exchange: 'okx', ...keys, passphrase: 'synthetic' };
  const okxRequest = (quantity: string) => ({ position: held('long', quantity, 'BTC-USDT-SWAP', '张（BTC/张）'), siblings: [], snapshotAt: at });
  const funded = await readPositionCycle(credential, 'SWAP', okxRequest('1'), opts(okx([okxFill('10', at - hour)]).fetcher));
  assert.equal(funded.status, 'complete'); assert.equal(funded.funding, '0.4', 'a funding bill stamped ahead of our clock is counted');
  await assert.rejects(readPositionCycle(credential, 'SWAP', okxRequest('2'), opts(okx([okxFill('11', ahead), okxFill('10', at - hour)]).fetcher)), CycleRetry);
});

test('same-millisecond fills keep execution order by numeric id, or by listing order otherwise', () => {
  const numeric = [fill('9', at, 'buy', '2', '100'), fill('10', at, 'sell', '1', '101', '1')].sort(newestFirst);
  assert.deepEqual(numeric.map(item => item.id), ['10', '9']);
  assert.deepEqual(locateCycle('1', numeric), { index: 1, openingFraction: null });
  const listed = [fill('b', at, 'buy', '2', '100', '0', '0', { order: 1 }), fill('a', at, 'sell', '1', '101', '1', '0', { order: 0 })].sort(newestFirst);
  assert.deepEqual(listed.map(item => item.id), ['a', 'b']);
});

test('OKX refuses a summary when cross and isolated positions share a contract and side', async () => {
  const { fetcher, calls } = mock(() => ({ code: '0', data: [] }));
  const own = { ...held('long', '1', 'ETH-USDT-SWAP', '张（ETH/张）'), id: 'cross' }, other = { ...own, id: 'isolated' };
  const cycle = await readPositionCycle({ exchange: 'okx', ...keys, passphrase: 'synthetic' }, 'SWAP', { position: own, siblings: [own, other], snapshotAt: at }, { fetcher, now: () => at, spacing: false });
  assert.equal(cycle.status, 'unavailable'); assert.match(cycle.note!, /同向仓位/); assert.equal(calls.length, 0);
});
