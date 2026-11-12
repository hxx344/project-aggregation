// Live canary wiring (3.0c): startup key and identity checks, the config and key files, the data-directory environment
// marker, the executor's refusals on mainnet, and two-leg jobs driven end to end through the real connectors against the
// stand-in venues. No network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../src/executor.ts';
import { ContractError, type AccountBinding } from '../src/contracts.ts';
import { VenueError } from '../src/connector.ts';
import { createBinanceConnector } from '../src/live/binance.ts';
import { createBybitConnector } from '../src/live/bybit.ts';
import { PreflightError, binancePermissionProblem, bybitPermissionProblem } from '../src/live/permissions.ts';
import { createLiveConnectors, holdAccountLocks, loadLiveConfig, loadLiveCredentials, preflightLive, type LiveConfig } from '../src/live/setup.ts';
import { openStore } from '../src/store.ts';
import { createExecutorServer } from '../src/http.ts';
import type { AddressInfo } from 'node:net';
import { DATABASE_FILES, claimDataDirEnvironment } from '../src/main.ts';
import { LIVE_PAGE, PAGE } from '../src/page.ts';
import { chaseIntent, createHarness, openIntent } from './harness.ts';
import { FakeBinance, KEY as BINANCE_KEY, SECRET as BINANCE_SECRET, binding as binanceBinding } from './live-fake-binance.ts';
import { FakeBybit, KEY as BYBIT_KEY, SECRET as BYBIT_SECRET, binding as bybitBinding } from './live-fake-bybit.ts';

const signal = () => new AbortController().signal;
const preflightError = (pattern: RegExp) => (error: unknown) => error instanceof PreflightError && pattern.test(error.message);
const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const LIMITS = { perJob: '500', totalOpen: '1000' };
const ACCOUNTS: AccountBinding[] = [binanceBinding(), bybitBinding()];
const KEYS = { binance: { apiKey: BINANCE_KEY, apiSecret: BINANCE_SECRET }, bybit: { apiKey: BYBIT_KEY, apiSecret: BYBIT_SECRET } };

function binanceSetup() {
  const venue = new FakeBinance();
  return { venue, connector: createBinanceConnector({ credentials: () => KEYS.binance, fetchImpl: venue.fetch, now: () => venue.clock }) };
}
function bybitSetup() {
  const venue = new FakeBybit();
  return { venue, connector: createBybitConnector({ credentials: () => KEYS.bybit, fetchImpl: venue.fetch, now: () => venue.clock }) };
}
function tempDir(): string { return mkdtempSync(join(tmpdir(), 'pa-live-')); }
function privateFile(dir: string, name: string, content: unknown, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(path, mode);
  return path;
}

test('实盘启动检查（Binance）：只开读取与合约的密钥通过；开提现、缺合约、模式不符、权限缺字段、账户不可交易、UID 不符都拒绝', async () => {
  const { venue, connector } = binanceSetup();
  await connector.preflight!(binanceBinding(), { signal: signal() });
  const permission = venue.calls.find(call => call.path === '/sapi/v1/account/apiRestrictions')!;
  assert.equal(permission.host, 'https://api.binance.com');
  assert.ok(venue.calls.some(call => call.path === '/fapi/v1/accountConfig') && venue.calls.some(call => call.path === '/api/v3/account'));

  const base = { ...venue.restrictions };
  for (const [change, pattern] of [
    [{ enableWithdrawals: true }, /请关闭：允许提现/],
    [{ permitsUniversalTransfer: true }, /请关闭：允许万向划转/],
    [{ enableFixApiTrade: true }, /请关闭：允许 FIX API 交易/],
    [{ enableSomethingNew: true }, /请关闭：enableSomethingNew/],
    [{ permitsSomethingNew: 'ON' }, /请关闭：permitsSomethingNew/],
    [{ enableFutures: false }, /请开启：允许合约/],
    [{ enablePortfolioMarginTrading: true }, /请将账户模式改为 portfolio-margin/],
    [{ enableMargin: undefined }, /未返回权限状态：允许杠杆借贷/],
    [{ ipRestrict: false }, /未限制访问 IP/],
    [{ ipRestrict: undefined }, /未限制访问 IP/],
  ] as const) {
    venue.restrictions = { ...base, ...change };
    await assert.rejects(connector.preflight!(binanceBinding(), { signal: signal() }), preflightError(pattern), JSON.stringify(change));
  }
  venue.restrictions = base;
  venue.canTrade = false;
  await assert.rejects(connector.preflight!(binanceBinding(), { signal: signal() }), preflightError(/不可交易/));
  venue.canTrade = true;
  await assert.rejects(connector.preflight!(binanceBinding({ accountId: '987654321' }), { signal: signal() }), preflightError(/UID 123456789.*987654321/));
  venue.script('GET /sapi/v1/account/apiRestrictions', () => new Response('{}', { status: 500 }));
  await assert.rejects(connector.preflight!(binanceBinding(), { signal: signal() }), (error: unknown) => error instanceof VenueError && error.kind === 'read-failed');
});

test('实盘启动检查（Binance 组合保证金）：要求统一账户交易；普通合约密钥报模式不符', () => {
  const pm = { enableReading: true, enableFutures: false, enablePortfolioMarginTrading: true, enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false, enableMargin: false, enableVanillaOptions: false, enableSpotAndMarginTrading: false };
  assert.equal(binancePermissionProblem(pm, 'portfolio-margin'), null);
  assert.match(binancePermissionProblem({ ...pm, enableFutures: true, enablePortfolioMarginTrading: false }, 'portfolio-margin')!, /普通合约密钥/);
  assert.match(binancePermissionProblem({ ...pm, enablePortfolioMarginTrading: false }, 'portfolio-margin')!, /请开启：开启统一账户交易/);
});

test('实盘启动检查（Bybit）：只开合约订单与持仓的读写密钥通过；只读、缺清单、多开权限、缺订单权限、经典账户、用户编号不符都拒绝', async () => {
  const { venue, connector } = bybitSetup();
  await connector.preflight!(bybitBinding(), { signal: signal() });
  assert.ok(venue.count('GET /v5/user/query-api') >= 1 && venue.count('GET /v5/account/info') === 1);

  const base = structuredClone(venue.apiInfo), scopes = base.permissions as Record<string, string[]>;
  for (const [info, pattern] of [
    [{ ...base, readOnly: 1 }, /只读/],
    [{ ...base, permissions: null }, /未返回密钥权限清单/],
    [{ ...base, permissions: { ...scopes, Wallet: undefined } }, /未返回「钱包」权限状态/],
    [{ ...base, permissions: { ...scopes, Wallet: ['AccountTransfer'] } }, /请关闭：钱包 - AccountTransfer/],
    [{ ...base, permissions: { ...scopes, Exchange: ['ExchangeHistory'] } }, /请关闭：Exchange - ExchangeHistory/],
    [{ ...base, permissions: { ...scopes, ContractTrade: ['Position'] } }, /请开启：合约交易 - 订单/],
    [{ ...base, permissions: { ...scopes, Spot: [1] } }, /格式无效/],
    [{ ...base, ips: ['*'] }, /未绑定 IP/],
    [{ ...base, ips: ['203.0.113.7', ' * '] }, /未绑定 IP/],
    [{ ...base, ips: [] }, /未绑定 IP/],
    [{ ...base, ips: undefined }, /未绑定 IP/],
  ] as const) {
    venue.apiInfo = info as Record<string, unknown>;
    await assert.rejects(connector.preflight!(bybitBinding(), { signal: signal() }), preflightError(pattern), pattern.source);
  }
  venue.apiInfo = base;
  for (const [status, pattern] of [[1, /经典账户/], [undefined, /未返回账户状态/], [7, /未识别的账户状态 7/], ['5', /格式无效/]] as const) {
    venue.unifiedMarginStatus = status;
    await assert.rejects(connector.preflight!(bybitBinding(), { signal: signal() }), preflightError(pattern), String(status));
  }
  venue.unifiedMarginStatus = 3;
  await connector.preflight!(bybitBinding(), { signal: signal() });
  await assert.rejects(connector.preflight!(bybitBinding({ accountId: '42' }), { signal: signal() }), preflightError(/9007199254740993.*42/));
  assert.equal(bybitPermissionProblem({ readOnly: 0, permissions: { ContractTrade: ['Order'], Derivatives: [], Wallet: [], Spot: [], Options: [] } }), null);
});

test('实盘配置与密钥文件：只认属主本人且 600 权限的文件；格式错误的报错不带文件内容；两家账户各一个', () => {
  const dir = tempDir();
  try {
    const keysPath = privateFile(dir, 'keys.json', KEYS);
    const config = { notionalLimits: LIMITS, credentialsFile: keysPath, accounts: ACCOUNTS.map(({ environment: _environment, ...rest }) => rest) };
    const configPath = privateFile(dir, 'live.json', config);
    const loaded = loadLiveConfig(configPath);
    assert.deepEqual(loaded, { notionalLimits: LIMITS, credentialsFile: keysPath, accounts: ACCOUNTS });
    assert.deepEqual(Object.fromEntries(loadLiveCredentials(keysPath)), KEYS);

    assert.throws(() => loadLiveConfig('live.json'), /绝对路径/);
    assert.throws(() => loadLiveConfig(join(dir, 'missing.json')), /无法打开：ENOENT/);
    assert.throws(() => loadLiveConfig(dir), /不是普通文件/);
    chmodSync(keysPath, 0o640);
    assert.throws(() => loadLiveCredentials(keysPath), /权限过宽/);
    chmodSync(keysPath, 0o600);

    const broken = privateFile(dir, 'broken.json', `{"binance":{"apiKey":"${BINANCE_KEY}","apiSecret":"${BINANCE_SECRET}"`);
    assert.throws(() => loadLiveCredentials(broken), (error: unknown) => error instanceof Error && error.message === '密钥文件不是有效的 JSON');
    const badKey = privateFile(dir, 'bad-key.json', { ...KEYS, bybit: { apiKey: 'has space', apiSecret: BYBIT_SECRET } });
    assert.throws(() => loadLiveCredentials(badKey), (error: unknown) => error instanceof Error && /bybit 的密钥不完整/.test(error.message) && !error.message.includes(BYBIT_SECRET));
    assert.throws(() => loadLiveCredentials(privateFile(dir, 'extra.json', { ...KEYS, aster: KEYS.bybit })), /顶层的字段须恰好为 binance、bybit/);
    // A key pasted in place of a field name never reaches the message.
    assert.throws(() => loadLiveCredentials(privateFile(dir, 'pasted.json', { ...KEYS, binance: { [BINANCE_SECRET]: BINANCE_KEY, apiSecret: BINANCE_SECRET } })),
      (error: unknown) => error instanceof Error && /binance 的字段须恰好为 apiKey、apiSecret/.test(error.message) && !error.message.includes(BINANCE_SECRET) && !error.message.includes(BINANCE_KEY));
    const big = privateFile(dir, 'big.json', JSON.stringify({ ...KEYS, pad: 'x'.repeat(70_000) }));
    assert.throws(() => loadLiveCredentials(big), /超过 64 KiB/);
    const fifo = join(dir, 'fifo.json');
    execFileSync('mkfifo', ['-m', '600', fifo]);
    assert.throws(() => loadLiveCredentials(fifo), /不是普通文件/);

    for (const [change, pattern] of [
      [{ accounts: config.accounts.slice(0, 1) }, /各一个账户/],
      [{ accounts: [config.accounts[0], config.accounts[0]] }, /各一个账户/],
      [{ accounts: [config.accounts[0], { ...config.accounts[1], environment: 'mainnet' }] }, /不支持的字段：environment/],
      [{ credentialsFile: 'keys.json' }, /credentialsFile 必须是绝对路径/],
      [{ notionalLimits: { perJob: '600', totalOpen: '500' } }, /单笔名义金额上限不得大于/],
      [{ notionalLimits: undefined }, /缺少字段：notionalLimits/],
    ] as const) {
      assert.throws(() => loadLiveConfig(privateFile(dir, 'variant.json', { ...config, ...change })), pattern, JSON.stringify(change));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('实盘连接器的密钥只给配置里的账户与凭据版本；启动检查逐个账户进行，失败时指明交易所与账户', async () => {
  const binance = new FakeBinance(), bybit = new FakeBybit();
  const config: LiveConfig = { notionalLimits: LIMITS, credentialsFile: '/unused', accounts: ACCOUNTS };
  const connectors = createLiveConnectors(config, new Map(Object.entries(KEYS)) as never, { fetchImpl: (url, init) => (new URL(url).hostname.endsWith('bybit.com') ? bybit : binance).fetch(url, init), now: () => binance.clock });
  await preflightLive(config, connectors);
  const before = binance.calls.length;
  await assert.rejects(connectors[0].account(binanceBinding({ credentialVersion: 2 }), ['CLUSDT'], { signal: signal() }), (error: unknown) => error instanceof VenueError && error.kind === 'read-failed' && /凭据版本/.test(error.message));
  await assert.rejects(connectors[0].account(binanceBinding({ accountId: '5' }), ['CLUSDT'], { signal: signal() }), (error: unknown) => error instanceof VenueError && /不是实盘配置里的账户/.test(error.message));
  assert.equal(binance.calls.length, before, '密钥不对应时不发任何请求');

  bybit.unifiedMarginStatus = 1;
  await assert.rejects(preflightLive(config, connectors), /bybit 账户 9007199254740993 启动检查未通过：Bybit 账户为经典账户/);
  await assert.rejects(preflightLive(config, [connectors[0]]), /bybit 连接器没有启动检查/);
});

test('数据目录环境标记：新目录记下首次环境；模拟用过的目录（含无标记的旧库）不能跑实盘，实盘目录也不能跑模拟', () => {
  const dir = tempDir();
  try {
    const fresh = join(dir, 'fresh'), legacy = join(dir, 'legacy'), live = join(dir, 'live'), unmarked = join(dir, 'unmarked');
    for (const path of [fresh, legacy, live, unmarked]) mkdirSync(path);
    assert.deepEqual(DATABASE_FILES, { simulated: 'executor.sqlite', mainnet: 'executor-live.sqlite' });
    claimDataDirEnvironment(fresh, 'simulated');
    assert.equal(readFileSync(join(fresh, 'environment'), 'utf8'), 'simulated\n');
    claimDataDirEnvironment(fresh, 'simulated');
    assert.throws(() => claimDataDirEnvironment(fresh, 'mainnet'), /已用于模拟，不能以实盘模式启动/);

    writeFileSync(join(legacy, 'executor.sqlite'), '');
    assert.throws(() => claimDataDirEnvironment(legacy, 'mainnet'), /已用于模拟/);
    assert.equal(existsSync(join(legacy, 'environment')), false);
    claimDataDirEnvironment(legacy, 'simulated');
    assert.equal(readFileSync(join(legacy, 'environment'), 'utf8'), 'simulated\n');

    claimDataDirEnvironment(live, 'mainnet');
    assert.throws(() => claimDataDirEnvironment(live, 'simulated'), /已用于实盘，不能以模拟模式启动/);
    writeFileSync(join(live, 'environment'), 'testnet\n');
    assert.throws(() => claimDataDirEnvironment(live, 'mainnet'), /未知环境（testnet）/);

    // A live database whose marker never reached the disk still marks the directory live.
    writeFileSync(join(unmarked, 'executor-live.sqlite'), '');
    assert.throws(() => claimDataDirEnvironment(unmarked, 'simulated'), /已用于实盘/);
    claimDataDirEnvironment(unmarked, 'mainnet');
    assert.equal(readFileSync(join(unmarked, 'environment'), 'utf8'), 'mainnet\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('执行器实盘环境：拒绝共享写者登记、模拟连接器与 ASTER 划转/ADL/持仓；页面与状态标明实盘', () => {
  const h = createHarness();
  try {
    const [binance, bybit] = createLiveConnectors({ notionalLimits: LIMITS, credentialsFile: '/unused', accounts: ACCOUNTS }, new Map(Object.entries(KEYS)) as never);
    const base = { store: h.store, connectors: [binance, bybit], environment: 'mainnet' as const, notionalLimits: LIMITS };
    const ex = createExecutor(base);
    assert.equal(ex.environment, 'mainnet');
    assert.throws(() => createExecutor({ ...base, control: { writer: {} as never, environment: 'testnet' } }), code('control_mainnet'));
    assert.throws(() => createExecutor({ ...base, connectors: [binance, h.bybit] }), code('live_transport_refused'));
    assert.throws(() => createExecutor({ ...base, transfers: h.aster }), code('live_transport_refused'));
    assert.throws(() => createExecutor({ ...base, adl: h.asterTrading }), code('live_transport_refused'));
    assert.throws(() => createExecutor({ ...base, positions: h.asterTrading }), code('live_transport_refused'));
    assert.throws(() => createExecutor({ ...base, notionalLimits: undefined }), code('notional_limits_required'));
    assert.throws(() => ex.registerAccount({ ...binanceBinding(), environment: 'simulated' }), code('environment'));
  } finally { h.dispose(); }
  assert.ok(LIVE_PAGE.includes('<title>执行器（实盘金丝雀）</title>') && LIVE_PAGE.includes('确认执行（实盘）') && LIVE_PAGE.includes('ASTER 保证金平衡（实盘未接入）'));
  assert.ok(!LIVE_PAGE.includes('模拟') && PAGE.includes('确认执行（模拟）'));
});

test('端到端：执行器用真实连接器对替身交易所跑完两腿开仓与 Bybit 追价平仓，名义金额计入累计上限', async () => {
  const dir = tempDir();
  const binance = new FakeBinance(), bybit = new FakeBybit();
  binance.fillAll = bybit.fillAll = true;
  const clock = { now: binance.clock };
  const sync = () => { binance.clock = bybit.clock = clock.now; };
  const config: LiveConfig = { notionalLimits: LIMITS, credentialsFile: '/unused', accounts: ACCOUNTS };
  const connectors = createLiveConnectors(config, new Map(Object.entries(KEYS)) as never, { fetchImpl: (url, init) => (new URL(url).hostname.endsWith('bybit.com') ? bybit : binance).fetch(url, init), now: () => clock.now });
  const store = openStore(join(dir, 'executor.sqlite'));
  try {
    await preflightLive(config, connectors);
    const ex = createExecutor({ store, connectors, environment: 'mainnet', notionalLimits: LIMITS, now: () => clock.now });
    assert.ok(ex.acquire());
    for (const account of config.accounts) ex.registerAccount(account);
    const run = async (intent: unknown, between?: () => void) => {
      const preview = await ex.preview(intent, 'live-session');
      const { job } = ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, 'live-session');
      for (let i = 0; i < 30; i++) {
        await ex.tick();
        const view = ex.jobView(job.id);
        if (['completed', 'failed', 'stopped', 'attention'].includes(view.status)) return view;
        if (i === 2) between?.();
        clock.now += 1_000; sync(); ex.acquire();
      }
      return ex.jobView(job.id);
    };

    const opened = await run(openIntent());
    assert.equal(opened.status, 'completed', JSON.stringify(opened.events.slice(-5)));
    assert.deepEqual(opened.legs.map(leg => [leg.venue, leg.filledQuantity]), [['binance', '1'], ['bybit', '1']]);
    assert.deepEqual([binance.net.get('CLUSDT'), bybit.net.get('CLUSDT')], [1, -1]);
    const used = ex.notionalLimits()!.openUsed;
    assert.ok(Number(used) > 0 && Number(used) <= Number(LIMITS.perJob), used);

    // Bybit chases back to flat, Binance hedges with a market order once the chase has filled.
    const closed = await run({ ...chaseIntent(), action: 'close', legs: [{ venue: 'bybit', side: 'short', quantity: '1', orderType: 'chase' }, { venue: 'binance', side: 'long', quantity: '1', orderType: 'market' }] }, () => {
      assert.equal(bybit.strategies.filter(row => row.status === 2).length, 1, '追价策略在运行中');
      bybit.finishChases();
    });
    assert.equal(closed.status, 'completed', JSON.stringify(closed.events.slice(-5)));
    assert.deepEqual([binance.net.get('CLUSDT'), bybit.net.get('CLUSDT')], [0, 0]);
    assert.equal(closed.legs[0].operation?.childrenSettled, true);
    assert.equal(bybit.count('POST /v5/strategy/create'), 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP：实盘执行器下发实盘页面，状态里的传输为 live 并带名义金额上限；模拟执行器仍是模拟页面', async () => {
  const h = createHarness();
  const [binance, bybit] = createLiveConnectors({ notionalLimits: LIMITS, credentialsFile: '/unused', accounts: ACCOUNTS }, new Map(Object.entries(KEYS)) as never);
  const servers = [createExecutorServer({ executor: createExecutor({ store: h.store, connectors: [binance, bybit], environment: 'mainnet', notionalLimits: LIMITS }), accessToken: 'live-token', session: 'live-session-value' }),
    createExecutorServer({ executor: h.ex, accessToken: 'sim-token', session: 'sim-session-value' })];
  try {
    const seen: [string, string, unknown][] = [];
    for (const [server, token] of [[servers[0], 'live-token'], [servers[1], 'sim-token']] as const) {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cookie = ((await fetch(`${base}/login?token=${token}`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];
      const page = await (await fetch(base + '/', { headers: { cookie } })).text();
      const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as { transport: string; notionalLimits: unknown };
      seen.push([page === LIVE_PAGE ? 'live-page' : page === PAGE ? 'sim-page' : 'other', state.transport, state.notionalLimits]);
    }
    assert.deepEqual(seen, [['live-page', 'live', { ...LIMITS, openUsed: '0' }], ['sim-page', 'simulated', null]]);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    h.dispose();
  }
});

test('实盘账户进程锁：同一账户在本机只能有一个实盘执行器，与数据目录无关；释放后可再取', async () => {
  const accounts = [binanceBinding({ accountId: `lock-${process.pid}` }), bybitBinding({ accountId: `lock-${process.pid}` })];
  const first = await holdAccountLocks(accounts);
  try {
    await assert.rejects(holdAccountLocks([accounts[1]]), new RegExp(`bybit 账户 lock-${process.pid} 已被本机另一个实盘执行器占用`));
    // A partly taken set is handed back: the binance lock of a second account must be free again afterwards.
    const other = binanceBinding({ accountId: `lock-other-${process.pid}` });
    await assert.rejects(holdAccountLocks([other, accounts[0]]), /binance 账户 .* 已被本机另一个实盘执行器占用/);
    (await holdAccountLocks([other])).release();
  } finally { first.release(); }
  await new Promise(resolve => setImmediate(resolve));
  (await holdAccountLocks(accounts)).release();
});
