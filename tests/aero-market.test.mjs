import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAeroMarket, DEFAULT_CONFIG, strictMarketConfig } from '../server/research/aero-market.mjs';
import { AERO_BASE } from '../server/research/aero-market-chains.mjs';
import { createRpc } from '../server/research/aero-market-rpc.mjs';
import { createApp } from '../server/app.mjs';

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
    async readPoolAddresses(_rpc, _factory, known) { const all = Object.keys(statics); return { total: all.length, added: all.slice(known) }; },
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

async function settle(market) { for (let i = 0; i < 50; i++) { if (market.state().chains.every((c) => c.status !== 'loading')) return; await new Promise((r) => setTimeout(r, 5)); } }

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
