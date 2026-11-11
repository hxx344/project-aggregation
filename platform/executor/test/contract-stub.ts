// Preloaded by test/contract.test.ts (`node --import`): replaces fetch with small stateful
// stand-ins for the two venues so the probes' whole flow runs without a network. Every request
// is appended to CONTRACT_STUB_LOG as "METHOD path". The stand-ins follow the shapes the old
// clients parse; they prove the scripts' control flow, not the venues' behaviour.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } });
const accounts: { master: string; a: string; b: string } = JSON.parse(process.env.CONTRACT_STUB_ACCOUNTS ?? '{"master":"","a":"","b":""}');

const faults = new Set((process.env.CONTRACT_STUB_FAULT ?? '').split(',').filter(Boolean));
// The probe's waits run on this clock (see the seam at the end): each pause moves it forward instead of passing,
// so the probe's polls, deadlines and timestamps and the stand-ins' own time checks see the intervals a real run would.
// The report's `at` fields and the stand-ins' `date` header come from `new Date()` and stay on real time; nothing decides on them.
let skewMs = 0;
const wallClock = Date.now.bind(Date);
Date.now = () => wallClock() + skewMs;
const UNIT = 100_000_000n;
const toUnits = (value: string): bigint => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * UNIT + BigInt(fraction.padEnd(8, '0')); };
const fromUnits = (value: bigint): string => { const sign = value < 0n ? '-' : '', size = value < 0n ? -value : value; return sign + (size / UNIT) + '.' + String(size % UNIT).padStart(8, '0'); };

const aster = {
  balances: new Map<string, bigint>([[accounts.a.toLowerCase(), 100n * UNIT], [accounts.b.toLowerCase(), 50n * UNIT]]),
  income: new Map<string, Row[]>([[accounts.a.toLowerCase(), []], [accounts.b.toLowerCase(), []]]),
  ids: new Map<string, number>([[accounts.a.toLowerCase(), 10], [accounts.b.toLowerCase(), 20]]),
  sequence: 0,
  nonceWindowMs: Number(process.env.CONTRACT_STUB_NONCE_WINDOW_MS ?? 60_000),
  lastNonce: new Map<string, number>(),
};

function asterReply(method: string, path: string, parameters: URLSearchParams): Response {
  const user = (parameters.get('user') ?? '').toLowerCase();
  if (path === '/fapi/v3/time') return json({ serverTime: Date.now() });
  if (path === '/fapi/v3/getSubAccountList') return json([{ accountId: 1, parentAccount: true, address: accounts.master }, { accountId: 10, parentAccount: false, address: accounts.a, status: 'NORMAL' }, { accountId: 20, parentAccount: false, address: accounts.b, status: 'NORMAL' }]);
  if (path === '/fapi/v3/accountWithJoinMargin') {
    const value = fromUnits(aster.balances.get(user)!);
    return json({ accountId: aster.ids.get(user), canTrade: true, positions: faults.has('aster-positions') ? [{ symbol: 'XUSD1', positionAmt: '1' }] : [{ symbol: 'XUSD1', positionAmt: '0' }],
      assets: [{ asset: 'USDT', walletBalance: '7' }, { asset: 'USD1', walletBalance: value, availableBalance: value, maxWithdrawAmount: value, marginBalance: value, updateTime: Date.now() }] });
  }
  if (path === '/fapi/v3/income') {
    const start = Number(parameters.get('startTime')), end = parameters.has('endTime') ? Number(parameters.get('endTime')) : Infinity;
    return json((aster.income.get(user) ?? []).filter(row => (row.time as number) >= start && (row.time as number) <= end));
  }
  if (method === 'POST' && path === '/fapi/v3/subAccountTransfer') {
    if (faults.has('aster-429')) return json({ msg: 'too many requests' }, 429);
    // Stand-in rule only: a nonce outside the window is refused, with a code the old client does not list.
    const signer = parameters.get('signer')!, nonce = Number(parameters.get('nonce'));
    if (Math.abs(nonce / 1000 - Date.now()) > aster.nonceWindowMs) return json({ code: -1021, msg: 'nonce out of window' }, 400);
    // And each signer's accepted nonces must increase.
    if (nonce <= (aster.lastNonce.get(signer) ?? 0)) return json({ code: -1021, msg: 'nonce not increasing' }, 400);
    aster.lastNonce.set(signer, nonce);
    const from = parameters.get('fromAccountAddress')!, to = parameters.get('toAccountAddress')!, value = toUnits(parameters.get('amount')!), tranId = 't' + ++aster.sequence, time = Date.now();
    aster.balances.set(from, aster.balances.get(from)! - value);
    aster.balances.set(to, aster.balances.get(to)! + value);
    aster.income.get(from)!.push({ asset: 'USD1', incomeType: 'TRANSFER', income: fromUnits(-value), time, tranId, symbol: '' });
    aster.income.get(to)!.push({ asset: 'USD1', incomeType: 'TRANSFER', income: fromUnits(value), time, tranId, symbol: '' });
    return json({ code: 200, msg: 'success', tranId });
  }
  return json({ code: -1000, msg: 'unexpected ' + path }, 400);
}

const bybit = { strategies: new Map<string, Row>(), children: new Map<string, Row[]>(), position: 0, orders: 0, creates: 0, stops: 0 };
const hedge = faults.has('bybit-hedge'), ownIdx = hedge ? 1 : 0;const ok = (result: unknown): Response => json({ retCode: 0, retMsg: 'OK', result, time: Date.now() });
const refused = (retCode: number, retMsg: string): Response => json({ retCode, retMsg, result: {}, time: Date.now() });

function bybitReply(method: string, path: string, parameters: URLSearchParams, body: Row, headers: Headers): Response {
  const stamp = String(Date.now());
  if (path === '/v5/market/time') return ok({ timeSecond: stamp.slice(0, -3), timeNano: stamp + '000000' });
  if (path === '/v5/user/query-api') return ok({ readOnly: 0, apiKey: headers.get('x-bapi-api-key'), userID: 7654321, permissions: { ContractTrade: ['Order', 'Position'], Wallet: [], Spot: [], Options: [], Derivatives: ['DerivativesTrade'] } });
  if (path === '/v5/account/info') return ok({ unifiedMarginStatus: 5 });
  if (path === '/v5/market/instruments-info') return ok({ category: 'linear', list: [{ symbol: parameters.get('symbol'), status: 'Trading', lotSizeFilter: { minOrderQty: '0.02', qtyStep: '0.01', minNotionalValue: '5' }, priceFilter: { tickSize: '0.01' } }] });
  if (path === '/v5/market/orderbook') return ok({ s: parameters.get('symbol'), b: [['60.00', '10']], a: [['60.01', '10']] });
  if (path === '/v5/position/list') return ok({ category: 'linear', list: [{ symbol: parameters.get('symbol'), positionIdx: ownIdx, side: bybit.position > 0 ? 'Buy' : '', size: bybit.position.toFixed(2) },
    ...(hedge ? [{ symbol: parameters.get('symbol'), positionIdx: 2, side: '', size: '0.00' }] : [])], nextPageCursor: '' });
  if (path === '/v5/order/realtime') return ok({ category: 'linear', list: [...bybit.children.values()].flat().filter(child => child.status === 2).map(child => ({ orderId: child.orderId, orderLinkId: '', qty: child.size, orderStatus: 'New', positionIdx: ownIdx })), nextPageCursor: '' });
  if (path === '/v5/strategy/list') {
    if (faults.has('bybit-list-fail') && parameters.get('status') === '5' && bybit.strategies.size > 0) return refused(10016, 'server error');
    const begin = parameters.has('beginTimeE0') ? Number(parameters.get('beginTimeE0')) : -Infinity, end = parameters.has('endTimeE0') ? Number(parameters.get('endTimeE0')) : Infinity;
    return ok({ list: [...bybit.strategies.values()].filter(row => (!parameters.has('strategyId') || row.strategyId === parameters.get('strategyId')) && (!parameters.has('status') || String(row.status) === parameters.get('status'))
      && Math.floor(Number(row.createdTimeE3) / 1000) >= begin && Math.floor(Number(row.createdTimeE3) / 1000) <= end), nextCursor: '' });
  }
  if (path === '/v5/strategy/order-list') return ok({ list: bybit.children.get(parameters.get('strategyId') ?? '') ?? [], nextCursor: '' });
  if (method === 'POST' && path === '/v5/strategy/create') {
    if (Math.abs(Number(headers.get('x-bapi-timestamp')) - Date.now()) > 5_000) return refused(10002, 'invalid request, please check your server timestamp');
    if (Number(body.size) < 0.02) return refused(10001, 'size too small');
    if (body.positionIdx !== ownIdx) return refused(10001, 'position idx not match position mode');
    // As the venue answered on 2026-11-12; the other spellings are refused only on request.
    if (body.chaseDistance === '0' || 'chasePercentE4' in body && faults.has('bybit-percent-refused') || !('chaseDistance' in body) && !('chasePercentE4' in body) && faults.has('bybit-plain-refused'))
      return refused(10001, 'chaseOrder chase_distance params error');
    bybit.creates++; effective = true;
    const add = (size: string, maxChasePrice: unknown, side: unknown = body.side): string => {
      const strategyId = randomUUID(), fills = Number(maxChasePrice) >= 60.01;
      bybit.strategies.set(strategyId, { strategyId, category: 'UTA_USDT', symbol: body.symbol, strategyType: 'chaseOrder', side, size, executedSize: fills ? size : '0', executedAvgPrice: fills ? '60.01' : '0',
        chaseOrderPrice: fills ? '60.01' : faults.has('bybit-rests-at-bid') ? '60' : String(maxChasePrice), status: fills ? 3 : 2, reduceOnly: body.reduceOnly, createdTimeE3: stamp, updatedTimeE3: stamp });
      bybit.children.set(strategyId, [{ strategyId, symbol: body.symbol, side, orderId: 'o' + ++bybit.orders, orderType: 2, positionIdx: body.positionIdx, size, executedSize: fills ? size : '0', status: fills ? 5 : 2 }]);
      if (fills) bybit.position += Number(size);
      return strategyId;
    };
    // Somebody else's strategies that start at the same moment: another quantity, and the same quantity on the sell side.
    if (bybit.creates === 1 && faults.has('bybit-foreign-on-create')) { add('0.5', body.maxChasePrice); add(String(body.size), body.maxChasePrice, 'Sell'); }
    const strategyId = add(String(body.size), body.maxChasePrice);
    // The gateway blocks the reply of a create that did run.
    if (bybit.creates === 2 && faults.has('bybit-429-create')) return json({ retMsg: 'too many visits' }, 429);
    return ok({ strategyId, result: null });
  }
  if (method === 'POST' && path === '/v5/strategy/stop') {
    const row = bybit.strategies.get(String(body.strategyId));
    if (!row) return refused(60065, 'strategy not found');
    if (row.status !== 2) return refused(60066, 'strategy already ended');
    // The first stop is acknowledged and has no effect.
    if (++bybit.stops === 1 && faults.has('bybit-stop-stuck')) return ok({ strategyId: body.strategyId });
    row.status = 3;
    row.updatedTimeE3 = stamp;
    for (const child of bybit.children.get(String(body.strategyId))!) child.status = 6;
    return ok({ strategyId: body.strategyId });
  }
  if (method === 'POST' && path === '/v5/order/create') {
    if (body.reduceOnly !== true || body.side !== 'Sell' || body.orderType !== 'Market' || body.positionIdx !== ownIdx) return refused(10001, 'stand-in accepts only the reduce-only close');
    bybit.position -= Number(body.qty);
    return ok({ orderId: 'o' + ++bybit.orders, orderLinkId: body.orderLinkId });
  }
  return refused(10001, 'unexpected ' + path);
}

// Whether the create being answered took effect; a refused one has no reply worth losing.
let effective = false;
const LOST_REPLY: Record<string, string> = { '/fapi/v3/subAccountTransfer': 'aster-lost-transfer', '/v5/strategy/create': 'bybit-lost-create' };
let lost = false;

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input)), method = init?.method ?? 'GET', headers = new Headers(init?.headers);
  appendFileSync(process.env.CONTRACT_STUB_LOG!, `${method} ${url.pathname}\n`);
  let response: Response;
  effective = url.pathname !== '/v5/strategy/create';
  if (url.hostname === 'fapi.asterdex.com') response = asterReply(method, url.pathname, method === 'POST' ? new URLSearchParams(String(init?.body)) : url.searchParams);
  else if (url.hostname === 'api.bybit.com') response = bybitReply(method, url.pathname, url.searchParams, method === 'POST' ? JSON.parse(String(init?.body)) as Row : {}, headers);
  else throw new Error('unexpected host ' + url.hostname);
  // The first such write takes effect and its reply never arrives.
  if (method === 'POST' && effective && !lost && faults.has(LOST_REPLY[url.pathname] ?? '')) { lost = true; throw new TypeError('fetch failed'); }
  return response;
};

// server/contract-probes/lib/common.ts honours the pause only while the registered fetch is the one in use;
// 'seam-unpaired' registers another one, as if requests would go to a real venue.
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('project-aggregation.contract-probes.wait-seam')] = {
  fetch: faults.has('seam-unpaired') ? async (): Promise<Response> => { throw new Error('not the fetch in use'); } : globalThis.fetch,
  pause: async (ms: number): Promise<void> => { skewMs += ms; await new Promise(resolve => setImmediate(resolve)); },
};
