import test from 'node:test';
import assert from 'node:assert/strict';
import { syncHyperliquid, HYPERLIQUID_ERRORS, NOTE_COIN } from '../lib/hyperliquid.ts';
import { connectionSchema } from '../lib/validation.ts';

const INFO = 'https://api.hyperliquid.xyz/info';
const GECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd&include_last_updated_at=true';
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const ADDRESS = '0x00000000000000000000000000000000000000Ab';
const USER = ADDRESS.toLowerCase();
const HLP = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
const OTHER_VAULT = '0x1111111111111111111111111111111111112222';
type Body = { type: string; user?: string; dex?: string };
type Overrides = Partial<Record<string, (body: Body) => unknown>>;
type Quote = (url: string) => Response;

function state(accountValue: string, positions = 0) {
  return { marginSummary: { accountValue }, assetPositions: Array.from({ length: positions }, () => ({ position: {} })) };
}
const spotMeta = (universe: unknown[], contexts: unknown[]) => [{ tokens: [{ index: 0, name: 'USDC' }, { index: 150, name: 'HYPE' }, { index: 9, name: 'NOPX' }], universe }, contexts];
// Times are read when a request is answered so tests with mocked clocks stay consistent.
const base: Record<string, (body: Body) => unknown> = {
  userRole: () => ({ role: 'user' }),
  userAbstraction: () => 'default',
  portfolio: () => [['day', { accountValueHistory: [[Date.now() - 3_600_000, '90'], [Date.now() - 30_000, '150.5']] }], ['week', { accountValueHistory: [[Date.now() - 1000, '1']] }]],
  spotClearinghouseState: () => ({ balances: [
    { coin: 'USDC', token: 0, total: '50' }, { coin: 'HYPE', token: 150, total: '2' }, { coin: 'DUST', token: 7, total: '0' }, { coin: 'NOPX', token: 9, total: '3' },
  ] }),
  userVaultEquities: () => [{ vaultAddress: HLP, equity: '20' }, { vaultAddress: OTHER_VAULT, equity: '0' }],
  delegatorSummary: () => ({ delegated: '1', undelegated: '0.25', totalPendingWithdrawal: '0.25', nPendingWithdrawals: 1 }),
  perpDexs: () => [null, { name: 'xyz' }, { name: 'io' }],
  clearinghouseState: body => body.dex === '' ? state('60') : body.dex === 'io' ? state('40.5', 1) : state('0'),
  meta: () => ({ collateralToken: 0 }),
  // Contexts are deliberately out of universe order: prices must match by pair name.
  spotMetaAndAssetCtxs: () => spotMeta([{ name: '@1', tokens: [150, 0], isCanonical: false }, { name: '@2', tokens: [9, 150] }], [{ coin: '@2', midPx: '5' }, { coin: '@1', midPx: '30', markPx: '29' }]),
};
function fixture(overrides: Overrides = {}, quote?: Quote) {
  const handlers = { ...base, ...overrides };
  const calls: Body[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === INFO) {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(String(init.body)) as Body;
      if (body.user !== undefined) assert.equal(body.user, USER);
      calls.push(body);
      const handler = handlers[body.type];
      assert.ok(handler, 'unexpected info request ' + body.type);
      const result = handler(body);
      return result instanceof Response ? result : Response.json(result);
    }
    assert.ok(url === GECKO || url === COINBASE, 'unexpected URL ' + url);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.deepEqual([...new Headers(init.headers).keys()], ['accept']);
    assert.equal(url.toLowerCase().includes(USER), false, 'quote requests never carry the account address');
    if (quote) return quote(url);
    return Response.json({ 'usd-coin': { usd: 0.9998, last_updated_at: Math.floor(Date.now() / 1000) - 60 } });
  }) as typeof fetch;
  return { fetcher, calls };
}
const types = (calls: Body[]) => calls.map(call => call.type + (call.dex !== undefined ? ':' + call.dex : ''));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const notes = (details: { coin: string; account: string }[]) => details.filter(row => row.coin === NOTE_COIN).map(row => row.account);
const sync = (overrides: Overrides = {}, quote?: Quote) => syncHyperliquid({ walletAddress: ADDRESS }, fixture(overrides, quote).fetcher);

test('default mode totals the official account value once and lists perps, spot, vaults and staking as detail rows', async t => {
  const now = Date.parse('2026-11-07T08:00:00.500Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const { fetcher, calls } = fixture();
  const result = await syncHyperliquid({ walletAddress: ' ' + ADDRESS + ' ' }, fetcher);
  close(result.total, 150.5 * 0.9998);
  assert.equal(types(calls).includes('userRole'), false, 'refresh does not repeat the role check');
  assert.deepEqual(types(calls).filter(type => type.startsWith('clearinghouseState')).sort(), ['clearinghouseState:', 'clearinghouseState:io', 'clearinghouseState:xyz']);
  assert.deepEqual(result.details.map(row => [row.coin, row.account, row.quantity]), [
    ['USDC', '永续 · 主站 · 账户权益（含未实现盈亏）', 60],
    ['USDC', '永续 · io（Entropy） · 账户权益（含未实现盈亏）', 40.5],
    ['USDC', '现货余额', 50],
    ['HYPE', '现货余额', 2],
    ['NOPX', '现货余额', 3],
    ['USDC', '金库 · HLP', 20],
    ['HYPE', '质押（含未委托与待提取）', 1.5],
  ]);
  close(result.details[3].value, 60 * 0.9998);
  assert.deepEqual([result.details[4].price, result.details[4].value], [0, 0], 'a token without a USDC pair is marked unvalued, not dropped');
  close(result.details[6].value, 45 * 0.9998);
  assert.equal(result.updatedAt, new Date(Math.min(now - 30_000, Math.floor(now / 1000) * 1000 - 60_000)).toISOString());
});

test('disabled and DEX-abstraction modes keep per-DEX balances separate; non-USDC collateral is priced from spot', async () => {
  for (const mode of ['disabled', 'dexAbstraction']) {
    const result = await sync({ userAbstraction: () => mode, meta: body => ({ collateralToken: body.dex === 'io' ? 150 : 0 }) });
    const io = result.details.find(row => row.account.includes('io（Entropy）'))!;
    assert.deepEqual([io.coin, io.quantity], ['HYPE', 40.5], mode);
    close(io.value, 40.5 * 30 * 0.9998);
    assert.deepEqual(notes(result.details), [], mode);
  }
  // The collateral name learned from one market read survives a later failed read, keeping the row key stable.
  let marketDown = false;
  const { fetcher } = fixture({ meta: body => ({ collateralToken: body.dex === 'io' ? 150 : 0 }), spotMetaAndAssetCtxs: body => marketDown ? new Response('down', { status: 500 }) : base.spotMetaAndAssetCtxs(body) });
  const io = async () => (await syncHyperliquid({ walletAddress: ADDRESS }, fetcher)).details.find(row => row.account.includes('io（Entropy）'))!;
  assert.equal((await io()).coin, 'HYPE');
  marketDown = true;
  assert.deepEqual([(await io()).coin, (await io()).value], ['HYPE', 0]);
});

test('shared-balance modes never read per-DEX perp states, which repeat the spot collateral', async () => {
  for (const [mode, label] of [['unifiedAccount', '统一账户余额（现货与永续共用）'], ['portfolioMargin', '组合保证金账户余额']]) {
    const { fetcher, calls } = fixture({ userAbstraction: () => mode, delegatorSummary: () => ({ delegated: '0', undelegated: '0', totalPendingWithdrawal: '0' }), spotClearinghouseState: () => ({ balances: [{ coin: 'USDC', token: 0, total: '130.5' }] }) });
    const result = await syncHyperliquid({ walletAddress: ADDRESS }, fetcher);
    close(result.total, 150.5 * 0.9998);
    assert.equal(types(calls).some(type => type.startsWith('clearinghouseState') || type.startsWith('meta') || type === 'spotMetaAndAssetCtxs'), false, mode);
    assert.deepEqual(result.details.map(row => row.account), [label, '金库 · HLP']);
  }
});

test('failed or unrecognised detail reads still update the total and leave a visible note', async () => {
  const unknown = await sync({ userAbstraction: () => 'newMode' });
  close(unknown.total, 150.5 * 0.9998);
  assert.equal(unknown.details.some(row => row.account.startsWith('永续')), false, 'an unknown mode may share collateral, so perps are not listed');
  assert.deepEqual(notes(unknown.details), ['账户模式未识别，未列出永续明细；总额不受影响']);
  for (const failing of ['userAbstraction', 'spotClearinghouseState', 'userVaultEquities', 'delegatorSummary', 'perpDexs', 'clearinghouseState', 'meta']) {
    const result = await sync({ [failing]: () => new Response('down', { status: 500 }) });
    close(result.total, 150.5 * 0.9998);
    assert.equal(notes(result.details).length, 1, failing);
    if (['perpDexs', 'clearinghouseState', 'meta'].includes(failing)) {
      assert.equal(result.details.some(row => row.account.startsWith('永续')), false, failing);
      assert.deepEqual(result.details.filter(row => row.coin !== NOTE_COIN).map(row => row.account), ['现货余额', '现货余额', '现货余额', '金库 · HLP', '质押（含未委托与待提取）'], 'other detail rows survive ' + failing);
    }
  }
  const market = await sync({ spotMetaAndAssetCtxs: () => new Response('down', { status: 429 }) });
  assert.deepEqual(notes(market.details), ['现货报价读取失败，非 USDC 代币未估值；总额不受影响']);
  assert.deepEqual(market.details.filter(row => row.coin === 'HYPE').map(row => row.value), [0, 0]);
});

test('spot prices prefer the canonical USDC pair, then the highest volume', async () => {
  const pairs = (universe: unknown[], contexts: unknown[]) => sync({ spotMetaAndAssetCtxs: () => spotMeta(universe, contexts) });
  const canonical = await pairs([{ name: '@1', tokens: [150, 0] }, { name: 'HYPE/USDC', tokens: [150, 0], isCanonical: true }], [{ coin: '@1', midPx: '31', dayNtlVlm: '999' }, { coin: 'HYPE/USDC', midPx: '30', dayNtlVlm: '1' }]);
  assert.equal(canonical.details.find(row => row.coin === 'HYPE')!.price, 30 * 0.9998);
  const volume = await pairs([{ name: '@1', tokens: [150, 0] }, { name: '@3', tokens: [150, 0] }], [{ coin: '@1', midPx: '31', dayNtlVlm: '5' }, { coin: '@3', midPx: '32', dayNtlVlm: '50' }]);
  assert.equal(volume.details.find(row => row.coin === 'HYPE')!.price, 32 * 0.9998);
});

test('the DEX list and collateral tokens are cached for ten minutes per fetcher; a new DEX is read on demand', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-07T09:00:00Z') });
  let dexes: unknown[] = [null, { name: 'io' }];
  const { fetcher, calls } = fixture({ perpDexs: () => dexes, clearinghouseState: body => body.dex === 'km' ? state('7') : base.clearinghouseState(body) });
  const count = (type: string) => types(calls).filter(name => name === type).length;
  await syncHyperliquid({ walletAddress: ADDRESS }, fetcher);
  await syncHyperliquid({ walletAddress: ADDRESS }, fetcher);
  assert.deepEqual([count('perpDexs'), count('meta:'), count('meta:io')], [1, 1, 1]);
  dexes = [null, { name: 'io' }, { name: 'km' }];
  t.mock.timers.tick(10 * 60_000);
  const refreshed = await syncHyperliquid({ walletAddress: ADDRESS }, fetcher);
  assert.deepEqual([count('perpDexs'), count('meta:km')], [2, 1]);
  assert.ok(refreshed.details.some(row => row.account === '永续 · km · 账户权益（含未实现盈亏）'));
});

test('connection checks the role and rejects agent wallets and unknown addresses', async () => {
  const { fetcher, calls } = fixture();
  await syncHyperliquid({ walletAddress: ADDRESS }, fetcher, { verifyRole: true });
  assert.ok(types(calls).includes('userRole'));
  for (const role of ['subAccount', 'vault']) await syncHyperliquid({ walletAddress: ADDRESS }, fixture({ userRole: () => ({ role }) }).fetcher, { verifyRole: true });
  await assert.rejects(syncHyperliquid({ walletAddress: ADDRESS }, fixture({ userRole: () => ({ role: 'agent', data: { user: '0x1' } }) }).fetcher, { verifyRole: true }), { message: HYPERLIQUID_ERRORS.agent });
  await assert.rejects(syncHyperliquid({ walletAddress: ADDRESS }, fixture({ userRole: () => ({ role: 'missing' }) }).fetcher, { verifyRole: true }), { message: HYPERLIQUID_ERRORS.missing });
  await assert.rejects(syncHyperliquid({ walletAddress: ADDRESS }, fixture({ userRole: () => ({ role: 'other' }) }).fetcher, { verifyRole: true }), { message: HYPERLIQUID_ERRORS.invalid });
  // The role decides even when the account reads also fail, so an agent address is never reported as a network error.
  await assert.rejects(syncHyperliquid({ walletAddress: ADDRESS }, fixture({ userRole: () => ({ role: 'agent' }), portfolio: () => new Response('x', { status: 500 }) }).fetcher, { verifyRole: true }), { message: HYPERLIQUID_ERRORS.agent });
});

test('invalid addresses fail before any request', async () => {
  let requested = false;
  const fetcher = (async () => { requested = true; return Response.json({}); }) as unknown as typeof fetch;
  for (const walletAddress of ['', '0x123', ADDRESS + '0', 'ab'.repeat(20), undefined]) {
    await assert.rejects(syncHyperliquid({ walletAddress } as { walletAddress: string }, fetcher), { message: HYPERLIQUID_ERRORS.address });
  }
  assert.equal(requested, false);
});

test('stale, future, missing or malformed account values are refused', async () => {
  const series = (points: () => unknown) => () => [['day', { accountValueHistory: points() }]];
  await assert.rejects(sync({ portfolio: series(() => [[Date.now() - 6 * 60_000, '10']]) }), { message: HYPERLIQUID_ERRORS.stale });
  await assert.rejects(sync({ portfolio: series(() => [[Date.now() + 5 * 60_000, '10']]) }), { message: HYPERLIQUID_ERRORS.stale });
  for (const points of [[], [[Date.now(), 10]], [[Date.now(), '1e3']], [['x', '1']], null]) {
    await assert.rejects(sync({ portfolio: series(() => points) }), { message: HYPERLIQUID_ERRORS.invalid });
  }
});

test('transport, HTTP, redirect and body failures surface only fixed messages', async () => {
  const leak = 'secret-token https://evil.example ' + USER;
  const cases: [Overrides, string | RegExp][] = [
    [{ portfolio: () => { throw new Error(leak); } }, HYPERLIQUID_ERRORS.network],
    [{ portfolio: () => new Response(leak, { status: 500 }) }, /^Hyperliquid 读取失败（HTTP 500）/],
    [{ portfolio: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' + leak } }) }, /^Hyperliquid 读取失败（HTTP 302）/],
    [{ portfolio: () => new Response(leak, { status: 429 }) }, HYPERLIQUID_ERRORS.rateLimited],
    [{ portfolio: () => new Response('{' + leak, { status: 200 }) }, HYPERLIQUID_ERRORS.invalid],
    [{ portfolio: () => new Response('[]', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }) }, HYPERLIQUID_ERRORS.invalid],
    [{ portfolio: () => new Response('x'.repeat(5 * 1024 * 1024), { status: 200 }) }, HYPERLIQUID_ERRORS.invalid],
  ];
  for (const [override, expected] of cases) {
    const error = await sync(override).then(() => null, e => e as Error);
    assert.ok(error instanceof Error);
    if (typeof expected === 'string') assert.equal(error.message, expected); else assert.match(error.message, expected);
    for (const fragment of ['secret-token', 'evil.example', USER]) assert.equal(error.message.includes(fragment), false);
  }
});

test('one overall deadline bounds every request, including the quote fallback', async () => {
  const hanging = ((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
    // Like fetch, reject at once when the signal is already aborted.
    if (init.signal!.aborted) reject(new Error('aborted secret'));
    init.signal!.addEventListener('abort', () => reject(new Error('aborted secret')), { once: true });
  })) as typeof fetch;
  const started = Date.now();
  await assert.rejects(syncHyperliquid({ walletAddress: ADDRESS }, hanging, { verifyRole: true, budgetMs: 60 }), { message: HYPERLIQUID_ERRORS.network });
  assert.ok(Date.now() - started < 2000);
  // An agent address ends the sync at once and cancels the reads still in flight.
  let aborted = 0;
  const agent = fixture({ userRole: () => ({ role: 'agent' }) }).fetcher;
  const pending = ((input: RequestInfo | URL, init: RequestInit = {}) => String(input) === INFO && JSON.parse(String(init.body)).type === 'userRole' ? agent(input, init) : new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true }))) as typeof fetch;
  const before = Date.now();
  await assert.rejects(syncHyperliquid({ walletAddress: ADDRESS }, pending, { verifyRole: true }), { message: HYPERLIQUID_ERRORS.agent });
  assert.ok(Date.now() - before < 2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(aborted >= 5, 'outstanding reads are aborted, saw ' + aborted);
  const { fetcher } = fixture();
  const slowQuote = ((input: RequestInfo | URL, init: RequestInit = {}) => String(input) === INFO ? fetcher(input, init) : hanging(input, init)) as typeof fetch;
  await assert.rejects(syncHyperliquid({ walletAddress: ADDRESS }, slowQuote, { budgetMs: 60 }), { message: HYPERLIQUID_ERRORS.quote });
});

test('USDC/USD falls back to Coinbase and fails closed when no current quote exists', async () => {
  close((await sync({}, url => url === GECKO ? new Response('down', { status: 503 }) : Response.json({ data: { currency: 'USDC', rates: { USD: '0.999' } } }))).total, 150.5 * 0.999);
  await assert.rejects(sync({}, url => url === GECKO ? Response.json({ 'usd-coin': { usd: 1, last_updated_at: Math.floor(Date.now() / 1000) - 3600 } }) : new Response('down', { status: 500 })), { message: HYPERLIQUID_ERRORS.quote });
  await assert.rejects(sync({}, () => { throw new Error('ENOTFOUND api.coingecko.com'); }), { message: HYPERLIQUID_ERRORS.quote });
});

test('the connection schema accepts only a main-account address for Hyperliquid', () => {
  assert.deepEqual(connectionSchema.parse({ exchange: 'hyperliquid', walletAddress: ' ' + ADDRESS + ' ' }), { exchange: 'hyperliquid', walletAddress: ADDRESS });
  for (const input of [{ exchange: 'hyperliquid', walletAddress: '0x12' }, { exchange: 'hyperliquid', walletAddress: ADDRESS, privateKey: '0x' + '1'.repeat(64) }, { exchange: 'hyperliquid' }]) {
    assert.equal(connectionSchema.safeParse(input).success, false);
  }
});
