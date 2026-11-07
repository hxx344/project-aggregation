import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRhLighter, readRhLighterPositions, readRhLighterSnapshot, RH_LIGHTER_ERRORS, RH_LIGHTER_SNAPSHOT_TTL_MS, RH_LIGHTER_COOLDOWN_MS, NOTE_COIN } from '../lib/rh-lighter.ts';
import { positionId } from '../lib/positions-values.ts';
import { connectionSchema } from '../lib/validation.ts';

const ACCOUNT = 'https://api.rh.lighter.xyz/api/v1/account';
const ADDRESS = '0x00000000000000000000000000000000000000Ab';
const USER = ADDRESS.toLowerCase();
const at = Date.parse('2026-11-02T08:00:00Z');
type Reply = (url: URL) => Response | Promise<Response>;

const short = { market_id: 120, symbol: 'ANTHROPIC', sign: -1, position: '0.44104', avg_entry_price: '1516.1', position_value: '-668.6', unrealized_pnl: '0.06', initial_margin_fraction: '20.00', liquidation_price: '3000.5', margin_mode: 0 };
const long = { market_id: 1, symbol: 'BTC', sign: 1, position: '0.01', avg_entry_price: '100000', position_value: '1000', unrealized_pnl: '-2.5', initial_margin_fraction: '5', liquidation_price: '0', margin_mode: 1 };
const closed = { market_id: 2, symbol: 'ETH', sign: 1, position: '0.000', avg_entry_price: '0.00', position_value: '-0.000000', unrealized_pnl: '0.000000', initial_margin_fraction: '20.00', liquidation_price: '0', margin_mode: 0 };
function account(index: number, extra: Record<string, unknown> = {}) {
  return { index, account_index: index, l1_address: ADDRESS, total_asset_value: '100.25', assets: [], positions: [], ...extra };
}
const page = (accounts: unknown[], extra: Record<string, unknown> = {}) => Response.json({ code: 200, total: accounts.length, accounts, ...extra });

function fixture(reply: Reply = () => page([account(1)])) {
  const urls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, ACCOUNT);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual([...new Headers(init.headers).keys()], ['accept']);
    assert.deepEqual([url.searchParams.get('by'), url.searchParams.get('value'), url.searchParams.get('active_only')], ['l1_address', USER, 'true']);
    urls.push(url);
    return reply(url);
  }) as typeof fetch;
  return { fetcher, urls };
}

test('the balance sums total_asset_value over every account and lists spot balances without valuing them', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const f = fixture(() => page([
    account(7, { name: 'main', total_asset_value: '1000.5', assets: [{ symbol: 'USDG', asset_id: 3, balance: '20', locked_balance: '0' }, { asset_id: 9, balance: '0', locked_balance: '1.5' }], shares: [{ public_pool_index: 1, shares_amount: 5 }] }),
    account(8, { total_asset_value: '-0.5', bo_positions: [{ market_id: 3 }] }),
    // Zero values arrive explicitly; shares and bo_positions may be absent.
    { index: 9, l1_address: ADDRESS, total_asset_value: '0.000000', assets: [], positions: [] },
  ]));
  const result = await syncRhLighter({ walletAddress: ADDRESS }, f.fetcher);
  assert.equal(result.total, 1000);
  assert.equal(result.updatedAt, new Date(at).toISOString());
  assert.deepEqual(result.details.map(row => [row.coin, row.account, row.quantity, row.price, row.value]), [
    ['USDG', '账户 #7 main · 账户总值（含未实现盈亏）', 1000.5, 1, 1000.5],
    ['USDG', '账户 #8 · 账户总值（含未实现盈亏）', -0.5, 1, -0.5],
    ['USDG', '账户 #9 · 账户总值（含未实现盈亏）', 0, 1, 0],
    ['USDG', '账户 #7 main · 现货余额（未计入总额）', 20, 0, 0],
    ['资产 #9', '账户 #7 main · 现货挂单锁定（未计入总额）', 1.5, 0, 0],
    [NOTE_COIN, '持有公共池份额，未计入总额', 0, 0, 0],
    [NOTE_COIN, '持有二元期权仓位，未单独列出', 0, 0, 0],
  ]);
  assert.equal(f.urls.length, 1);
});

test('a missing amount, margin mode or position list is refused instead of read as zero', async () => {
  const { position: _position, ...noQuantity } = long, { margin_mode: _mode, ...noMode } = long, { avg_entry_price: _entry, ...noEntry } = long;
  const { total_asset_value: _value, ...noValue } = account(1), { positions: _rows, ...noPositions } = account(1);
  for (const body of [[account(1, { positions: [noQuantity] })], [account(1, { positions: [noMode] })], [account(1, { positions: [noEntry] })], [noValue], [noPositions]]) {
    await assert.rejects(readRhLighterPositions({ walletAddress: ADDRESS }, fixture(() => page(body)).fetcher), new RegExp(RH_LIGHTER_ERRORS.invalid));
  }
});

test('positions skip closed markets, map sign, margin mode, leverage and missing liquidation price', async () => {
  const f = fixture(() => page([account(5, { positions: [short, closed] }), account(6, { positions: [long] })]));
  const positions = await readRhLighterPositions({ walletAddress: ADDRESS }, f.fetcher);
  assert.deepEqual(positions.map(p => [p.symbol, p.side, p.quantity, p.entryPrice, p.notional, p.unrealizedPnl, p.leverage, p.liquidationPrice, p.marginMode, p.priceCurrency]), [
    ['ANTHROPIC', 'short', '0.44104', '1516.1', '668.6', '0.06', '5', '3000.5', 'cross', 'USDG'],
    ['BTC', 'long', '0.01', '100000', '1000', '-2.5', '20', null, 'isolated', 'USDG'],
  ]);
  assert.deepEqual(positions.map(p => p.id), [positionId('rh-lighter', '5', '120', 'short'), positionId('rh-lighter', '6', '1', 'long')]);
});

test('balance and positions share one account read per address until the TTL ends; failures are not cached', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  let broken = false;
  const f = fixture(() => broken ? Promise.reject(new Error('connect ECONNRESET private-host')) : page([account(1, { positions: [long] })]));
  const credential = { walletAddress: ADDRESS };
  const [balance, positions] = await Promise.all([syncRhLighter(credential, f.fetcher), readRhLighterPositions(credential, f.fetcher)]);
  assert.equal(balance.total, 100.25); assert.equal(positions.length, 1);
  await readRhLighterPositions({ walletAddress: ' ' + USER + ' ' }, f.fetcher);
  assert.equal(f.urls.length, 1, 'joined in flight and reused for the same address');
  t.mock.timers.tick(RH_LIGHTER_SNAPSHOT_TTL_MS - 1);
  assert.equal((await syncRhLighter(credential, f.fetcher)).updatedAt, new Date(at).toISOString(), 'a reused read keeps its own time');
  assert.equal(f.urls.length, 1);
  t.mock.timers.tick(1); broken = true;
  await assert.rejects(syncRhLighter(credential, f.fetcher), { message: RH_LIGHTER_ERRORS.network });
  await assert.rejects(syncRhLighter(credential, f.fetcher), { message: RH_LIGHTER_ERRORS.network });
  assert.equal(f.urls.length, 3, 'a failed read is retried on the next call');
  broken = false;
  assert.equal((await syncRhLighter(credential, f.fetcher)).updatedAt, new Date(at + RH_LIGHTER_SNAPSHOT_TTL_MS).toISOString());
});

test('HTTP 429, 405 and code 23000 stop all reads for 60 seconds, then reading resumes', async t => {
  for (const limited of [() => new Response('', { status: 429 }), () => new Response('', { status: 405 }), () => Response.json({ code: 23000, message: 'Too Many Requests' })]) {
    t.mock.timers.enable({ apis: ['Date'], now: at });
    let blocked = true;
    const f = fixture(() => blocked ? limited() : page([account(1)]));
    await assert.rejects(syncRhLighter({ walletAddress: ADDRESS }, f.fetcher), { message: RH_LIGHTER_ERRORS.rateLimited });
    blocked = false;
    t.mock.timers.tick(RH_LIGHTER_COOLDOWN_MS - 1);
    await assert.rejects(readRhLighterPositions({ walletAddress: '0x' + '2'.repeat(40) }, f.fetcher), { message: RH_LIGHTER_ERRORS.rateLimited });
    assert.equal(f.urls.length, 1, 'no request during the cooldown, for any address');
    t.mock.timers.tick(1);
    assert.equal((await syncRhLighter({ walletAddress: ADDRESS }, f.fetcher)).total, 100.25);
    assert.equal(f.urls.length, 2);
    t.mock.timers.reset();
  }
});

test('not-found, HTTP failures and network errors map to fixed messages without upstream text', async () => {
  const cases: [Reply, string][] = [
    [() => Response.json({ code: 21100, message: 'account not found 0xprivate' }, { status: 400 }), RH_LIGHTER_ERRORS.missing],
    [() => Response.json({ code: 20001, message: 'invalid param' }, { status: 400 }), 'Lighter RH 读取失败（HTTP 400）：接口暂时不可用，请稍后重试；已保留上次数据'],
    [() => new Response('<html>private</html>', { status: 400 }), 'Lighter RH 读取失败（HTTP 400）：接口暂时不可用，请稍后重试；已保留上次数据'],
    [() => new Response('upstream private', { status: 503 }), 'Lighter RH 读取失败（HTTP 503）：接口暂时不可用，请稍后重试；已保留上次数据'],
    [() => new Response('', { status: 302, headers: { location: 'https://example.com' } }), 'Lighter RH 读取失败（HTTP 302）：接口暂时不可用，请稍后重试；已保留上次数据'],
    [() => { throw new Error('getaddrinfo private-host'); }, RH_LIGHTER_ERRORS.network],
    [() => new Response('{not json'), RH_LIGHTER_ERRORS.invalid],
    [() => Response.json({ code: 200, total: 0, accounts: [] }), RH_LIGHTER_ERRORS.missing],
  ];
  for (const [reply, message] of cases) await assert.rejects(syncRhLighter({ walletAddress: ADDRESS }, fixture(reply).fetcher), { message });
  assert.deepEqual(await readRhLighterPositions({ walletAddress: ADDRESS }, fixture(() => Response.json({ code: 200, total: 0, accounts: [] })).fetcher), []);
});

test('malformed accounts and positions are refused rather than read as zero', async () => {
  const bad = [
    account(1, { l1_address: '0x' + '3'.repeat(40) }),
    account(1, { total_asset_value: '1e3' }),
    account(1, { total_asset_value: 12 }),
    { ...account(1), account_index: 2 },
    account(1, { positions: [{ ...long, sign: 0 }] }),
    account(1, { positions: [{ ...long, position: '-1' }] }),
    account(1, { positions: [{ ...long, margin_mode: 2 }] }),
    account(1, { positions: [{ ...long, symbol: '<script>' }] }),
    account(1, { positions: [{ ...long, market_id: -1 }] }),
    account(1, { assets: [{ balance: '1' }] }),
    account(1, { positions: {} }),
  ];
  for (const item of bad) {
    await assert.rejects(readRhLighterPositions({ walletAddress: ADDRESS }, fixture(() => page([item])).fetcher), { message: RH_LIGHTER_ERRORS.invalid }, JSON.stringify(item));
  }
  for (const body of [{ code: 200, accounts: [] }, { code: 500, total: 0, accounts: [] }, { code: 200, total: 1, accounts: [account(1), account(1)] }, []]) {
    await assert.rejects(syncRhLighter({ walletAddress: ADDRESS }, fixture(() => Response.json(body)).fetcher), { message: RH_LIGHTER_ERRORS.invalid }, JSON.stringify(body));
  }
});

test('a cursor page is followed once and a list shorter than the reported total is incomplete', async () => {
  const paged = fixture(url => url.searchParams.get('cursor') === 'next-1'
    ? page([account(2)], { total: 2 })
    : page([account(1)], { total: 2, next_cursor: 'next-1' }));
  assert.equal((await syncRhLighter({ walletAddress: ADDRESS }, paged.fetcher)).total, 200.5);
  assert.deepEqual(paged.urls.map(url => url.searchParams.get('cursor')), [null, 'next-1']);

  const endless = fixture(url => page([account(Number(url.searchParams.get('cursor') ?? 0) + 1)], { total: 9, next_cursor: String(Number(url.searchParams.get('cursor') ?? 0) + 1) }));
  await assert.rejects(syncRhLighter({ walletAddress: ADDRESS }, endless.fetcher), { message: RH_LIGHTER_ERRORS.incomplete });
  assert.equal(endless.urls.length, 2, 'at most two pages are requested');
  await assert.rejects(syncRhLighter({ walletAddress: ADDRESS }, fixture(() => page([account(1)], { total: 2 })).fetcher), { message: RH_LIGHTER_ERRORS.incomplete });
});

test('an invalid address is refused before any request and the connection schema accepts only an address', async () => {
  const f = fixture();
  for (const walletAddress of ['', '0x123', 'ab'.repeat(20), '0x' + 'g'.repeat(40), undefined]) {
    await assert.rejects(readRhLighterSnapshot(walletAddress, f.fetcher), { message: RH_LIGHTER_ERRORS.address });
  }
  assert.equal(f.urls.length, 0);
  assert.deepEqual(connectionSchema.parse({ exchange: 'rh-lighter', walletAddress: ' ' + ADDRESS + ' ' }), { exchange: 'rh-lighter', walletAddress: ADDRESS });
  assert.equal(connectionSchema.safeParse({ exchange: 'rh-lighter', walletAddress: ADDRESS, apiKey: 'x' }).success, false);
  assert.equal(connectionSchema.safeParse({ exchange: 'rh-lighter', walletAddress: '0x123' }).success, false);
});

test('a caller abort ends only its own wait while the shared read completes for others', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return page([account(1, { positions: [long] })]); });
  const controller = new AbortController();
  const aborted = readRhLighterPositions({ walletAddress: ADDRESS }, f.fetcher, controller.signal);
  const other = readRhLighterPositions({ walletAddress: ADDRESS }, f.fetcher);
  controller.abort();
  await assert.rejects(aborted, { message: RH_LIGHTER_ERRORS.network });
  release();
  assert.equal((await other).length, 1);
  assert.equal(f.urls.length, 1);
});
