import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { runInNewContext } from 'node:vm';
import { createAeroMarket, DEFAULT_CONFIG, strictMarketConfig } from '../server/research/aero-market.mjs';
import { AERO_BASE } from '../server/research/aero-market-chains.mjs';
import { createRpc } from '../server/research/aero-market-rpc.mjs';
import { createApp } from '../server/app.mjs';
import { errorResponder, HttpError } from '../server/http-common.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const Q96 = 2 ** 96;
const sqrtX96 = (raw) => BigInt(Math.round(Math.sqrt(raw) * Q96)).toString();
const tickOf = (raw) => Math.floor(Math.log(raw) / Math.log(1.0001));
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', WETH = '0x4200000000000000000000000000000000000006', AERO = AERO_BASE.toLowerCase();
const POOL_WETH = '0x' + '1'.repeat(40), POOL_AERO = '0x' + '2'.repeat(40), POOL_IDLE = '0x' + '3'.repeat(40);
const GAUGE_WETH = '0x' + 'a'.repeat(40), GAUGE_AERO = '0x' + 'b'.repeat(40);
const statics = {
  [POOL_WETH]: { address: POOL_WETH, token0: WETH, token1: USDC, tickSpacing: 100, gauge: GAUGE_WETH },
  [POOL_AERO]: { address: POOL_AERO, token0: AERO, token1: USDC, tickSpacing: 200, gauge: GAUGE_AERO },
  // 没有 gauge 且 TVL 低于门槛：发现时读取，常规轮次不跟踪。
  [POOL_IDLE]: { address: POOL_IDLE, token0: WETH, token1: USDC, tickSpacing: 1, gauge: null },
};
const BLOCK_TIME = 2;

function fakeChain({ start = 1_800_000_000, historyBlockTime = BLOCK_TIME, stall = 0 } = {}) {
  const chain = { t: start, failState: false, failHistory: null, historyBlocks: [], stateReads: 0 };
  const stateOf = (address, t) => {
    const weth = address !== POOL_AERO, raw = weth ? 3000e-12 * (1 + 0.01 * Math.sin(t / 3600)) : 0.6e-12;
    return {
      sqrtPriceX96: sqrtX96(raw), tick: tickOf(raw), liquidity: address === POOL_IDLE ? '1000' : String(10n ** 18n), stakedLiquidity: address === POOL_IDLE ? '0' : String(5n * 10n ** 17n),
      fee: 500, unstakedFee: 100_000, balance0: address === POOL_IDLE ? '1' : String(weth ? 10n ** 21n : 10n ** 24n), balance1: address === POOL_IDLE ? '1' : String(3n * 10n ** 12n),
      // 每秒 0.1 AERO 的累计排放。
      rewardShare: address === POOL_IDLE ? null : String(BigInt(t - 1_700_000_000) * 10n ** 17n),
    };
  };
  const blockAt = (t) => Math.round((t - 1_700_000_000) / BLOCK_TIME);
  const reads = {
    async readPoolAddresses(_rpc, _factory, known, limit = Infinity) { const all = Object.keys(statics); return { total: all.length, added: all.slice(known, known + limit) }; },
    async readPoolStatics(_rpc, pools) { return pools.map((a) => ({ ...statics[a], gauge: undefined })); },
    async readGauges(_rpc, pools) { return pools.map((a) => statics[a].gauge); },
    async readTokens(_rpc, list) { return list.map((t) => ({ symbol: t === WETH ? 'WETH' : t === USDC ? 'USDC' : 'AERO', decimals: t === USDC ? 6 : 18 })); },
    async readPoolStates(_rpc, pools, block) {
      chain.stateReads++;
      if (chain.failState) throw new Error('eth_call HTTP 503');
      return { block, timestamp: chain.t, states: pools.map((p) => stateOf(p.address, chain.t)) };
    },
    async readPoolHistory(_rpc, pools, block, full) {
      if (chain.failHistory) throw Object.assign(new Error(chain.failHistory === 'node' ? 'missing trie node' : 'eth_call 超时'), { kind: chain.failHistory === 'node' ? 'node' : 'timeout' });
      chain.historyBlocks.push(block);
      // historyBlockTime ≠ BLOCK_TIME 时模拟出块时间外推偏差：读到的时间戳离请求的整点越来越远。
      let t = Math.round(chain.t - (blockAt(chain.t) - block) * historyBlockTime);
      // stall：3 天前链停摆过这么久，更早的区块实际时间整体前移。
      if (chain.t - t > 3 * 86400) t -= stall;
      return { block, timestamp: t, states: pools.map((p) => { const s = stateOf(p.address, t); return full ? { tick: s.tick, rewardShare: s.rewardShare } : { tick: s.tick }; }) };
    },
  };
  chain.liquidityReads = 0; chain.failLiquidity = false;
  reads.readPoolLiquidity = async (_rpc, pool) => {
    chain.liquidityReads++;
    if (chain.failLiquidity) throw new Error('eth_call 超过 10 秒未响应');
    const s = stateOf(pool.address, chain.t), lower = Math.floor(s.tick / pool.tickSpacing) * pool.tickSpacing - pool.tickSpacing;
    return { block: blockAt(chain.t), tick: s.tick, sqrtPriceX96: s.sqrtPriceX96, liquidity: s.liquidity, stakedLiquidity: s.stakedLiquidity, from: s.tick - 1000, to: s.tick + 1000,
      ticks: [[lower, s.liquidity, s.stakedLiquidity], [lower + 3 * pool.tickSpacing, `-${s.liquidity}`, `-${s.stakedLiquidity}`]] };
  };
  const rpc = { blockNumber: async () => blockAt(chain.t), blockTimestamp: async (n) => 1_700_000_000 + n * BLOCK_TIME };
  return { chain, reads, createRpc: () => rpc };
}

function timers() {
  const queue = [];
  return {
    queue,
    setTimer(fn, ms) { const handle = { fn, ms, cleared: false }; queue.push(handle); return handle; },
    clearTimer(handle) { if (handle) handle.cleared = true; },
    pending() { return queue.filter((h) => !h.cleared && !h.fired); },
    async fire() { const h = this.pending()[0]; assert.ok(h, 'expected a scheduled run'); h.fired = true; h.fn(); await new Promise((r) => setImmediate(r)); },
  };
}

function onlyBase(dir, extra = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const id of Object.keys(config.chains)) config.chains[id].enabled = id === 'base';
  mkdirSync(join(dir, 'aero-market'), { recursive: true });
  writeFileSync(join(dir, 'aero-market/config.json'), JSON.stringify({ ...config, ...extra }));
}

// 此文件最长的注入预算为 2000 ms × 首次发现 3 倍；上限覆盖截止与事件循环余量，达到明确终态即返回。
async function settle(market, { timeoutMs = 10_000 } = {}) {
  await waitFor(() => market.state().chains.every((c) => c.status !== 'loading'), { timeoutMs, message: '扫描未进入终态' });
}

async function waitFor(predicate, { timeoutMs = 4000, message = '等待条件超时' } = {}) {
  const until = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < until, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('settle explicitly fails if a scan never reaches a terminal state', async () => {
  await assert.rejects(settle({ state: () => ({ chains: [{ id: 'base', status: 'loading' }] }) }, { timeoutMs: 40 }), /扫描未进入终态/);
});

test('scan builds rows with prices, emission and backfilled volatility, then retains them through a failure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  assert.equal(clock.pending().length, 1, 'only the enabled chain is scheduled');
  await clock.fire(); await settle(market);
  let state = market.state();
  const base = state.chains.find((c) => c.id === 'base');
  assert.equal(base.status, 'ok');
  assert.equal(base.poolCount, 3); assert.equal(base.activeCount, 2); assert.equal(base.gaugeCount, 2);
  assert.equal(state.pools.length, 2);
  assert.ok(Math.abs(state.aero.usd - 0.6) < 1e-6);
  const weth = state.pools.find((p) => p.address === POOL_WETH);
  assert.ok(Math.abs(weth.token0.usd - 3000) / 3000 < 0.02);
  assert.ok(Math.abs(weth.emissionPerSec - 0.1) < 1e-9, 'emission comes from backfilled history');
  assert.ok(weth.tvlUsd > 3e6);
  // 首轮最多回填 24 个小时点，波动率 24h 已可用、7d 样本不足。
  assert.equal(fake.chain.historyBlocks.length, 24);
  assert.ok(weth.vol24h?.daily > 0); assert.equal(weth.vol7d, null);
  // 实盘单池上限用的代币美元价与页面行同源，带快照时间。
  const prices = market.tokenPrices();
  assert.equal(prices.usd[weth.token0.address.toLowerCase()], weth.token0.usd);
  assert.ok(Number.isFinite(prices.at) && prices.at <= fake.chain.t * 1000);
  assert.equal(base.history.archive, 'archive');
  const next = clock.pending()[0];
  assert.equal(base.history.pending, 168 - 1 - 24, '7 天整点中还有这些没补');
  assert.equal(next.ms, 30_000, 'unfinished backfill continues soon instead of waiting the full interval');

  // revision 未变时只回 unchanged。
  assert.deepEqual(Object.keys(market.state({ since: state.revision })).sort(), ['revision', 'schema', 'serverNow', 'unchanged']);

  fake.chain.t += 900; fake.chain.failState = true;
  await clock.fire(); await settle(market);
  state = market.state();
  const failed = state.chains.find((c) => c.id === 'base');
  assert.equal(failed.status, 'error'); assert.match(failed.error, /503/);
  assert.equal(state.pools.length, 2, 'rows from the last good scan stay visible');
  assert.equal(clock.pending()[0].ms, 60_000, 'first failure retries after 60 s');
  await clock.fire(); await settle(market);
  assert.equal(clock.pending()[0].ms, 120_000, 'second failure backs off');

  fake.chain.failState = false;
  await clock.fire(); await settle(market);
  assert.equal(market.state().chains.find((c) => c.id === 'base').status, 'ok');
  assert.equal(clock.pending()[0].ms, 30_000);
  await market.close();

  // 重启后从磁盘恢复行与历史，不必等下一轮。
  const files = ['registry-base.json', 'snapshot-base.json', 'history-base.json'].map((f) => JSON.parse(readFileSync(join(dir, 'aero-market', f), 'utf8')));
  assert.equal(files[0].schema, 1); assert.ok(files[2].points.length >= 24);
  const reopened = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await reopened.initialize();
  assert.equal(reopened.state().pools.length, 2);
  const history = reopened.pool('base', POOL_WETH.toUpperCase().replace('0X', '0x'));
  assert.ok(history.points.length >= 25);
  assert.throws(() => reopened.pool('base', POOL_IDLE), /没有这个池子/);
  await reopened.close();
});

test('each scan records hourly samples for gauge pools, served per window and only for enabled chains', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  const options = { dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer };
  const market = createAeroMarket(options);
  await market.initialize();
  await clock.fire(); await settle(market);
  const first = market.state().samples;
  assert.equal(first.available, true); assert.ok(first.version > 0);
  const read = market.samples('7d');
  assert.deepEqual(Object.keys(read.pools).sort(), [`base:${POOL_WETH}`, `base:${POOL_AERO}`].sort());
  const [sample] = read.pools[`base:${POOL_WETH}`].samples;
  assert.equal(sample[0], Math.floor(fake.chain.t / 3600) * 3600);
  assert.ok(Math.abs(sample[5] - 0.1 * 0.6) < 1e-6, 'emission is stored in USD at the AERO price of that scan');
  assert.throws(() => market.samples('1y'), (e) => e.status === 400);
  // 浏览器带着缓存的标签来问：内容没变只回未变化标记。
  assert.ok(read.tag);
  assert.deepEqual(market.samples('7d', read.tag), { window: '7d', available: true, unchanged: true, tag: read.tag, version: read.version });
  assert.equal(market.samples('24h', read.tag).unchanged, undefined, 'a tag only matches its own window');
  // 同一整点的后续轮次不新增样本；下一个整点再记一条。
  await clock.fire(); await settle(market);
  assert.equal(market.samples('7d').pools[`base:${POOL_WETH}`].hours, 1);
  fake.chain.t += 3600;
  while (clock.pending()[0]?.ms === 30_000) { await clock.fire(); await settle(market); }
  await clock.fire(); await settle(market);
  assert.equal(market.samples('7d').pools[`base:${POOL_WETH}`].hours, 2);
  assert.equal(market.samples('7d', read.tag).unchanged, undefined, 'a new hourly sample changes the tag');
  const beforeToggle = market.samples('7d').tag;
  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, enabled: false } } });
  assert.deepEqual(market.samples('7d', beforeToggle).pools, {}, 'disabled chains are hidden like their rows, even for a cached tag');
  await market.close();
  const reopened = createAeroMarket(options);
  await reopened.initialize();
  await reopened.save(config);
  const afterRestart = reopened.samples('7d', beforeToggle);
  assert.equal(afterRestart.pools[`base:${POOL_WETH}`].hours, 2, 'samples survive a restart and an old tag never matches the new process');
  await reopened.close();
});

test('replay runs the recommended cells over hourly samples and skips short, unknown or disabled pools', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  t.after(() => market.close());
  await market.initialize();
  await clock.fire(); await settle(market);
  const body = (pools, extra = {}) => ({ window: '7d', deposit: 1000, delayMin: 5, pools, ...extra });
  const pools = [['base', POOL_WETH, 10], ['base', POOL_AERO, 0], ['base', `0x${'9'.repeat(40)}`, 3]];
  assert.deepEqual((await market.replay(body(pools))).pools, {}, 'one hourly sample is not enough');
  for (let h = 0; h < 7; h++) {
    fake.chain.t += 3600;
    while (clock.pending()[0]?.ms === 30_000) { await clock.fire(); await settle(market); }
    await clock.fire(); await settle(market);
  }
  const result = await market.replay(body(pools));
  assert.equal(result.available, true);
  assert.deepEqual(Object.keys(result.pools).sort(), [`base:${POOL_AERO}`, `base:${POOL_WETH}`].sort(), 'unknown pools are skipped');
  const weth = result.pools[`base:${POOL_WETH}`];
  assert.ok(weth.hours >= 6 && weth.emission > 0, JSON.stringify(weth));
  // 响应按 5 位有效数字取整，恒等式按最大分量的精度核对。
  assert.ok(Math.abs(weth.net - (weth.emission - weth.impermanent - weth.cost)) <= 1e-4 * Math.max(Math.abs(weth.emission), Math.abs(weth.impermanent), weth.cost, 1e-9), JSON.stringify(weth));
  for (const bad of [body(pools, { window: '1y' }), body(pools, { deposit: 0 }), body(pools, { delayMin: 2000 }), body([['base', POOL_WETH.toUpperCase(), 1]]), body([['base', POOL_WETH, 1.5]]),
    body([['mars', POOL_WETH, 1]]), body(Array.from({ length: 251 }, () => ['base', POOL_WETH, 1])), { ...body(pools), extra: 1 }]) {
    await assert.rejects(market.replay(bad), (e) => e.status === 400);
  }
  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, enabled: false } } });
  assert.deepEqual((await market.replay(body(pools))).pools, {}, 'disabled chains are not replayed');
});

test('favorites are validated, persisted in order and survive a restart; a broken file falls back with a notice', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  const options = { dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer };
  const market = createAeroMarket(options);
  await market.initialize();
  assert.deepEqual(market.state().favorites, []);
  const before = market.state().revision;
  const upper = `base:0x${'A'.repeat(40)}`;
  // 两次连续保存串行写入：内存和文件都是最后一次的结果。
  const [, last] = await Promise.all([market.saveFavorites([`base:${POOL_WETH}`]), market.saveFavorites([`base:${POOL_AERO}`, upper, upper.toLowerCase(), `base:${POOL_WETH}`])]);
  assert.deepEqual(last.favorites, [`base:${POOL_AERO}`, `base:0x${'a'.repeat(40)}`, `base:${POOL_WETH}`], 'addresses are lowercased and deduplicated in order');
  assert.ok(last.revision > before, 'saving bumps the revision so polling clients pick it up');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'aero-market/favorites.json'), 'utf8')), last.favorites);
  for (const bad of ['base:0x1', `solana:${POOL_WETH}`, [`base:${POOL_WETH}`], Array.from({ length: 501 }, (_, i) => `base:0x${i.toString(16).padStart(40, '0')}`)]) {
    await assert.rejects(market.saveFavorites(Array.isArray(bad) && bad.length > 1 ? bad : Array.isArray(bad) ? bad[0] : [bad]), (e) => e.status === 400);
  }
  assert.equal(market.state().favorites.length, 3, 'a rejected save keeps the previous list');
  await assert.rejects(market.saveFavorites([], () => { throw Object.assign(new Error('expired'), { status: 401 }); }), (e) => e.status === 401);
  await market.close();
  const reopened = createAeroMarket(options);
  await reopened.initialize();
  assert.deepEqual(reopened.state().favorites, last.favorites);
  await reopened.close();
  writeFileSync(join(dir, 'aero-market/favorites.json'), '{"x":1}');
  const broken = createAeroMarket(options);
  await broken.initialize();
  assert.deepEqual(broken.state().favorites, []);
  assert.match(broken.state().favoritesError, /收藏文件无效/);
  assert.equal(readFileSync(join(dir, 'aero-market/favorites.json'), 'utf8'), '{"x":1}', 'the invalid file is kept until the next save');
  await broken.close();
});

test('liquidity distribution is read on demand, shared within 60 s, never cached on failure and refused for disabled chains', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  await assert.rejects(market.liquidity('base', POOL_WETH), (e) => e.status === 404, 'pools are only read after the scan knows them');
  await clock.fire(); await settle(market);
  const [a, b] = await Promise.all([market.liquidity('base', POOL_WETH), market.liquidity('base', POOL_WETH.toUpperCase().replace('0X', '0x'))]);
  assert.equal(fake.chain.liquidityReads, 1, 'concurrent requests share one chain read');
  assert.equal(a, b);
  assert.equal(a.segments.length, 3);
  assert.deepEqual(a.segments[1].slice(2), [1e18, 5e17]);
  fake.chain.t += 59;
  await market.liquidity('base', POOL_WETH);
  assert.equal(fake.chain.liquidityReads, 1, 'a result is reused for 60 s');
  fake.chain.t += 2;
  fake.chain.failLiquidity = true;
  await assert.rejects(market.liquidity('base', POOL_WETH), (e) => e.status === 502 && /流动性分布/.test(e.message));
  fake.chain.failLiquidity = false;
  await market.liquidity('base', POOL_WETH);
  assert.equal(fake.chain.liquidityReads, 3, 'a failure is not cached, the next request reads again');
  fake.chain.t += 10;
  await clock.fire(); await settle(market);
  await market.liquidity('base', POOL_WETH);
  assert.equal(fake.chain.liquidityReads, 4, 'a scan that changed the pool state is not answered from the cache');
  await assert.rejects(market.liquidity('base', '0x1234'), (e) => e.status === 404);
  await assert.rejects(market.liquidity('nope', POOL_WETH), (e) => e.status === 404);
  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, enabled: false } } });
  await assert.rejects(market.liquidity('base', POOL_WETH), (e) => e.status === 409, 'a disabled chain is not read even though its last rows are kept');
  await market.close();
});

test('pool price history extends past the 7-day local history with hourly samples', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  await clock.fire(); await settle(market);
  const firstScan = fake.chain.t;
  // 推进 8 天：本机历史只留 7 天，更早的整点由样本库补上，时间严格递增、不重复。
  for (let h = 0; h < 8 * 24; h++) { fake.chain.t += 3600; while (clock.pending()[0]?.ms === 30_000) { await clock.fire(); await settle(market); } await clock.fire(); await settle(market); }
  const points = market.pool('base', POOL_WETH).points;
  assert.ok(points.some(([t]) => t === Math.floor(firstScan / 3600) * 3600_000), 'the first scan hour is still served from samples after it left the local history');
  assert.ok(points.every((p, i) => i === 0 || p[0] > points[i - 1][0]), 'points are strictly increasing');
  assert.ok(fake.chain.t * 1000 - points[0][0] > 7.5 * 86400_000);
  await market.close();
});

test('archive failure falls back to locally accumulated hourly samples', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  fake.chain.failHistory = 'timeout';
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  await clock.fire(); await settle(market);
  let base = market.state().chains.find((c) => c.id === 'base');
  assert.equal(base.status, 'ok');
  assert.equal(base.history.archive, 'archive', 'a transient history error only ends this round of backfill');
  assert.equal(base.history.points, 0);
  fake.chain.failHistory = 'node'; fake.chain.t += 900;
  await clock.fire(); await settle(market);
  base = market.state().chains.find((c) => c.id === 'base');
  assert.equal(base.status, 'ok', 'a history failure does not fail the scan');
  assert.equal(base.history.archive, 'unavailable');
  assert.equal(base.history.points, 1);
  fake.chain.t += 900; await clock.fire(); await settle(market);
  assert.equal(market.state().chains.find((c) => c.id === 'base').history.points, 1, 'local samples are at least 50 minutes apart');
  fake.chain.t += 2200; await clock.fire(); await settle(market);
  base = market.state().chains.find((c) => c.id === 'base');
  assert.equal(base.history.points, 2);
  // 排放速率来自本机样本。
  assert.ok(Math.abs(market.state().pools.find((p) => p.address === POOL_WETH).emissionPerSec - 0.1) < 1e-9);
  await market.close();
});

test('backfill tracks requested hours, so a block-time estimate error never re-reads the same hour', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain({ historyBlockTime: BLOCK_TIME * 1.05 }), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  for (let i = 0; i < 4; i++) { await clock.fire(); await settle(market); fake.chain.t += 900; }
  await market.close();
  const points = JSON.parse(readFileSync(join(dir, 'aero-market/history-base.json'), 'utf8')).points;
  const slots = points.map((p) => p.slot);
  assert.equal(new Set(slots).size, slots.length, 'no hour is stored twice');
  // 偏差下较早整点的实际时间离整点已超过 20 分钟。
  assert.ok(points.some((p) => Math.abs(p.t - p.slot) > 1200));
  assert.ok(points.length >= 72);
});

test('backfill under block-time drift finishes instead of re-reading pruned old hours every 30 s', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  // 3 天前停摆 1.5 小时：最老整点的实际时间早于 7 天窗口，且离任何整点都超过 20 分钟。
  // 整点后 40 分钟开始：最老整点只比 7 天窗口新 20 分钟，前移 1.5 小时后落到保留线之外。
  const fake = fakeChain({ start: 1_800_000_000 + 2400, stall: 5400 }), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  let batches = 0;
  for (; batches < 12; batches++) { await clock.fire(); await settle(market); if (clock.pending()[0].ms !== 30_000) break; fake.chain.t += 30; }
  assert.ok(batches < 12, 'backfill terminates');
  // 之后的常规轮次不能把被清理掉的老整点重新算作待补。
  for (let i = 0; i < 3; i++) {
    assert.equal(clock.pending()[0].ms, 15 * 60 * 1000);
    fake.chain.t += 900; await clock.fire(); await settle(market);
  }
  assert.equal(clock.pending()[0].ms, 15 * 60 * 1000);
  assert.equal(market.state().chains.find((c) => c.id === 'base').history.pending, 0);
  assert.equal(new Set(fake.chain.historyBlocks).size, fake.chain.historyBlocks.length, 'no hour is read twice');
  await market.close();
});

test('current rows publish before backfill, and backfill batches follow every 30 s until done', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  let release;
  const gate = new Promise((r) => { release = r; });
  const readHistory = fake.reads.readPoolHistory;
  fake.reads.readPoolHistory = async (...args) => { await gate; return readHistory(...args); };
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  const before = market.state().revision;
  await clock.fire();
  for (let i = 0; i < 20 && !market.state().pools.length; i++) await new Promise((r) => setTimeout(r, 5));
  let state = market.state();
  assert.equal(state.chains.find((c) => c.id === 'base').status, 'loading', 'backfill still running');
  assert.equal(state.chains.find((c) => c.id === 'base').nextAt, null, 'a running round has no past "next" time');
  assert.equal(state.chains.find((c) => c.id === 'base').history.nextAt, null);
  assert.equal(state.pools.length, 2, 'current rows are visible while history is backfilled');
  assert.ok(state.revision > before);
  release(); await settle(market);
  // 追批期间保存设置或重启都不打断短间隔。
  await market.save(market.state().config);
  assert.ok(clock.pending()[0].ms <= 30_000, 'saving config keeps the follow-up cadence');
  await market.close();
  const restarted = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  t.after(() => restarted.close());
  await restarted.initialize();
  assert.ok(restarted.state().chains.find((c) => c.id === 'base').history.pending > 0, 'pending is estimated from saved history');
  assert.ok(clock.pending()[0].ms <= 30_000, 'restart resumes the follow-up cadence');
  const delays = [];
  for (let i = 0; i < 10; i++) {
    delays.push(clock.pending()[0].ms);
    if (delays.at(-1) !== 30_000) break;
    fake.chain.t += 30; await clock.fire(); await settle(restarted);
  }
  // 167 个整点按每批 24 个，要 7 批；之后回到常规间隔。
  assert.deepEqual(delays, [30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 15 * 60 * 1000]);
  state = restarted.state();
  assert.equal(state.chains.find((c) => c.id === 'base').history.pending, 0);
  assert.equal(new Set(fake.chain.historyBlocks).size, fake.chain.historyBlocks.length, 'no hour is read twice');

  // 回填出错（如限流）不追批，按常规间隔再试。
  fake.chain.t += 3 * 3600; fake.chain.failHistory = 'timeout';
  await clock.fire(); await settle(restarted);
  assert.ok(restarted.state().chains.find((c) => c.id === 'base').history.pending > 0);
  assert.equal(clock.pending()[0].ms, 15 * 60 * 1000);
  await restarted.close();
});

test('config is strict, invalid saved config falls back with a notice, and refresh is rate limited', async (t) => {
  assert.throws(() => strictMarketConfig({ ...DEFAULT_CONFIG, extra: 1 }), /不支持/);
  assert.throws(() => strictMarketConfig({ ...DEFAULT_CONFIG, intervalMin: 1 }), /5–240/);
  const badRpc = structuredClone(DEFAULT_CONFIG); badRpc.chains.base.rpcUrl = 'http://example.com';
  assert.throws(() => strictMarketConfig(badRpc), /https/);
  const local = structuredClone(DEFAULT_CONFIG); local.chains.base.rpcUrl = ' http://127.0.0.1:8545 ';
  assert.equal(strictMarketConfig(local).chains.base.rpcUrl, 'http://127.0.0.1:8545');

  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'aero-market'));
  writeFileSync(join(dir, 'aero-market/config.json'), '{broken');
  const fake = fakeChain(), clock = timers();
  const market = createAeroMarket({ dataDir: dir, enabledByDefault: false, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  let state = market.state();
  assert.match(state.configError, /无效/);
  assert.equal(state.config.enabled, false);
  assert.equal(clock.pending().length, 0);
  assert.throws(() => market.refresh(), /已停用/);
  assert.equal(readFileSync(join(dir, 'aero-market/config.json'), 'utf8'), '{broken', 'the invalid file is kept until a save');

  const next = structuredClone(DEFAULT_CONFIG);
  for (const id of Object.keys(next.chains)) next.chains[id].enabled = id === 'base';
  state = await market.save(next);
  assert.equal(state.configError, null);
  assert.equal(state.chains.find((c) => c.id === 'optimism').status, 'disabled');
  assert.equal(clock.pending().length, 1);
  market.refresh(); await settle(market);
  assert.equal(fake.chain.stateReads, 1);
  market.refresh(); await settle(market);
  assert.equal(fake.chain.stateReads, 1, 'a second manual refresh within 30 s is ignored');
  await market.close();
});

// 慢节点：每次读取都在单次超时内返回，但累计超过整轮预算；读取遵守 rpc 上的取消信号。
function slowChain() {
  // stubborn：这些读取不理会取消信号（读完才返回），模拟读取已完成但整轮已到期。fail：这些读取直接报错。
  const fake = fakeChain(), delays = { block: 0, state: 0, history: 0, addresses: 0, statics: 0, tokens: 0, gauges: 0 }, seen = { aborted: 0, statics: 0, gauges: 0, addressesFrom: [] };
  const stubborn = new Set(), fail = new Set();
  const wait = (ms, signal, name) => new Promise((resolve, reject) => {
    if (fail.has(name)) return reject(new Error(`${name} 节点错误：execution reverted`));
    if (stubborn.has(name)) { setTimeout(resolve, ms); return; }
    let timer;
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); seen.aborted++; reject(Object.assign(new Error('eth_call 超过 20 秒未响应'), { kind: 'timeout' })); };
    if (signal?.aborted) return cancel();
    if (!ms) return resolve();
    timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  const createRpc = (options) => {
    const base = fake.createRpc(options);
    return { ...base, url: options.url, signal: options.signal, blockNumber: async () => { await wait(delays.block, options.signal, 'block'); return base.blockNumber(); } };
  };
  const reads = {
    ...fake.reads,
    readPoolStates: async (rpc, ...rest) => { await wait(delays.state, rpc.signal, 'state'); return fake.reads.readPoolStates(rpc, ...rest); },
    readPoolHistory: async (rpc, ...rest) => { await wait(delays.history, rpc.signal, 'history'); return fake.reads.readPoolHistory(rpc, ...rest); },
    readPoolAddresses: async (rpc, factory, known, ...rest) => { seen.addressesFrom.push(known); await wait(delays.addresses, rpc.signal, 'addresses'); return fake.reads.readPoolAddresses(rpc, factory, known, ...rest); },
    readPoolStatics: async (rpc, pools) => { if (pools.length) { seen.statics++; await wait(delays.statics, rpc.signal, 'statics'); } return fake.reads.readPoolStatics(rpc, pools); },
    readTokens: async (rpc, list) => { if (list.length) await wait(delays.tokens, rpc.signal, 'tokens'); return fake.reads.readTokens(rpc, list); },
    readGauges: async (rpc, pools) => { seen.gauges++; await wait(delays.gauges, rpc.signal, 'gauges'); return fake.reads.readGauges(rpc, pools); },
  };
  return { ...fake, reads, createRpc, delays, seen, stubborn, fail };
}

test('a scan round has an overall deadline: slow reads are aborted, the chain is released, the last rows stay and the next round starts normally', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer, cycleDeadlineMs: 100 });
  await market.initialize();
  await clock.fire(); await settle(market);
  const good = market.state().chains.find((c) => c.id === 'base');
  assert.equal(good.status, 'ok');

  // 两次读取各 150 ms，单次都不超时，合计超过 100 ms 的整轮预算。
  fake.chain.t += 30; fake.delays.block = 150; fake.delays.state = 150;
  const started = Date.now();
  await clock.fire(); await settle(market);
  const elapsed = Date.now() - started;
  let state = market.state(), base = state.chains.find((c) => c.id === 'base');
  assert.equal(base.status, 'error');
  assert.match(base.error, /本轮扫描超过/);
  assert.ok(fake.seen.aborted >= 1, 'the in-flight read is cancelled');
  assert.ok(elapsed < 300, `the chain is released at the deadline, before both reads (300 ms) finish (${elapsed} ms)`);
  assert.equal(state.pools.length, 2, 'rows from the last good round stay');
  assert.equal(base.updatedAt, good.updatedAt);
  assert.equal(clock.pending()[0].ms, 60_000, 'bounded retry after the usual failure backoff');

  fake.delays.block = 0; fake.delays.state = 0;
  await clock.fire(); await settle(market);
  base = market.state().chains.find((c) => c.id === 'base');
  assert.equal(base.status, 'ok', 'the next round starts and completes normally');
  assert.equal(base.error, null);

  // 预算在回填中耗尽：本轮当前数据照常发布，回填按常规间隔再试，不追批。
  fake.chain.t += 30; fake.delays.history = 60;
  await clock.fire(); await settle(market);
  state = market.state(); base = state.chains.find((c) => c.id === 'base');
  assert.equal(base.status, 'ok');
  assert.equal(base.updatedAt, fake.chain.t * 1000, 'current data of this round is published');
  assert.ok(base.history.pending > 0);
  assert.equal(clock.pending()[0].ms, 15 * 60 * 1000);
  await market.close();
});

const marketWith = (dir, fake, clock, extra = {}) => createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra });
const baseOf = (market) => market.state().chains.find((c) => c.id === 'base');

test('switching RPC clears a recorded archive failure while a TVL-only change preserves it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock);
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  fake.chain.failHistory = 'node';
  await market.initialize();
  await clock.fire(); await settle(market);
  const oldRetry = baseOf(market).history.nextAt;
  assert.equal(baseOf(market).history.archive, 'unavailable');
  fake.chain.failHistory = null;
  await market.save({ ...market.state().config, minTvlUsd: 0 });
  fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(fake.chain.historyBlocks.length, 0, 'a TVL threshold does not change the same RPC archive capability');
  assert.equal(baseOf(market).history.nextAt, oldRetry);
  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl: 'https://readable-archive.example/rpc' } } });
  fake.chain.t += 60;
  assert.ok(fake.chain.t * 1000 < oldRetry);
  await clock.fire(); await settle(market);
  assert.ok(fake.chain.historyBlocks.length > 0, 'the new node must read history before the old six-hour pause expires');
  assert.equal(baseOf(market).history.archive, 'archive');
  assert.equal(baseOf(market).history.phase, 'catching_up');
  assert.ok(baseOf(market).history.nextAt < oldRetry);
});

test('liquidity cache is tied to RPC identity but not the discovery TVL threshold', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock);
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await settle(market);
  const first = await market.liquidity('base', POOL_WETH);
  await market.save({ ...market.state().config, minTvlUsd: 0 });
  assert.equal(await market.liquidity('base', POOL_WETH), first);
  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl: 'https://new-liquidity.example/rpc' } } });
  assert.notEqual(await market.liquidity('base', POOL_WETH), first, 'an unchanged pool snapshot cannot reuse a result from the old RPC');
  assert.equal(fake.chain.liquidityReads, 2);
});

test('a late liquidity failure uses its original RPC for redaction and preserves the new cache entry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(async () => { release(); await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  const config = market.state().config, rpcUrl = 'https://old-rpc.example/probeAlpha%2Bbeta%2Fgamma%3D';
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl } } });
  await clock.fire(); await settle(market);
  const original = fake.reads.readPoolLiquidity, seen = [];
  fake.reads.readPoolLiquidity = async (rpc, ...args) => {
    seen.push(rpc.url);
    if (rpc.url === rpcUrl) { await gate; throw new Error('quota denied: probeAlpha+beta/gamma='); }
    return original(rpc, ...args);
  };
  const oldRead = market.liquidity('base', POOL_WETH).catch((error) => error);
  await waitFor(() => seen.length === 1);
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl: 'https://new-rpc.example/rpc' } } });
  const current = await market.liquidity('base', POOL_WETH);
  release();
  const oldError = await oldRead;
  assert.equal(oldError.status, 502);
  assert.match(oldError.message, /quota denied/);
  assert.doesNotMatch(oldError.message, /probeAlpha/);
  assert.equal(await market.liquidity('base', POOL_WETH), current);
  assert.equal(seen.length, 2, 'the old rejected request must not remove or refill the replacement entry');
});

for (const sink of ['scan', 'discovery', 'history', 'liquidity']) test(`RPC diagnostic exits redact credentials: ${sink}`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers(), logs = [];
  const market = marketWith(dir, fake, clock, { log: { ...silent, warn: (...args) => logs.push(args) } });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  const config = market.state().config;
  const rpcUrl = 'https://rpc.example/v2/probeAlpha%2Bbeta%2Fgamma%3D';
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl } } });
  await clock.fire(); await settle(market);
  const failure = () => { throw Object.assign(new Error(`quota denied: probeAlpha+beta/gamma= at ${rpcUrl}`), { kind: 'node' }); };
  if (sink === 'scan') fake.reads.readPoolStates = failure;
  if (sink === 'discovery') fake.reads.readGauges = failure;
  if (sink === 'history') fake.reads.readPoolHistory = failure;
  let diagnostic;
  if (sink === 'liquidity') {
    fake.reads.readPoolLiquidity = failure;
    await assert.rejects(market.liquidity('base', POOL_WETH), (error) => {
      diagnostic = JSON.stringify(errorResponder([HttpError])(error));
      return error.status === 502;
    });
  } else {
    fake.chain.t += sink === 'discovery' ? 6 * 3600 + 1 : 60;
    await clock.fire(); await settle(market);
    diagnostic = JSON.stringify({ chains: market.state().chains.map((c) => ({ error: c.error, discovery: c.discovery })), logs });
  }
  assert.match(diagnostic, /quota denied/);
  assert.doesNotMatch(diagnostic, /probeAlpha|rpc\.example|https:\/\//, 'no RPC diagnostic exit may expose the configured credential or URL');
});

test('browser snapshot cache omits RPC diagnostic text as well as configured URLs', async () => {
  // 执行共用客户端实际的缓存投影与旧缓存回调；不运行 hook、不复制脱敏规则。
  const ts = await import('typescript');
  const source = readFileSync(new URL('../src/aero-market-client.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('aero-market-client.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = file.statements.filter((row) => ts.isVariableStatement(row) && row.declarationList.declarations.some((d) => ['forCache', 'usableSnapshot'].includes(d.name.getText(file))));
  let restore;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "readCache<MarketSnapshot>('snapshot').then") restore = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(statements.length, 2); assert.ok(restore);
  const code = ts.transpileModule(`${statements.map((s) => s.getText(file)).join('\n')}\nmodule.exports = { forCache, restore: ${restore.getText(file)} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  let displayed, savedAt, cleared = 0;
  const context = { module: { exports: {} }, controller: { signal: { aborted: false } }, revision: { current: null },
    clearCache: async () => { cleared++; }, setSnapshot: (value) => { displayed = value; }, setCachedAt: (value) => { savedAt = value; } };
  runInNewContext(code, context);
  const project = context.module.exports.forCache;
  const snapshot = { schema: 1, aero: { usd: null, at: null }, config: { chains: { base: { enabled: true, rpcUrl: 'https://rpc.example/probeAlpha%2Bbeta' } } }, pools: [],
    chains: [{ id: 'base', error: 'probeAlpha+beta', discovery: { error: 'probeAlpha%2Bbeta', failures: 1 } }] };
  const cached = project(snapshot);
  assert.doesNotMatch(JSON.stringify(cached), /probeAlpha|rpc\.example/);
  assert.equal(snapshot.chains[0].error, 'probeAlpha+beta', 'the cache projection does not mutate live diagnostics');
  snapshot.config.chains.base.rpcUrl = '';
  context.module.exports.restore({ data: snapshot, savedAt: 123 });
  assert.equal(cleared, 1, 'the legacy persisted diagnostics are cleared even when the URL was already omitted');
  assert.equal(savedAt, 123);
  assert.doesNotMatch(JSON.stringify(displayed), /probeAlpha/);
  context.module.exports.restore({ data: cached, savedAt: 456 });
  assert.equal(cleared, 1, 'a clean cache stays available');
  assert.equal(savedAt, 456);
});

test('rediscovery eventually completes across rounds with current reads taking more than 60 percent of the budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 500 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  fake.chain.failHistory = 'node';
  await market.initialize();
  await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
  const discoveredAt = baseOf(market).discovery.at;
  fake.delays.state = 360; fake.delays.addresses = 10; fake.delays.gauges = 10;
  fake.chain.t += 6 * 3600 + 1;
  let activeReads = 0, maxReads = 0;
  const readStates = fake.reads.readPoolStates;
  fake.reads.readPoolStates = async (...args) => {
    maxReads = Math.max(maxReads, ++activeReads);
    try { return await readStates(...args); } finally { activeReads--; }
  };
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    await clock.fire();
    market.refresh();
    await waitFor(() => baseOf(market).status !== 'loading');
    const base = baseOf(market);
    rounds.push({ status: base.status, updatedAt: base.updatedAt, discoveryAt: base.discovery.at, failures: base.discovery.failures, gauges: fake.seen.gauges });
    assert.equal(base.status, 'ok');
    assert.equal(base.updatedAt, fake.chain.t * 1000, 'slow but successful reads keep the current snapshot fresh');
    assert.equal(clock.pending().length, 1, 'only one next round is scheduled');
    fake.chain.t += 15 * 60;
  }
  t.diagnostic(JSON.stringify(rounds));
  assert.ok(baseOf(market).discovery.at > discoveredAt, 'rediscovery must make progress despite consistently slow current reads');
  assert.equal(baseOf(market).discovery.failures, 0, 'local budget exhaustion is not a node failure');
  assert.equal(baseOf(market).discovery.retryAt, null);
  assert.equal(maxReads, 1, 'manual refresh cannot overlap an existing round');
});

test('rediscovery budget exhaustion does not back off and defers at most one current update', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 300 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  fake.chain.failHistory = 'node';
  await market.initialize();
  await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
  fake.chain.t += 6 * 3600 + 1; fake.delays.gauges = 2000;
  let lastUpdate = baseOf(market).updatedAt;
  for (let round = 0; round < 4; round++) {
    const gauges = fake.seen.gauges;
    await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
    const base = baseOf(market);
    assert.equal(base.status, 'ok');
    assert.deepEqual([base.discovery.failures, base.discovery.error, base.discovery.retryAt], [0, null, null], 'budget exhaustion is a pending task, not a failed node');
    if (round % 2 === 0) {
      assert.equal(base.updatedAt, lastUpdate, 'one round may yield its current read to discovery');
      assert.equal(base.discovery.phase, 'pending');
      assert.equal(base.discovery.refreshPending, true, 'the deferred current update is visible');
      assert.equal(fake.seen.gauges, gauges + 1);
    } else {
      assert.equal(base.updatedAt, fake.chain.t * 1000, 'the next round must update the current snapshot first');
      assert.equal(base.discovery.refreshPending, false);
      assert.equal(fake.seen.gauges, gauges, 'a required current refresh cannot be displaced by another discovery');
      lastUpdate = base.updatedAt;
    }
    assert.equal(clock.pending().length, 1);
    fake.chain.t += 15 * 60;
  }
});

test('changing RPC clears the old discovery failures and backoff before the next attempt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 1000 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
  fake.chain.t += 6 * 3600 + 1; fake.fail.add('gauges');
  await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
  assert.equal(baseOf(market).discovery.failures, 1);
  const retryAt = baseOf(market).discovery.retryAt;
  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl: 'https://new-node.example/rpc' } } });
  assert.deepEqual([baseOf(market).discovery.failures, baseOf(market).discovery.error, baseOf(market).discovery.retryAt], [0, null, null], 'a new RPC does not inherit the old node failure');
  fake.fail.delete('gauges'); fake.chain.t += 60;
  assert.ok(fake.chain.t * 1000 < retryAt);
  const gauges = fake.seen.gauges;
  await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
  assert.equal(fake.seen.gauges, gauges + 1, 'the new node is tried before the old retry deadline');
  assert.equal(baseOf(market).discovery.at, fake.chain.t * 1000);
});

for (const outcome of ['failure', 'success']) test(`a threshold change discards an in-flight discovery ${outcome} from the old generation`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers(), gate = Promise.withResolvers();
  let hold = false, entered = false, lateSuccess = false;
  const readGauges = fake.reads.readGauges;
  fake.reads.readGauges = async (...args) => {
    if (hold) {
      const result = args[1].map((address) => statics[address].gauge);
      entered = true; await gate.promise;
      if (outcome === 'failure') throw new Error('old generation gauges HTTP 503');
      assert.equal(args[0].signal.aborted, true, 'the old request returns successfully despite configuration cancellation');
      lateSuccess = true;
      return result;
    }
    return readGauges(...args);
  };
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 2000 });
  t.after(async () => { gate.resolve(); await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
  const discoveredAt = baseOf(market).discovery.at;
  await market.save({ ...market.state().config, minTvlUsd: 0 });
  fake.chain.t += 60; hold = true;
  await clock.fire(); await waitFor(() => entered);
  await market.save({ ...market.state().config, minTvlUsd: 1e9 });
  gate.resolve();
  await waitFor(() => baseOf(market).status !== 'loading');
  const base = baseOf(market);
  assert.equal(lateSuccess, outcome === 'success', 'the success case really returned data, rather than throwing an abort');
  assert.deepEqual([base.discovery.failures, base.discovery.error, base.discovery.retryAt], [0, null, null], 'old errors cannot reinstate the cleared backoff');
  assert.equal(base.discovery.at, discoveredAt, 'old results cannot replace the registry');
  assert.equal(base.activeCount, 2, 'the old zero threshold cannot publish the third pool');
  hold = false; fake.chain.t += 60;
  await clock.fire(); await waitFor(() => baseOf(market).status !== 'loading');
  assert.equal(baseOf(market).discovery.at, fake.chain.t * 1000, 'the new threshold is retried without waiting for the old failure backoff');
  assert.equal(baseOf(market).activeCount, 2);
});

for (const change of ['RPC', 'threshold']) for (const outcome of ['success', 'failure', 'cancel']) {
  test(`a ${change} change discards an in-flight backfill ${outcome} without changing history or backoff`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
    onlyBase(dir);
    const fake = slowChain(), clock = timers(), gate = Promise.withResolvers();
    let hold = false, entered = false, completed = null;
    const readHistory = fake.reads.readPoolHistory;
    fake.reads.readPoolHistory = async (rpc, ...args) => {
      if (!hold) return readHistory(rpc, ...args);
      const prepared = await readHistory(rpc, ...args);
      entered = true;
      if (outcome === 'cancel') {
        await new Promise((resolve) => {
          if (rpc.signal.aborted) resolve();
          else rpc.signal.addEventListener('abort', resolve, { once: true });
        });
        completed = 'cancel';
        throw rpc.signal.reason;
      }
      await gate.promise;
      assert.equal(rpc.signal.aborted, true);
      completed = outcome;
      if (outcome === 'failure') throw Object.assign(new Error('old archive missing trie node'), { kind: 'node' });
      return prepared;
    };
    const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 2000 });
    t.after(async () => { gate.resolve(); await market.close(); rmSync(dir, { recursive: true, force: true }); });
    await market.initialize();
    await clock.fire(); await settle(market);
    hold = true; fake.chain.t += 60;
    await clock.fire(); await waitFor(() => entered);
    const historyState = () => { const { points, archive, pending, phase } = baseOf(market).history; return { points, archive, pending, phase }; };
    const before = historyState();
    const config = market.state().config;
    await market.save(change === 'RPC'
      ? { ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl: 'https://new-archive.example/rpc' } } }
      : { ...config, minTvlUsd: config.minTvlUsd + 1 });
    gate.resolve();
    await settle(market);
    assert.equal(completed, outcome, 'the fixture exercises the selected completion path');
    assert.deepEqual(historyState(), before, 'an obsolete backfill must not append history or overwrite archive/backoff state');
    assert.ok(baseOf(market).history.nextAt <= fake.chain.t * 1000 + 30_000, 'the old node cannot impose a six-hour archive pause');
    hold = false; fake.chain.t += 60;
    const readsBefore = fake.chain.historyBlocks.length;
    await clock.fire(); await settle(market);
    assert.ok(fake.chain.historyBlocks.length > readsBefore, 'backfill resumes in the new generation immediately');
    assert.equal(baseOf(market).history.archive, 'archive');
  });
}

test('rediscovery without retained progress backs off after three exhausted budgets while current reads continue', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 150 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  fake.chain.failHistory = 'node';
  await market.initialize();
  await clock.fire(); await settle(market);
  fake.chain.t += 6 * 3600 + 1; fake.delays.gauges = 2000;
  let retryAt = null;
  for (let attempt = 1; attempt <= 7; attempt++) {
    if (retryAt !== null) fake.chain.t = retryAt / 1000;
    const gauges = fake.seen.gauges;
    await clock.fire(); await settle(market);
    let base = baseOf(market);
    assert.equal(fake.seen.gauges, gauges + 1);
    assert.deepEqual([base.discovery.failures, base.discovery.error], [0, null], 'budget stalls are distinct from real RPC errors');
    retryAt = attempt < 3 ? null : fake.chain.t * 1000 + Math.min(30 * 60 * 2 ** (attempt - 3), 6 * 3600) * 1000;
    assert.equal(base.discovery.retryAt, retryAt);
    assert.equal(base.discovery.phase, attempt < 3 ? 'pending' : 'budget_backoff');
    if (attempt >= 3) assert.equal(base.discovery.stalledAttempts, attempt);
    fake.chain.t += 60;
    await clock.fire(); await settle(market);
    base = baseOf(market);
    assert.equal(base.updatedAt, fake.chain.t * 1000, 'the next round still refreshes the current snapshot');
    if (attempt >= 3) assert.equal(base.discovery.stalledAttempts, attempt, 'current reads cannot reset discovery stall accounting');
    assert.equal(fake.seen.gauges, gauges + 1);
    if (retryAt !== null) {
      fake.chain.t += 60; market.refresh(); await settle(market);
      assert.equal(fake.seen.gauges, gauges + 1, 'manual refresh respects the bounded budget backoff');
      assert.equal(baseOf(market).updatedAt, fake.chain.t * 1000);
    }
  }
  await market.save({ ...market.state().config, minTvlUsd: 0 });
  assert.equal(baseOf(market).discovery.stalledAttempts, 0);
  assert.equal(baseOf(market).discovery.retryAt, null, 'a new configuration can try immediately');
  fake.delays.gauges = 0; fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).discovery.phase, 'idle');
  assert.equal(baseOf(market).discovery.stalledAttempts, 0);
});

test('new retained discovery progress resets budget stalls and is reused after another timeout', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = slowChain(), clock = timers(), extra = '0x' + '4'.repeat(40);
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 150 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  fake.chain.failHistory = 'node';
  await market.initialize();
  await clock.fire(); await settle(market);
  fake.chain.t += 6 * 3600 + 1; fake.delays.gauges = 2000;
  for (let attempt = 0; attempt < 2; attempt++) {
    await clock.fire(); await settle(market);
    fake.chain.t += 60;
    await clock.fire(); await settle(market);
    fake.chain.t += 60;
  }
  let staticReads = 0;
  fake.reads.readPoolAddresses = async (_rpc, _factory, known) => ({ total: 4, added: known < 4 ? [extra] : [] });
  fake.reads.readPoolStatics = async () => { staticReads++; return [{ ...statics[POOL_IDLE], address: extra }]; };
  const readGauges = fake.reads.readGauges;
  fake.reads.readGauges = async (rpc, addresses) => {
    await readGauges(rpc, addresses.filter((address) => address !== extra));
    return addresses.map((address) => statics[address]?.gauge ?? null);
  };
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).discovery.retryAt, null, 'retained progress prevents a third-attempt budget cooldown');
  assert.equal(baseOf(market).discovery.stalledAttempts, 0);
  assert.equal(staticReads, 1);
  for (let round = 0; round < 2; round++) { fake.chain.t += 60; await clock.fire(); await settle(market); }
  assert.equal(baseOf(market).discovery.stalledAttempts, 1);
  assert.equal(staticReads, 1, 'the timeout retains the newly read pool instead of starting over');
  fake.chain.t += 60; await clock.fire(); await settle(market);
  fake.delays.gauges = 0; fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).poolCount, 4);
  assert.equal(baseOf(market).discovery.stalledAttempts, 0, 'successful discovery clears the stall count');
});

test('first discovery gets the enlarged round budget: it may take longer than a normal round', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  // 普通轮次 100 ms；首次发现的后半段要 150 ms，在放大后的预算（3 倍）内完成。
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 100 });
  await market.initialize();
  fake.delays.gauges = 150;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).status, 'ok', 'first discovery is not cut at the normal round budget');
  assert.equal(market.state().pools.length, 2);
  // 有了池子列表之后回到普通预算：同样慢的当前读数被截止。
  fake.chain.t += 30; fake.delays.state = 150;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).status, 'error');
  assert.match(baseOf(market).error, /本轮扫描超过/);
  await market.close();
});

test('first discovery interrupted by the round deadline keeps its progress and finishes in the next round', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  // 首次发现预算 3 × 150 = 450 ms；静态信息与代币各 300 ms，一轮读不完（10 + 300 + 300 > 450），第二轮只剩代币（10 + 300 < 450）。
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 150 });
  await market.initialize();
  fake.delays.addresses = 10; fake.delays.statics = 300; fake.delays.tokens = 300;
  await clock.fire(); await settle(market);
  let base = baseOf(market);
  assert.equal(base.status, 'error');
  assert.match(base.error, /本轮扫描超过/);
  assert.equal(market.state().pools.length, 0);
  assert.equal(base.poolCount, null, 'an unfinished discovery is not published as the registry');
  assert.equal(fake.seen.statics, 1);

  fake.chain.t += 60;
  await clock.fire(); await settle(market);
  base = baseOf(market);
  assert.equal(base.status, 'ok', 'the second round continues from the saved progress');
  assert.equal(fake.seen.addressesFrom.at(-1), 3, 'pool addresses resume after the ones already read');
  assert.equal(fake.seen.statics, 1, 'pool statics are not read again');
  assert.equal(base.poolCount, 3);
  assert.equal(market.state().pools.length, 2);
  await market.close();
});

test('discovery reads pools in batches and a deadline between batches keeps the finished ones', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  // 每批 1 个池子、每批静态信息 150 ms；首次发现预算 3 × 120 = 360 ms：读完两批后第三批被截止。
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 120, discoveryBatch: 1 });
  await market.initialize();
  fake.delays.statics = 150;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).status, 'error');
  assert.deepEqual(fake.seen.addressesFrom, [0, 1, 2], 'one batch after another');
  fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).status, 'ok');
  assert.deepEqual(fake.seen.addressesFrom.slice(3), [2], 'the next round resumes at the unfinished batch');
  assert.equal(fake.seen.statics, 4, 'only the cut batch is read again');
  assert.equal(baseOf(market).poolCount, 3);
  await market.close();
});

// Base 规模的慢节点（issue #180）：579 个池子，其中 100 个有 gauge 且有流动性（跟踪集合），其余低于 TVL 门槛。
// 每次读取按 aero-market-rpc 的批量参数（每个 aggregate3 120 次调用、并发 3）折算串行批数，每批 round 毫秒；
// 时间按 1 ms 代表 1 秒缩放：20 ms 一批即 20 秒一批，整轮预算 300 ms 即 5 分钟。读取遵守取消信号。
const BASE_POOLS = 579, BASE_TRACKED = 100, ROUND_MS = 20;
function baseScaleChain() {
  // budget：每轮（每个 RPC 实例）可用的批数，用完后的读取挂起到整轮截止，结果不取决于真实计时余量；为 null 时按 round 毫秒/批计时。
  const chain = { t: 1_800_000_000, round: 0, budget: null, gaugeReads: [], stateReads: [] };
  const pools = Array.from({ length: BASE_POOLS }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
  const tracked = new Set(pools.slice(0, BASE_TRACKED));
  const gaugeOf = (address) => (tracked.has(address) ? '0xf' + address.slice(-39) : null);
  const batches = (calls) => Math.ceil(Math.ceil(calls / 120) / 3);
  const blockAt = (t) => Math.round((t - 1_700_000_000) / BLOCK_TIME);
  const left = new WeakMap();
  const wait = (n, signal) => new Promise((resolve, reject) => {
    let timer = null;
    const cancel = () => { clearTimeout(timer); reject(Object.assign(new Error('eth_call 超过 20 秒未响应'), { kind: 'timeout' })); };
    if (signal?.aborted) return cancel();
    if (chain.budget !== null) {
      const rest = left.has(signal) ? left.get(signal) : chain.budget;
      left.set(signal, rest >= n ? rest - n : 0);
      if (rest >= n) setImmediate(resolve); else signal.addEventListener('abort', cancel, { once: true });
      return;
    }
    timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, n * chain.round);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  const raw = 3000e-12;
  const stateOf = (address) => (tracked.has(address)
    ? { sqrtPriceX96: sqrtX96(raw), tick: tickOf(raw), liquidity: String(10n ** 18n), stakedLiquidity: String(5n * 10n ** 17n), fee: 500, unstakedFee: 100_000,
      balance0: String(10n ** 21n), balance1: String(3n * 10n ** 12n), rewardShare: String(BigInt(chain.t - 1_700_000_000) * 10n ** 17n) }
    : { sqrtPriceX96: sqrtX96(raw), tick: tickOf(raw), liquidity: '1000', stakedLiquidity: '0', fee: 500, unstakedFee: 100_000, balance0: '1', balance1: '1', rewardShare: null });
  const reads = {
    async readPoolAddresses(rpc, _factory, known, limit = Infinity) {
      const added = pools.slice(known, known + limit);
      await wait(1 + batches(added.length), rpc.signal);
      return { total: pools.length, added };
    },
    async readPoolStatics(rpc, list) { await wait(batches(list.length * 4), rpc.signal); return list.map((a) => ({ address: a, token0: WETH, token1: USDC, tickSpacing: 100, gauge: gaugeOf(a) })); },
    async readTokens(rpc, list) { await wait(batches(list.length * 2), rpc.signal); return list.map((t) => ({ symbol: t === WETH ? 'WETH' : 'USDC', decimals: t === USDC ? 6 : 18 })); },
    async readGauges(rpc, list) { chain.gaugeReads.push(list.length); await wait(batches(list.length), rpc.signal); return list.map(gaugeOf); },
    async readPoolStates(rpc, list, block) {
      await wait(batches(list.length * 8 + 1), rpc.signal);
      chain.stateReads.push({ block, pools: list.length });
      return { block, timestamp: chain.t, states: list.map((p) => stateOf(p.address)) };
    },
    async readPoolHistory() { throw Object.assign(new Error('missing trie node'), { kind: 'node' }); },
  };
  // 每轮新建的 RPC 先做一次链校验再读区块号（两批）；出块时间的两次读取并行（一批）。
  const createRpc = ({ signal }) => ({ signal, blockNumber: async () => { await wait(2, signal); return blockAt(chain.t); }, blockTimestamp: async (n) => { await wait(1, signal); return 1_700_000_000 + n * BLOCK_TIME; } });
  return { chain, reads, createRpc, blockAt, pools, tracked, stateOf };
}

test('Base-scale rediscovery on a 20 s-per-batch node resumes its gauge/state reads across rounds and still refreshes current data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = baseScaleChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 300 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).activeCount, BASE_TRACKED);
  const discoveredAt = baseOf(market).discovery.at;
  // 整批读取一次尝试要 2（链校验+区块号）+ 1（池子数）+ 2（gauge）+ 13（全部状态）+ 1（出块时间）= 19 批 = 380 ms，超过 300 ms 预算；
  // 修复前动态阶段不能跨轮续读，重新发现永远待继续。
  fake.chain.round = ROUND_MS;
  fake.chain.t += 6 * 3600 + 1;
  const gaugeReads = fake.chain.gaugeReads.length;
  const log = [];
  let attempts = 0;
  for (let round = 0; round < 8 && baseOf(market).discovery.at === discoveredAt; round++) {
    const before = baseOf(market), yielded = before.discovery.refreshPending;
    await clock.fire(); await settle(market);
    const base = baseOf(market);
    log.push({ yielded, phase: base.discovery.phase, updatedAt: base.updatedAt, stalls: base.discovery.stalledAttempts });
    assert.equal(base.status, 'ok');
    assert.deepEqual([base.discovery.failures, base.discovery.error, base.discovery.retryAt], [0, null, null], 'budget exhaustion is not a node failure');
    if (yielded) {
      assert.equal(base.updatedAt, fake.chain.t * 1000, 'the round after an unfinished rediscovery refreshes the current snapshot first');
      assert.equal(base.discovery.refreshPending, false);
    } else {
      attempts++;
      if (base.discovery.at === discoveredAt) {
        assert.equal(base.discovery.phase, 'pending');
        assert.equal(base.discovery.stalledAttempts, 0, 'each resumed attempt retains new gauge/state shards');
        assert.equal(base.updatedAt, before.updatedAt, 'at most one round yields its current read');
      }
    }
    if (base.discovery.at === discoveredAt) fake.chain.t += 15 * 60;
  }
  t.diagnostic(JSON.stringify(log));
  const base = baseOf(market);
  assert.ok(attempts >= 2 && attempts <= 3, `rediscovery finishes within a bounded number of attempts (took ${attempts})`);
  assert.equal(base.discovery.at, fake.chain.t * 1000, 'rediscovery completed');
  assert.equal(base.discovery.phase, 'idle');
  assert.equal(base.updatedAt, fake.chain.t * 1000);
  assert.equal(base.activeCount, BASE_TRACKED);
  assert.deepEqual(fake.chain.gaugeReads.slice(gaugeReads), [360, 219], 'gauges are read once and reused by the resumed attempt');
  assert.deepEqual(fake.chain.stateReads.at(-1), { block: fake.blockAt(fake.chain.t), pools: BASE_TRACKED },
    'stitched states only select the tracked set: the published snapshot is re-read in one block of the finishing round');
  assert.equal(market.state().pools.length, BASE_TRACKED);
});

test('the resumable gauge/state draft is dropped when too old or when the RPC changes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = baseScaleChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 200 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await settle(market);
  fake.chain.t += 6 * 3600 + 1;
  const asked = [], readPoolStates = fake.reads.readPoolStates;
  // 只记读完的分片：被整轮截止打断的那片不算。
  fake.reads.readPoolStates = async (rpc, list, block) => { const read = await readPoolStates(rpc, list, block); asked.push(list.map((p) => p.address)); return read; };
  // 每次尝试 11 批：固定 3 批后读完 gauge（2 批）与 3 片状态（各 2 批），下一片挂起到整轮截止；随后让位的一轮照常刷新。
  const partial = async () => {
    const gauges = fake.chain.gaugeReads.length, states = asked.length;
    fake.chain.budget = 11; await clock.fire(); await settle(market);
    assert.equal(baseOf(market).discovery.phase, 'pending');
    const read = { gauges: fake.chain.gaugeReads.slice(gauges), states: asked.slice(states) };
    fake.chain.t += 60; fake.chain.budget = Infinity; await clock.fire(); await settle(market);
    assert.equal(baseOf(market).updatedAt, fake.chain.t * 1000);
    return read;
  };
  const first = await partial();
  assert.deepEqual(first.gauges, [360, 219]);
  assert.equal(first.states.length, 3);
  assert.equal(baseOf(market).discovery.stalledAttempts, 0, 'shards first read in a new draft are progress');
  // 默认 15 分钟间隔时草稿时限为 6 小时：超过后 gauge 与状态从头重读，不与 6 小时前的读数拼接。
  fake.chain.t += 6 * 3600 + 1;
  const expired = await partial();
  assert.deepEqual(expired.gauges, [360, 219], 'an expired draft starts the gauge/state stage over');
  assert.deepEqual(expired.states, first.states, 'states are read again from the first shard as well');
  assert.equal(baseOf(market).discovery.stalledAttempts, 1, 're-reading after expiry is not progress, so repeated expiry still reaches the budget backoff');
  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { enabled: true, rpcUrl: 'https://rpc.example/new' } } });
  fake.chain.t += 60;
  const from = fake.chain.gaugeReads.length;
  await clock.fire(); await settle(market);
  assert.deepEqual(fake.chain.gaugeReads.slice(from, from + 1), [360], 'a new RPC never resumes the old draft');
});

// 可控预算下推进重新发现：发现尝试的轮次给 budget 批，让位的当前刷新轮次不限；每轮把假时钟推进一个刷新间隔。
async function rediscoverRounds(market, fake, clock, { budget, intervalMin = 15, done, maxRounds = 12 }) {
  const log = [];
  for (let round = 0; round < maxRounds && !done(); round++) {
    const yielded = baseOf(market).discovery.refreshPending;
    fake.chain.budget = yielded ? Infinity : budget;
    await clock.fire(); await settle(market);
    const { phase, stalledAttempts } = baseOf(market).discovery;
    log.push({ yielded, phase, stalledAttempts });
    if (!done()) fake.chain.t += intervalMin * 60;
  }
  return log;
}

test('with a 120-minute interval the gauge/state draft lasts for the three attempts a slow node needs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir, { intervalMin: 120 });
  const fake = baseScaleChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 200 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await settle(market);
  const discoveredAt = baseOf(market).discovery.at, gaugeReads = fake.chain.gaugeReads.length;
  fake.chain.t += 6 * 3600 + 1;
  // 每次尝试 11 批：第 1 次读完 gauge 与 3 片状态，第 2 次读完其余 4 片，第 3 次重读跟踪集合（3 批）与出块时间后发布。
  // 第 3 次尝试在草稿开始约 8 小时后：按 max(6 小时, 3 个间隔) 的旧时限会过期重读，永远完不成。
  const log = await rediscoverRounds(market, fake, clock, { budget: 11, intervalMin: 120, done: () => baseOf(market).discovery.at !== discoveredAt });
  t.diagnostic(JSON.stringify(log));
  const attempts = log.filter((r) => !r.yielded);
  assert.deepEqual(attempts.map((r) => [r.phase, r.stalledAttempts]), [['pending', 0], ['pending', 0], ['idle', 0]]);
  assert.deepEqual(fake.chain.gaugeReads.slice(gaugeReads), [360, 219], 'the draft is not dropped before the third attempt');
  assert.equal(baseOf(market).discovery.at, fake.chain.t * 1000);
  assert.equal(baseOf(market).activeCount, BASE_TRACKED);
});

test('a retained gauge/state draft without new shards still backs off after three budget-exhausted attempts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = baseScaleChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 200 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await settle(market);
  const gaugeReads = fake.chain.gaugeReads.length;
  fake.chain.t += 6 * 3600 + 1;
  fake.chain.budget = 11; await clock.fire(); await settle(market);
  assert.deepEqual([baseOf(market).discovery.phase, baseOf(market).discovery.stalledAttempts], ['pending', 0]);
  // 之后每次尝试只有 4 批：固定 3 批后不够再读一片状态，草稿保留但没有新分片。
  for (let attempt = 1; attempt <= 3; attempt++) {
    fake.chain.t += 15 * 60; fake.chain.budget = Infinity; await clock.fire(); await settle(market);
    assert.equal(baseOf(market).updatedAt, fake.chain.t * 1000, 'the yielded round refreshes current data');
    fake.chain.t += 15 * 60; fake.chain.budget = 4; await clock.fire(); await settle(market);
    const d = baseOf(market).discovery;
    assert.deepEqual([d.phase, d.stalledAttempts], [attempt < 3 ? 'pending' : 'budget_backoff', attempt]);
    assert.equal(d.retryAt, attempt < 3 ? null : fake.chain.t * 1000 + 30 * 60 * 1000);
  }
  // 退避结束后草稿仍在时限内，续读完成，gauge 不重读。
  fake.chain.t += 15 * 60; fake.chain.budget = Infinity; await clock.fire(); await settle(market);
  fake.chain.t = baseOf(market).discovery.retryAt / 1000; await clock.fire(); await settle(market);
  assert.deepEqual([baseOf(market).discovery.phase, baseOf(market).discovery.stalledAttempts], ['idle', 0]);
  assert.deepEqual(fake.chain.gaugeReads.slice(gaugeReads), [360, 219]);
});

test('a gauge or state that fails to read is not recorded in the draft and is read again by the next attempt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = baseScaleChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 200 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await settle(market);
  // 两个都是跟踪池：gauge 子调用失败为 undefined，状态子调用失败为 null。
  const [gaugeMiss, stateMiss] = fake.pools;
  const { readGauges, readPoolStates } = fake.reads, gaugeAsked = [], stateAsked = [];
  let failing = true;
  fake.reads.readGauges = async (rpc, list) => { gaugeAsked.push(list); const out = await readGauges(rpc, list); return out.map((g, i) => (failing && list[i] === gaugeMiss ? undefined : g)); };
  fake.reads.readPoolStates = async (rpc, list, block) => {
    stateAsked.push(list.map((p) => p.address));
    const read = await readPoolStates(rpc, list, block);
    return { ...read, states: read.states.map((s, i) => (failing && list[i].address === stateMiss ? null : s)) };
  };
  fake.chain.t += 6 * 3600 + 1;
  fake.chain.budget = 11; await clock.fire(); await settle(market);
  assert.equal(baseOf(market).discovery.phase, 'pending');
  failing = false;
  fake.chain.t += 15 * 60; fake.chain.budget = Infinity; await clock.fire(); await settle(market);
  const gauges = gaugeAsked.length, states = stateAsked.length;
  fake.chain.t += 15 * 60; await clock.fire(); await settle(market);
  assert.equal(baseOf(market).discovery.phase, 'idle');
  assert.deepEqual(gaugeAsked.slice(gauges), [[gaugeMiss]], 'only the failed gauge is read again');
  assert.equal(stateAsked[states][0], stateMiss, 'the failed state is read again in the first unread shard');
  assert.equal(baseOf(market).activeCount, BASE_TRACKED, 'neither failure drops a tracked pool');
  assert.ok(market.state().pools.some((p) => p.address === gaugeMiss && p.gauge === '0xf' + gaugeMiss.slice(-39)), 'the re-read gauge is published');
});

test('a pool created while the gauge/state draft is resumed is read as a new shard and the stitched snapshot is re-read in one block', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-'));
  onlyBase(dir);
  const fake = baseScaleChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 200 });
  t.after(async () => { await market.close(); rmSync(dir, { recursive: true, force: true }); });
  await market.initialize();
  await clock.fire(); await settle(market);
  const asked = [], readPoolStates = fake.reads.readPoolStates;
  fake.reads.readPoolStates = async (rpc, list, block) => { asked.push(list.map((p) => p.address)); return readPoolStates(rpc, list, block); };
  fake.chain.t += 6 * 3600 + 1;
  fake.chain.budget = 11; await clock.fire(); await settle(market);
  assert.equal(baseOf(market).discovery.phase, 'pending');
  const extra = '0x' + (BASE_POOLS + 1).toString(16).padStart(40, '0');
  fake.pools.push(extra); fake.tracked.add(extra);
  fake.chain.t += 15 * 60; fake.chain.budget = Infinity; await clock.fire(); await settle(market);
  const gauges = fake.chain.gaugeReads.length, states = asked.length;
  fake.chain.t += 15 * 60; await clock.fire(); await settle(market);
  const base = baseOf(market);
  assert.equal(base.discovery.phase, 'idle');
  assert.deepEqual([base.poolCount, base.activeCount], [BASE_POOLS + 1, BASE_TRACKED + 1]);
  assert.deepEqual(fake.chain.gaugeReads.slice(gauges), [1], 'only the new pool needs a gauge read');
  const shards = asked.slice(states);
  assert.ok(shards.slice(0, -1).some((shard) => shard.includes(extra)), 'the new pool is read among the unread shards');
  assert.deepEqual(fake.chain.stateReads.at(-1), { block: fake.blockAt(fake.chain.t), pools: BASE_TRACKED + 1 }, 'stitched states are re-read for the tracked set in this block');
  assert.ok(shards.at(-1).includes(extra));
});

test('an RPC change cancels the old round before discovery and the new RPC starts over', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 100 });
  await market.initialize();
  // 轮次开始后、发现开始前改 RPC：取消旧请求，不允许它再开始发现。
  fake.delays.block = 60; fake.delays.tokens = 400;
  const config = market.state().config, rpcUrl = 'https://other-node.example/rpc';
  await clock.fire();
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, rpcUrl } } });
  await settle(market);
  assert.equal(baseOf(market).status, 'idle');
  assert.equal(baseOf(market).error, null, 'config cancellation is not a node failure');
  assert.equal(fake.seen.statics, 0);
  fake.delays.block = 0; fake.delays.tokens = 0; fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).status, 'ok');
  assert.equal(fake.seen.addressesFrom.at(-1), 0, 'progress read from the old RPC is not reused for the new one');
  assert.equal(fake.seen.statics, 1);
  await market.close();
});

test('a failed rediscovery keeps the old pool list, publishes current data, leaves budget for backfill and backs off', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 400 });
  await market.initialize();
  await clock.fire(); await settle(market);
  assert.equal(fake.seen.gauges, 1);
  const firstDiscovery = baseOf(market).discovery.at;
  assert.ok(firstDiscovery > 0);
  assert.equal(baseOf(market).discovery.failures, 0);
  // 改门槛要求重新发现；这次节点明确报错，当前读取和回填仍可继续。
  const config = market.state().config;
  await market.save({ ...config, minTvlUsd: config.minTvlUsd + 1 });
  fake.chain.t += 60; fake.fail.add('gauges');
  const historyBefore = fake.chain.historyBlocks.length;
  await clock.fire(); await settle(market);
  let base = baseOf(market);
  assert.equal(fake.seen.gauges, 2, 'rediscovery was attempted');
  assert.equal(base.status, 'ok', 'the round still succeeds with the old pool list');
  assert.equal(base.updatedAt, fake.chain.t * 1000, 'current data is published, not frozen');
  assert.equal(market.state().pools.length, 2);
  assert.ok(fake.chain.historyBlocks.length > historyBefore, 'backfill still runs after the rediscovery request fails');
  assert.equal(base.history.phase, 'catching_up');
  assert.equal(base.discovery.failures, 1);
  assert.match(base.discovery.error, /重新发现/);
  assert.equal(base.discovery.retryAt, fake.chain.t * 1000 + 30 * 60_000, 'first retry after 30 minutes');
  assert.equal(base.discovery.at, firstDiscovery);

  // 退避期内的轮次不再尝试重新发现。
  fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(fake.seen.gauges, 2, 'no rediscovery attempt during the backoff');
  fake.chain.t += 30 * 60;
  await clock.fire(); await settle(market);
  base = baseOf(market);
  assert.equal(fake.seen.gauges, 3);
  assert.equal(base.status, 'ok');
  assert.equal(base.discovery.failures, 2);
  assert.match(base.discovery.error, /execution reverted/);
  assert.equal(base.discovery.retryAt, fake.chain.t * 1000 + 60 * 60_000, 'the backoff doubles');

  // 池子列表超过 12 小时未更新时提示过期。
  fake.chain.t += 13 * 3600;
  await clock.fire(); await settle(market);
  base = baseOf(market);
  assert.equal(base.discovery.stale, true);
  assert.equal(base.discovery.failures, 3);
  assert.equal(base.discovery.retryAt, fake.chain.t * 1000 + 2 * 3600_000);

  fake.fail.delete('gauges'); fake.chain.t += 2 * 3600 + 60;
  await clock.fire(); await settle(market);
  base = baseOf(market);
  assert.equal(fake.seen.gauges, 5);
  assert.deepEqual([base.discovery.failures, base.discovery.error, base.discovery.retryAt, base.discovery.stale], [0, null, null, false]);
  assert.ok(base.discovery.at > firstDiscovery);
  fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(fake.seen.gauges, 5, 'a finished rediscovery clears the request');
  await market.close();
});

test('a threshold change during a rediscovery keeps the request, and a new threshold skips the failure backoff', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 2000 });
  await market.initialize();
  await clock.fire(); await settle(market);
  let config = market.state().config;
  await market.save({ ...config, minTvlUsd: config.minTvlUsd + 1 });
  fake.chain.t += 60; fake.delays.gauges = 100;
  await clock.fire();
  await waitFor(() => fake.seen.gauges >= 2);
  config = market.state().config;
  await market.save({ ...config, minTvlUsd: config.minTvlUsd + 1 });
  await settle(market);
  assert.equal(fake.seen.gauges, 2);
  fake.delays.gauges = 0; fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(fake.seen.gauges, 3, 'the rediscovery that used the old threshold is followed by another one');

  // 失败退避期间改门槛：立即重试，不等退避结束。
  fake.fail.add('gauges');
  config = market.state().config;
  await market.save({ ...config, minTvlUsd: config.minTvlUsd + 1 });
  fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(baseOf(market).discovery.failures, 1);
  fake.fail.delete('gauges');
  config = market.state().config;
  await market.save({ ...config, minTvlUsd: config.minTvlUsd + 1 });
  fake.chain.t += 60;
  await clock.fire(); await settle(market);
  assert.equal(fake.seen.gauges, 5);
  assert.equal(baseOf(market).discovery.failures, 0);
  await market.close();
});

test('reads that complete after the round deadline are still published', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = slowChain(), clock = timers();
  const market = marketWith(dir, fake, clock, { cycleDeadlineMs: 100 });
  await market.initialize();
  await clock.fire(); await settle(market);
  // 当前读数不理会取消、150 ms 后完整返回：结果完整，照常发布。
  fake.stubborn.add('state'); fake.delays.state = 150; fake.chain.t += 30;
  await clock.fire(); await settle(market);
  const base = baseOf(market);
  assert.equal(base.status, 'ok');
  assert.equal(base.updatedAt, fake.chain.t * 1000);
  assert.equal(base.history.phase, 'backoff', 'backfill does not start after the deadline');
  await market.close();
});

test('the round deadline cancels a real RPC request to a slow node: one request, error on time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let hits = 0;
  // 节点收到请求后一直不回：单次请求超时 20 秒，只有整轮截止能及时结束。
  const server = http.createServer((req) => { hits++; req.resume(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const config = structuredClone(DEFAULT_CONFIG);
  for (const id of Object.keys(config.chains)) config.chains[id].enabled = id === 'base';
  config.chains.base.rpcUrl = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(dir, 'aero-market'), { recursive: true });
  writeFileSync(join(dir, 'aero-market/config.json'), JSON.stringify(config));
  const clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, setTimer: clock.setTimer, clearTimer: clock.clearTimer, cycleDeadlineMs: 150 });
  await market.initialize();
  const started = Date.now();
  await clock.fire();
  await settle(market);
  const elapsed = Date.now() - started, base = market.state().chains.find((c) => c.id === 'base');
  assert.equal(base.status, 'error');
  assert.match(base.error, /本轮扫描超过/);
  assert.ok(elapsed < 1500, `released by the round deadline, not the 20 s request timeout (${elapsed} ms)`);
  assert.equal(hits, 1, 'an aborted round does not retry the request');
  await market.close();
});

test('backfill status tells catching up, backing off after a failure, disabled and complete apart, with the next attempt time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  onlyBase(dir);
  const fake = fakeChain(), clock = timers();
  const market = createAeroMarket({ dataDir: dir, log: silent, now: () => fake.chain.t * 1000, reads: fake.reads, createRpc: fake.createRpc, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await market.initialize();
  const chainOf = (id = 'base') => market.state().chains.find((c) => c.id === id);
  assert.equal(chainOf('arbitrum').history.phase, 'disabled', 'a disabled chain has no backfill');

  await clock.fire(); await settle(market);
  let h = chainOf().history;
  assert.equal(h.phase, 'catching_up');
  assert.equal(h.pending, 168 - 1 - 24);
  assert.equal(h.nextAt, fake.chain.t * 1000 + 30_000, 'the next batch follows in 30 s');

  // 部分进度后回填失败：剩余数不变，但不再追批，下次尝试是常规间隔。
  fake.chain.t += 30; fake.chain.failHistory = 'timeout';
  await clock.fire(); await settle(market);
  h = chainOf().history;
  assert.equal(chainOf().status, 'ok');
  assert.equal(h.phase, 'backoff');
  assert.equal(h.pending, 168 - 1 - 24);
  assert.equal(h.nextAt, fake.chain.t * 1000 + 15 * 60 * 1000);

  fake.chain.t += 900; fake.chain.failHistory = null;
  await clock.fire(); await settle(market);
  assert.equal(chainOf().history.phase, 'catching_up');
  while (clock.pending()[0].ms === 30_000) { fake.chain.t += 30; await clock.fire(); await settle(market); }
  h = chainOf().history;
  assert.equal(h.phase, 'complete');
  assert.equal(h.pending, 0);
  assert.equal(h.nextAt, null);

  // 节点拒绝历史状态：6 小时后再试。
  fake.chain.t += 3 * 3600; fake.chain.failHistory = 'node';
  await clock.fire(); await settle(market);
  h = chainOf().history;
  assert.equal(h.archive, 'unavailable');
  assert.equal(h.phase, 'backoff');
  assert.ok(h.nextAt >= (fake.chain.t + 6 * 3600) * 1000, 'the next archive attempt is after the 6-hour pause');

  const config = market.state().config;
  await market.save({ ...config, chains: { ...config.chains, base: { ...config.chains.base, enabled: false } } });
  h = chainOf().history;
  assert.equal(h.phase, 'disabled');
  assert.equal(h.nextAt, null);
  await market.close();
});

test('rpc retries one transient failure, never retries node errors, and checks the chain id', async () => {
  const calls = [];
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const script = [() => reply({}, 503), (b) => reply({ jsonrpc: '2.0', id: b.id, result: '0x2105' }), (b) => reply({ jsonrpc: '2.0', id: b.id, result: '0x10' })];
  const rpc = createRpc({ url: 'https://rpc.example', chainId: 8453, retryDelayMs: 1, fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); calls.push(body.method); return script.shift()(body); } });
  assert.equal(await rpc.blockNumber(), 16);
  assert.deepEqual(calls, ['eth_chainId', 'eth_chainId', 'eth_blockNumber']);

  let count = 0;
  const failing = createRpc({ url: 'https://rpc.example', chainId: 8453, retryDelayMs: 1, fetchImpl: async () => { count++; return reply({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } }); } });
  await assert.rejects(failing.blockNumber(), /header not found/);
  assert.equal(count, 1);

  const wrong = createRpc({ url: 'https://rpc.example', chainId: 8453, fetchImpl: async () => reply({ jsonrpc: '2.0', id: 1, result: '0xa' }) });
  await assert.rejects(wrong.blockNumber(), /链 ID 为 10/);

  let attempts = 0;
  const down = createRpc({ url: 'https://rpc.example', chainId: 8453, retryDelayMs: 1, fetchImpl: async () => { attempts++; throw new TypeError('fetch failed'); } });
  await assert.rejects(down.blockNumber(), /连接失败/);
  assert.equal(attempts, 2);
});

test('workbench market API requires login and same origin and validates queries', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aero-market-app-')); let app;
  t.after(async () => { await app?.close?.(); rmSync(dir, { recursive: true, force: true }); });
  app = await createApp({ dataDir: dir, initialPassword: 'aero-market-fixture-password', refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, warmupEnabled: false, logger: silent });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`, route = '/api/research/aero-market';
  assert.equal((await fetch(origin + route)).status, 401);
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'aero-market-fixture-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
  const request = (suffix = '', method = 'GET', body, overrides = {}) => fetch(origin + route + suffix, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...overrides }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const first = await request();
  assert.equal(first.status, 200);
  const state = await first.json();
  assert.equal(state.config.enabled, false, 'non-embedded instances do not scan by default');
  assert.equal((await (await request(`?revision=${state.revision}`)).json()).unchanged, true);
  assert.equal((await request('?revision=abc')).status, 400);
  assert.equal((await request('?file=/tmp')).status, 400);
  assert.equal((await request('/pool?chain=base')).status, 400);
  assert.equal((await request(`/pool?chain=base&address=${POOL_WETH}`)).status, 404);
  assert.equal((await request('/liquidity?chain=base')).status, 400);
  assert.equal((await request(`/liquidity?chain=base&address=${POOL_WETH}&x=1`)).status, 400);
  assert.equal((await request(`/liquidity?chain=base&address=${POOL_WETH}`)).status, 404);
  assert.equal((await request('/favorites', 'PUT', { favorites: [`base:${POOL_WETH}`] }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await request('/favorites', 'PUT', { favorites: ['x'] })).status, 400);
  assert.equal((await request('/favorites', 'PUT', { favorites: [], extra: 1 })).status, 400);
  const starred = await request('/favorites', 'PUT', { favorites: [`base:${POOL_WETH}`] });
  assert.equal(starred.status, 200);
  assert.deepEqual((await starred.json()).favorites, [`base:${POOL_WETH}`]);
  assert.equal((await request('/favorites', 'POST', { favorites: [] })).status, 404);
  const samples = await request('/samples?window=7d');
  assert.equal(samples.status, 200);
  assert.deepEqual((await samples.json()).pools, {});
  assert.equal((await request('/samples')).status, 400);
  assert.equal((await request('/samples?window=1y')).status, 400);
  assert.equal((await request('/samples?window=7d&x=1')).status, 400);
  assert.equal((await request('/samples?window=7d&tag=')).status, 400);
  assert.equal((await request('/samples?window=7d&tag=a&tag=b')).status, 400);
  assert.equal((await request('/samples?window=7d&window=24h')).status, 400);
  assert.equal((await request(`/samples?window=7d&tag=${'x'.repeat(201)}`)).status, 400);
  assert.equal((await request('/samples?tag=a&window=7d')).status, 200);
  assert.equal(state.samples.available, true);
  assert.equal((await request('', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/refresh', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await request('/refresh', 'POST', {})).status, 409);
  assert.equal((await request('/refresh', 'POST', { force: true })).status, 400);
  assert.equal((await request('/config', 'PUT', { config: { ...state.config, intervalMin: 2 } })).status, 400);
  const saved = await request('/config', 'PUT', { config: { ...state.config, intervalMin: 30 } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).config.intervalMin, 30);
});
