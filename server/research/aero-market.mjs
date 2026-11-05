// Aero 市场扫描：各链 CL 池的 TVL、排放速率、波动率，供页面判断入场机会。只读链上数据，不持有私钥。
// 不估算手续费年化：feeGrowthGlobal 只按未质押流动性累计，价格穿过未质押流动性极薄的 tick 时按单位放大数十倍，
// 小时级采样无法还原真实费用流（2026-11-03 Base WETH/cbBTC 实测 10 分钟内单位未质押收益为质押侧的 27 倍）。
// 每条链独立调度：一轮完成后按间隔安排下一轮，失败保留上次结果并退避；历史小时点在支持历史区块的链上回填，否则只用本机累计。
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-common.mjs';
import { AERO_BASE, AERO_CHAINS, chainById } from './aero-market-chains.mjs';
import { emissionRate, liquiditySegments, priceChange, realizedVol, solvePrices, tvlUsd } from './aero-market-core.mjs';
import * as chainReads from './aero-market-rpc.mjs';
import { scrubRpcMessage } from './aero-market-rpc.mjs';
import { openMarketSamples, SAMPLE_WINDOWS } from './aero-market-samples.mjs';
import { MIN_REPLAY_HOURS, rebalanceCostFraction, replayPool } from './aero-market-replay.mjs';

const HOUR = 3600;
const HISTORY_SEC = 7 * 86400;
const RATE_HISTORY_SEC = 25 * HOUR; // 这段时间内的历史点保留排放累计，更早的只留 tick
const DISCOVERY_SEC = 6 * HOUR;
const BACKFILL_PER_CYCLE = 24;
// 回填未完成时不等常规间隔：每批之间只歇这么久，7 天历史几分钟补齐，而不是按 15 分钟一批拖近 2 小时。
const BACKFILL_FOLLOW_SEC = 30;
const RETRY_SEC = [60, 120, 300, 600];
// 整轮（发现、当前读数与回填）限时 5 分钟，到期取消在途请求；当前读取失败按失败退避，回填到期保留已发布的当前数据。
// 重新发现到期后优先占用本轮，成功结果同时更新当前快照；预算耗尽不计节点失败，下一轮强制只刷新当前数据，最多让位一轮。
// 单次请求最坏 20 秒 × 2 次加 0.8 秒间隔约 41 秒，预算容纳约 7 次连续最坏请求。
const CYCLE_DEADLINE_MS = 5 * 60_000;
// 发现时每批读这么多个池子的地址与静态信息（约 3 + 9 次 eth_call、4–5 轮串行），每批读完即记入草稿：
// 单批在单次超时 20 秒的慢节点上也远小于整轮预算，首次发现可以跨轮完成。
const DISCOVERY_POOL_BATCH = 250;
// 首次发现（还没有池子列表，没有旧数据要保护）整轮预算放大到 3 倍，即 15 分钟、等于默认刷新间隔：发现后半段（gauge、全部池子状态）
// 必须一轮读完，约 3000 个池子时约 90 轮串行请求，按每轮 10 秒估算；放在普通 5 分钟预算里，慢节点上静态信息读完后仍每轮被截止。
const FIRST_DISCOVERY_DEADLINE_FACTOR = 3;
// 重新发现的真实请求错误从 30 分钟起翻倍退避，最长 6 小时。预算耗尽不计节点错误：
// 连续 3 次发现尝试没有新增可续读的池子/代币时，另行按相同范围退避，防止动态阶段反复耗尽整轮预算。
// 普通当前刷新不清零无进展次数；草稿有新增进展、发现成功或更换 RPC/TVL 门槛时清零。
const REDISCOVERY_RETRY_SEC = 30 * 60;
const REDISCOVERY_STALL_LIMIT = 3;
// 池子列表超过这么久未更新，页面提示：说明重新发现已连续错过至少一次常规间隔。
const DISCOVERY_STALE_SEC = 2 * DISCOVERY_SEC;
const MANUAL_MIN_GAP_MS = 30_000;
const LIMITS = { registry: 8 * 1024 * 1024, history: 32 * 1024 * 1024, snapshot: 8 * 1024 * 1024, config: 64 * 1024, favorites: 64 * 1024 };
// 详情页流动性分布按需读链：同一池子 60 秒内复用结果（并发请求共用一次读取），失败不缓存；
// 整次读取限时 25 秒（单个 RPC 请求 10 秒、瞬态失败重试一次），超时报错，由页面手动重试。
const LIQUIDITY_TTL_MS = 60_000;
const LIQUIDITY_CACHE_SIZE = 32;
const LIQUIDITY_DEADLINE_MS = 25_000;
const LIQUIDITY_RPC_TIMEOUT_MS = 10_000;
const MAX_FAVORITES = 500;
// 详情页长周期价格图：本机历史只有 7 天，更早的整点取自样本库（保留 30 天）。
const PRICE_HISTORY_SEC = 30 * 86400;
// 一次回放请求最多的池子数：请求体上限 32 KB，页面按这个数分批。
export const MAX_REPLAY_POOLS = 250;
const MAX_REPLAY_DEPOSIT = 1e9, MAX_REPLAY_DELAY_MIN = 1440;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true, intervalMin: 15, minTvlUsd: 50_000,
  chains: Object.fromEntries(AERO_CHAINS.map((c) => [c.id, { enabled: true, rpcUrl: c.rpcUrl }])),
});

const plainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v, keys) => plainObject(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const RPC_PATTERN = /^(https:\/\/[^\s/?#@]+|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)(\/[^\s#]*)?$/;

export function strictMarketConfig(value) {
  if (!exactKeys(value, ['enabled', 'intervalMin', 'minTvlUsd', 'chains'])) throw new HttpError(400, '扫描配置包含缺失或不支持的字段');
  if (typeof value.enabled !== 'boolean') throw new HttpError(400, '启用开关格式不正确');
  if (!Number.isInteger(value.intervalMin) || value.intervalMin < 5 || value.intervalMin > 240) throw new HttpError(400, '刷新间隔须为 5–240 分钟的整数');
  if (typeof value.minTvlUsd !== 'number' || !Number.isFinite(value.minTvlUsd) || value.minTvlUsd < 0 || value.minTvlUsd > 1e9) throw new HttpError(400, '无 gauge 池子的 TVL 门槛须在 0–10 亿美元之间');
  if (!exactKeys(value.chains, AERO_CHAINS.map((c) => c.id))) throw new HttpError(400, '链配置不完整');
  const chains = {};
  for (const chain of AERO_CHAINS) {
    const row = value.chains[chain.id];
    if (!exactKeys(row, ['enabled', 'rpcUrl']) || typeof row.enabled !== 'boolean' || typeof row.rpcUrl !== 'string') throw new HttpError(400, `${chain.name} 配置格式不正确`);
    const rpcUrl = row.rpcUrl.trim();
    if (rpcUrl.length > 300 || !RPC_PATTERN.test(rpcUrl)) throw new HttpError(400, `${chain.name} RPC 须为 https 地址（本机节点可用 http://127.0.0.1）`);
    chains[chain.id] = { enabled: row.enabled, rpcUrl };
  }
  return { enabled: value.enabled, intervalMin: value.intervalMin, minTvlUsd: value.minTvlUsd, chains };
}

// 收藏为 "链:池子地址"（小写）列表，按加入顺序保存，去重。
// 回放请求：窗口、投入、停摆与 [链, 池地址, 区间格数（0 为全范围）] 列表；格数由页面按推荐区间给出（推荐搜索只在页面实现）。
export function strictReplayRequest(value) {
  if (!exactKeys(value, ['window', 'deposit', 'delayMin', 'pools'])) throw new HttpError(400, '回放请求包含缺失或不支持的字段');
  if (!Object.hasOwn(SAMPLE_WINDOWS, value.window)) throw new HttpError(400, `窗口须为 ${Object.keys(SAMPLE_WINDOWS).join('、')} 之一`);
  if (typeof value.deposit !== 'number' || !(value.deposit > 0) || value.deposit > MAX_REPLAY_DEPOSIT) throw new HttpError(400, '投入金额须为正数');
  if (typeof value.delayMin !== 'number' || !(value.delayMin >= 0) || value.delayMin > MAX_REPLAY_DELAY_MIN) throw new HttpError(400, `停摆须为 0–${MAX_REPLAY_DELAY_MIN} 分钟`);
  if (!Array.isArray(value.pools) || value.pools.length > MAX_REPLAY_POOLS) throw new HttpError(400, `池子列表须为不超过 ${MAX_REPLAY_POOLS} 项的数组`);
  const pools = value.pools.map((p) => {
    if (!Array.isArray(p) || p.length !== 3 || !chainById.has(p[0]) || typeof p[1] !== 'string' || !/^0x[0-9a-f]{40}$/.test(p[1])
      || !Number.isInteger(p[2]) || p[2] < 0 || p[2] > 2 * 887272) throw new HttpError(400, '池子项须为 [链, 小写池地址, 区间格数]');
    return { chain: p[0], address: p[1], cells: p[2] };
  });
  return { window: value.window, deposit: value.deposit, delayMin: value.delayMin, pools };
}

export function strictFavorites(value) {
  if (!Array.isArray(value) || value.length > MAX_FAVORITES) throw new HttpError(400, `收藏须为不超过 ${MAX_FAVORITES} 个池子的列表`);
  const ids = new Set(AERO_CHAINS.map((c) => c.id)), out = [];
  for (const item of value) {
    const match = typeof item === 'string' ? /^([a-z]+):(0x[0-9a-fA-F]{40})$/.exec(item) : null;
    if (!match || !ids.has(match[1])) throw new HttpError(400, '收藏的池子格式不正确');
    const key = `${match[1]}:${match[2].toLowerCase()}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

// 只显示主机名：RPC 地址可能带 API key。
const rpcHost = (url) => { try { return new URL(url).host; } catch { return ''; } };

function readBounded(file, limit) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('invalid_market_file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function atomicWrite(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}

const floorHour = (sec) => Math.floor(sec / HOUR) * HOUR;

// 历史点的行：[tick, rewardShare]；超过 25 小时的点只留 [tick]。
const fullRow = (s) => [s.tick, s.rewardShare ?? null];
const pointOf = (t, row) => ({ t, tick: row[0], rewardShare: row[1] ?? null });

export function buildRows({ chain, registry, snapshot, prev, history }) {
  if (!registry || !snapshot) return [];
  const tokens = new Map(Object.entries(registry.tokens));
  const byAddress = new Map(registry.pools.map((p) => [p.address, p]));
  const pools = Object.entries(snapshot.states).map(([address, state]) => ({ ...byAddress.get(address), address, state })).filter((p) => p.token0);
  const prices = solvePrices({ pools, tokens, stables: chain.stables.map((s) => s.toLowerCase()) });
  const nowSec = snapshot.t;
  const points = history?.points ?? [];
  return pools.map((p) => {
    const t0 = tokens.get(p.token0), t1 = tokens.get(p.token1), s = p.state;
    if (!t0 || !t1) return null;
    const p0 = prices.get(p.token0) ?? null, p1 = prices.get(p.token1) ?? null;
    const current = pointOf(nowSec, fullRow(s));
    const series = [];
    for (const point of points) { const row = point.rows[p.address]; if (row) series.push(pointOf(point.t, row)); }
    // 排放速率：优先取 45 分钟以前最近的历史点；没有时用上一轮快照（至少间隔 2 分钟）。
    let from = [...series].reverse().find((x) => x.t <= nowSec - 2700 && x.rewardShare !== null) ?? null;
    if (!from && prev?.states?.[p.address]?.rewardShare && nowSec - prev.t >= 120) from = pointOf(prev.t, fullRow(prev.states[p.address]));
    const emissionPerSec = p.gauge ? emissionRate(from, current) : 0;
    const ticks = [...series, current];
    const dayAgo = series.reduce((best, x) => (Math.abs(x.t - (nowSec - 86400)) <= 5400 && (!best || Math.abs(x.t - (nowSec - 86400)) < Math.abs(best.t - (nowSec - 86400))) ? x : best), null);
    return {
      chain: chain.id, address: p.address, gauge: p.gauge ?? null, tickSpacing: p.tickSpacing,
      token0: { address: p.token0, symbol: t0.symbol, decimals: t0.decimals, usd: p0?.usd ?? null },
      token1: { address: p.token1, symbol: t1.symbol, decimals: t1.decimals, usd: p1?.usd ?? null },
      fee: s.fee, unstakedFee: s.unstakedFee, tick: s.tick, sqrtPriceX96: s.sqrtPriceX96, liquidity: s.liquidity, stakedLiquidity: s.stakedLiquidity,
      tvlUsd: tvlUsd(s, t0, t1, p0, p1),
      emissionPerSec, emissionWindowSec: from ? nowSec - from.t : null,
      vol24h: realizedVol(ticks, 86400, nowSec), vol7d: realizedVol(ticks, HISTORY_SEC, nowSec),
      change24h: dayAgo ? priceChange(dayAgo.tick, s.tick) : null,
    };
  }).filter(Boolean);
}

export function createAeroMarket({ dataDir, enabledByDefault = true, log = console, now = Date.now, reads = chainReads, createRpc = chainReads.createRpc, setTimer = setTimeout, clearTimer = clearTimeout, openSamples = openMarketSamples, cycleDeadlineMs = CYCLE_DEADLINE_MS, discoveryBatch = DISCOVERY_POOL_BATCH } = {}) {
  const directory = path.join(dataDir, 'aero-market');
  const configPath = path.join(directory, 'config.json');
  const favoritesPath = path.join(directory, 'favorites.json');
  let favorites = [], favoritesError = null, favoriteWrites = Promise.resolve();
  const liquidityCache = new Map();
  const file = (kind, id) => path.join(directory, `${kind}-${id}.json`);
  let config = { ...structuredClone(DEFAULT_CONFIG), enabled: enabledByDefault }, configError = null, initialized = false, closed = false;
  let samples = null;
  // 以启动时刻为起点：重启后不会与浏览器手里的旧 revision 撞号而误判未变化。
  let revision = Math.floor(Date.now() / 1000);
  // 样本版本每次启动从 0 计：标签带上本次启动的随机标识，重启后不会与浏览器缓存里的旧标签撞号。
  const boot = randomUUID().slice(0, 8);
  const abort = new AbortController();
  // backfillPhase：catching_up 按短间隔追批、backoff 出错后等常规轮次（或归档读取暂停到 backfillRetryAt）、complete 已补齐；null 为尚未回填。
  // discoveryDraft：未完成的发现已读到的池子静态信息与代币（只增不变的数据），下一轮从这里续读；发现成功后清空。
  // rediscoverFailures / rediscoverError / rediscoverRetryAt：已有池子列表时重新发现的连续失败次数、最近错误与退避结束时间（毫秒）。
  // generation/configAbort 隔离 RPC + TVL 门槛的每次变更（含改回原值）；refreshPending 保证未完成发现后先更新一次当前快照。
  const runtimes = new Map(AERO_CHAINS.map((c) => [c.id, { registry: null, snapshot: null, prev: null, history: { schema: 1, points: [] }, rows: [], discoveryDraft: null,
    generation: 0, configAbort: new AbortController(), rediscoverPhase: 'idle', refreshPending: false, rediscoverStalls: 0, rediscoverFailures: 0, rediscoverError: null, rediscoverRetryAt: null,
    status: 'idle', backfillPending: 0, backfillPhase: null, backfillRetryAt: null, rediscover: false, error: null, errorAt: null, checkedAt: null, nextAt: null, running: null, timer: null, failures: 0, lastStart: 0, archive: null, writes: Promise.resolve() }]));
  const changed = () => { revision += 1; };

  function schedule(id, delaySec) {
    const rt = runtimes.get(id);
    clearTimer(rt.timer); rt.timer = null; rt.nextAt = null;
    if (closed || !config.enabled || !config.chains[id].enabled) return;
    rt.nextAt = now() + delaySec * 1000;
    rt.timer = setTimer(() => { rt.timer = null; void run(id); }, delaySec * 1000);
    rt.timer?.unref?.();
  }

  function assertGeneration(rt, generation) {
    if (closed || rt.generation !== generation) throw new Error('扫描已关闭或配置已更新');
  }

  // 地址、门槛和代次在整轮开始时一起捕获，取消不被遵守时也不能让旧尝试写回。
  async function discover(id, rpc, block, { rpcUrl, minTvlUsd, generation }) {
    const chain = chainById.get(id), rt = runtimes.get(id);
    assertGeneration(rt, generation);
    const prior = rt.registry?.factory === chain.clFactory ? rt.registry : null;
    // 未发布草稿随工厂、RPC 或门槛代次失效；已发布列表中的静态信息仍可复用，gauge 和当前状态每次重新核验。
    let draft = rt.discoveryDraft;
    if (!draft || draft.factory !== chain.clFactory || draft.generation !== generation) {
      draft = { factory: chain.clFactory, rpcUrl, generation, poolCount: prior?.poolCount ?? 0, pools: structuredClone(prior?.pools ?? []), tokens: structuredClone(prior?.tokens ?? {}) };
      rt.discoveryDraft = draft;
    }
    for (;;) {
      const { total, added } = await reads.readPoolAddresses(rpc, chain.clFactory, draft.poolCount, discoveryBatch);
      assertGeneration(rt, generation);
      const statics = added.length ? await reads.readPoolStatics(rpc, added) : [];
      assertGeneration(rt, generation);
      statics.forEach((s, i) => draft.pools.push(s ?? { address: added[i], invalid: true }));
      draft.poolCount += added.length;
      if (!added.length || draft.poolCount >= total) break;
    }
    const missing = [...new Set(draft.pools.filter((p) => !p.invalid).flatMap((p) => [p.token0, p.token1]))].filter((t) => !draft.tokens[t]);
    if (missing.length) {
      const tokens = await reads.readTokens(rpc, missing);
      assertGeneration(rt, generation);
      tokens.forEach((t, i) => { if (t) draft.tokens[missing[i]] = { symbol: t.symbol, decimals: t.decimals }; });
    }
    // gauge、当前状态与跟踪集合每次发现都重读，在草稿的副本上进行：中途失败时草稿里的 gauge 仍是上次发布的值，替换检测不受影响。
    const registry = { schema: 1, factory: chain.clFactory, poolCount: draft.poolCount, pools: structuredClone(draft.pools), tokens: structuredClone(draft.tokens), active: [], discoveredAt: 0, blockTime: prior?.blockTime ?? null };
    const valid = registry.pools.filter((p) => !p.invalid);
    // gauge 可能在建池之后才创建，也可能被替换：每次发现都重读。
    const gauges = await reads.readGauges(rpc, valid.map((p) => p.address));
    assertGeneration(rt, generation);
    // gauge 被替换后累计排放份额换了基准，旧的历史排放点不能再和新读数相减。
    const replaced = [];
    valid.forEach((p, i) => { if (p.gauge !== undefined && p.gauge && p.gauge !== gauges[i]) replaced.push(p.address); p.gauge = gauges[i]; });
    const known = valid.filter((p) => registry.tokens[p.token0] && registry.tokens[p.token1]);
    const full = await reads.readPoolStates(rpc, known, block);
    assertGeneration(rt, generation);
    const states = Object.fromEntries(known.map((p, i) => [p.address, full.states[i]]).filter(([, s]) => s));
    const tokens = new Map(Object.entries(registry.tokens));
    const pools = known.filter((p) => states[p.address]).map((p) => ({ ...p, state: states[p.address] }));
    const prices = solvePrices({ pools, tokens, stables: chain.stables.map((s) => s.toLowerCase()) });
    registry.active = pools.filter((p) => {
      if (p.gauge && BigInt(p.state.liquidity) > 0n) return true;
      const tvl = tvlUsd(p.state, tokens.get(p.token0), tokens.get(p.token1), prices.get(p.token0), prices.get(p.token1));
      return tvl !== null && tvl >= minTvlUsd;
    }).map((p) => p.address);
    const span = Math.min(10_000, block - 1);
    if (span > 100) { const [a, b] = await Promise.all([rpc.blockTimestamp(block - span), rpc.blockTimestamp(block)]); registry.blockTime = (b - a) / span; }
    registry.discoveredAt = full.timestamp;
    const active = new Set(registry.active);
    return { replaced, registry, snapshot: { t: full.timestamp, block, states: Object.fromEntries(Object.entries(states).filter(([a]) => active.has(a))) } };
  }

  // 7 天内还没读过的整点。按请求的整点判断是否已读：出块时间外推有偏差时，实际时间戳可能离整点超过 20 分钟，不能据此反复重读。
  function missingSlots(rt, nowSec, accept = () => true) {
    const points = rt.history.points;
    const covered = (slot) => points.some((p) => p.slot === slot || Math.abs(p.t - slot) <= 1200);
    const slots = [];
    for (let slot = floorHour(nowSec); slot > nowSec - HISTORY_SEC; slot -= HOUR) if (slot < nowSec - 60 && !covered(slot) && accept(slot)) slots.push(slot);
    return slots;
  }

  async function backfill(id, rpc, active, block, nowSec, signal, generation, rpcUrl) {
    const rt = runtimes.get(id);
    const current = () => !closed && rt.generation === generation;
    if (!current()) return false;
    rt.backfillPending = 0; rt.backfillRetryAt = null;
    if (!rt.registry.blockTime) { rt.backfillPhase = 'complete'; return false; }
    if (rt.archive?.failedAt && nowSec - rt.archive.failedAt < DISCOVERY_SEC) { rt.backfillPhase = 'backoff'; rt.backfillRetryAt = (rt.archive.failedAt + DISCOVERY_SEC) * 1000; return false; }
    const points = rt.history.points;
    // 早于创世区块的整点读不到，不计入待补数，否则会一直追批。
    const targetOf = (slot) => block - Math.round((nowSec - slot) / rt.registry.blockTime);
    const slots = missingSlots(rt, nowSec, (slot) => targetOf(slot) >= 1);
    rt.backfillPending = slots.length;
    for (const slot of slots.slice(0, BACKFILL_PER_CYCLE)) {
      if (!current()) return false;
      if (signal.aborted) { rt.backfillPhase = 'backoff'; return false; }
      const target = targetOf(slot);
      try {
        const read = await reads.readPoolHistory(rpc, active, target, slot >= nowSec - RATE_HISTORY_SEC);
        if (!current()) return false;
        const rows = {};
        read.states.forEach((s, i) => { if (s) rows[active[i].address] = s.rewardShare === undefined ? [s.tick] : fullRow(s); });
        points.push({ t: read.timestamp, slot, block: target, rows });
        // 在途读取仍算待补；确认结果属于当前代次并写入后才扣减，取消无需回滚计数。
        rt.backfillPending--;
        rt.archive = { ok: true };
      } catch (error) {
        if (!current()) return false;
        // 节点明确拒绝历史状态（非归档节点）时停止回填，6 小时后再试并改用本机样本；
        // 超时、限流等瞬时错误只结束本轮回填，下一轮继续。都不影响本轮当前数据。
        if (error?.kind === 'node') {
          rt.archive = { ok: false, failedAt: nowSec, error: scrubRpcMessage(error?.message || error, rpcUrl) };
          rt.backfillRetryAt = (nowSec + DISCOVERY_SEC) * 1000;
          log.warn?.({ type: 'aero-market', chain: id, err: rt.archive.error }, 'Aero 历史区块读取失败，改用本机累计样本');
          rt.backfillPending = 0;
        }
        // 出错（含限流、超时、整轮到期）后按常规间隔再试，不连续追批。
        rt.backfillPhase = 'backoff';
        return false;
      }
    }
    rt.backfillPhase = rt.backfillPending > 0 ? 'catching_up' : 'complete';
    return rt.backfillPending > 0;
  }

  function compactHistory(rt, nowSec) {
    // 回填点按请求的整点保留：出块时间外推偏差可让最老的点实际时间早于 7 天，按时间删会让该整点下一轮又算待补，每 30 秒重读。
    rt.history.points = rt.history.points.filter((p) => (p.slot ?? p.t) > nowSec - HISTORY_SEC - HOUR).sort((a, b) => a.t - b.t);
    for (const p of rt.history.points) if (p.t < nowSec - RATE_HISTORY_SEC) for (const [k, row] of Object.entries(p.rows)) if (row.length > 1) p.rows[k] = [row[0]];
  }

  const activeOf = (registry) => { const byAddress = new Map(registry.pools.map((p) => [p.address, p])); return registry.active.map((a) => byAddress.get(a)).filter(Boolean); };

  // 发现结果已含当前读数，每轮只发布一次，上一轮快照保留为 prev。
  function publish(id, registry, snapshot, replaced) {
    const rt = runtimes.get(id), chain = chainById.get(id);
    rt.registry = registry; rt.prev = rt.snapshot; rt.snapshot = snapshot; rt.refreshPending = false;
    for (const address of replaced) {
      for (const point of rt.history.points) { const row = point.rows[address]; if (row?.length > 1) point.rows[address] = [row[0]]; }
      if (rt.prev?.states[address]) rt.prev.states[address] = { ...rt.prev.states[address], rewardShare: null };
    }
    rt.rows = buildRows({ chain, registry, snapshot, prev: rt.prev, history: rt.history }); changed();
  }

  // 调用前已核对配置代次，只有当前代次的成功才能清除请求和错误。
  function discovered(rt) {
    rt.discoveryDraft = null; rt.rediscover = false; rt.rediscoverPhase = 'idle';
    rt.rediscoverStalls = 0; rt.rediscoverFailures = 0; rt.rediscoverError = null; rt.rediscoverRetryAt = null;
  }

  const usableRegistry = (id) => { const rt = runtimes.get(id); return rt.registry?.factory === chainById.get(id).clFactory ? rt.registry : null; };
  // 只计算下轮真正可复用的进展；重读 gauge/状态而未完成整次发现不能算作进展。
  const discoveryProgress = (rt) => { const saved = rt.discoveryDraft ?? rt.registry; return (saved?.poolCount ?? 0) + Object.keys(saved?.tokens ?? {}).length; };
  const rediscoveryDelay = (attempt) => Math.min(REDISCOVERY_RETRY_SEC * 2 ** (attempt - 1), DISCOVERY_SEC) * 1000;

  // 读取已完整返回的结果照常发布，即使整轮已到期：到期只用来取消仍在途的读取，后续回填据此停止。
  async function cycle(id, signal, attempt) {
    const rt = runtimes.get(id), chain = chainById.get(id), { rpcUrl, generation } = attempt;
    const current = () => !closed && rt.generation === generation;
    const rpc = createRpc({ url: rpcUrl, chainId: chain.chainId, signal });
    const block = await rpc.blockNumber();
    if (!current()) return;
    let registry = usableRegistry(id);
    if (!registry) {
      // 首次发现：没有可用的池子列表，发现失败或到期就整轮失败，已读进度留在草稿里。
      const found = await discover(id, rpc, block, attempt);
      if (!current()) return;
      registry = found.registry;
      publish(id, registry, found.snapshot, found.replaced);
      discovered(rt);
    } else {
      // 到期后先发现，避免慢速当前读取永久吃掉发现预算；上轮未能更新快照时，本轮必须先完成当前读取。
      let refreshed = false;
      const stale = rt.rediscover || (now() / 1000) - registry.discoveredAt > DISCOVERY_SEC;
      if (stale && !rt.refreshPending && (rt.rediscoverRetryAt === null || now() >= rt.rediscoverRetryAt) && !signal.aborted) {
        const progress = discoveryProgress(rt);
        rt.rediscoverPhase = 'running'; changed();
        try {
          const found = await discover(id, rpc, block, attempt);
          if (!current()) return;
          registry = found.registry;
          publish(id, registry, found.snapshot, found.replaced);
          discovered(rt);
          refreshed = true;
        } catch (error) {
          if (!current()) return;
          rt.refreshPending = true;
          if (signal.aborted) {
            rt.rediscoverPhase = 'pending'; rt.rediscoverRetryAt = null;
            rt.rediscoverStalls = discoveryProgress(rt) > progress ? 0 : rt.rediscoverStalls + 1;
            if (rt.rediscoverStalls >= REDISCOVERY_STALL_LIMIT) {
              rt.rediscoverPhase = 'budget_backoff';
              rt.rediscoverRetryAt = now() + rediscoveryDelay(rt.rediscoverStalls - REDISCOVERY_STALL_LIMIT + 1);
            }
            if (rt.backfillPhase === 'catching_up') rt.backfillPhase = 'backoff';
            return false;
          }
          rt.rediscoverStalls = 0;
          rt.rediscoverPhase = 'backoff'; rt.rediscoverFailures += 1;
          rt.rediscoverError = `重新发现失败：${scrubRpcMessage(error?.message || error, rpcUrl, 200)}`;
          rt.rediscoverRetryAt = now() + rediscoveryDelay(rt.rediscoverFailures);
          log.warn?.({ type: 'aero-market', chain: id, err: rt.rediscoverError, failures: rt.rediscoverFailures }, 'Aero 池子重新发现未完成，沿用上次池子列表，退避后再试');
        }
      }
      if (!refreshed) {
        const active = activeOf(registry);
        const read = await reads.readPoolStates(rpc, active, block);
        if (!current()) return;
        publish(id, registry, { t: read.timestamp, block, states: Object.fromEntries(active.map((p, i) => [p.address, read.states[i]]).filter(([, s]) => s)) }, []);
      }
    }
    const snapshot = rt.snapshot, active = activeOf(registry);
    const nowSec = snapshot.t;
    // 当前数据已在上面发布，再回填历史：回填一批要十几秒，不能挡住价格、TVL 和排放的更新。
    const follow = chain.archive ? await backfill(id, rpc, active, block, nowSec, signal, generation, rpcUrl) : false;
    if (!current()) return;
    // 非归档链（或回填失败时）用本轮读数作为小时样本。
    const last = rt.history.points.at(-1);
    if ((!chain.archive || rt.archive?.ok === false) && (!last || nowSec - last.t >= 3000)) rt.history.points.push({ t: nowSec, block, rows: Object.fromEntries(Object.entries(snapshot.states).map(([a, s]) => [a, fullRow(s)])) });
    compactHistory(rt, nowSec);
    rt.rows = buildRows({ chain, registry, snapshot, prev: rt.prev, history: rt.history });
    // 小时样本供平均净年化：AERO 价来自 Base，Base 尚未扫完时先记空，同一整点后续轮次补上。
    samples?.record(id, nowSec, rt.rows, aeroPrice().usd);
    persist(id);
    return follow;
  }

  function persist(id) {
    const rt = runtimes.get(id);
    const registry = rt.registry, snapshot = { schema: 1, current: rt.snapshot, prev: rt.prev }, history = rt.history;
    rt.writes = rt.writes.then(async () => {
      await atomicWrite(file('registry', id), registry);
      await atomicWrite(file('snapshot', id), snapshot);
      await atomicWrite(file('history', id), history);
    }).catch((error) => { log.warn?.({ type: 'aero-market', chain: id, err: error.message }, 'Aero 市场数据保存失败'); });
  }

  async function run(id) {
    const rt = runtimes.get(id);
    if (closed || rt.running || !config.enabled || !config.chains[id].enabled) return rt.running;
    rt.lastStart = now(); rt.status = rt.snapshot ? rt.status : 'loading'; changed();
    rt.running = (async () => {
      const attempt = { generation: rt.generation, rpcUrl: config.chains[id].rpcUrl, minTvlUsd: config.minTvlUsd };
      const deadlineMs = usableRegistry(id) ? cycleDeadlineMs : cycleDeadlineMs * FIRST_DISCOVERY_DEADLINE_FACTOR;
      const deadline = AbortSignal.timeout(deadlineMs);
      try {
        const follow = await cycle(id, AbortSignal.any([abort.signal, deadline, rt.configAbort.signal]), attempt);
        if (closed || rt.generation !== attempt.generation) return;
        rt.status = 'ok'; rt.error = null; rt.errorAt = null; rt.failures = 0;
        schedule(id, follow ? Math.min(BACKFILL_FOLLOW_SEC, config.intervalMin * 60) : config.intervalMin * 60);
      } catch (error) {
        if (closed || rt.generation !== attempt.generation) return;
        rt.status = 'error'; rt.errorAt = now();
        rt.error = deadline.aborted ? `本轮扫描超过 ${deadlineMs / 60_000} 分钟未完成，已取消，${rt.registry ? '保留上次数据' : '已读的池子进度保留，下一轮继续'}` : scrubRpcMessage(error?.message || error, attempt.rpcUrl);
        if (rt.backfillPhase === 'catching_up') rt.backfillPhase = 'backoff';
        log.warn?.({ type: 'aero-market', chain: id, err: rt.error }, 'Aero 市场扫描失败，保留上次数据');
        schedule(id, Math.min(RETRY_SEC[Math.min(rt.failures++, RETRY_SEC.length - 1)], config.intervalMin * 60));
      } finally {
        rt.running = null;
        if (rt.generation !== attempt.generation) schedule(id, 2);
        else rt.checkedAt = now();
        changed();
      }
    })();
    return rt.running;
  }

  function load(id) {
    const rt = runtimes.get(id), chain = chainById.get(id);
    try {
      const registry = readBounded(file('registry', id), LIMITS.registry);
      if (registry?.schema === 1 && registry.factory === chain.clFactory && Array.isArray(registry.pools) && plainObject(registry.tokens) && Array.isArray(registry.active)) rt.registry = registry;
      const snapshot = readBounded(file('snapshot', id), LIMITS.snapshot);
      if (rt.registry && snapshot?.schema === 1 && plainObject(snapshot.current?.states)) { rt.snapshot = snapshot.current; rt.prev = plainObject(snapshot.prev?.states) ? snapshot.prev : null; }
      const history = readBounded(file('history', id), LIMITS.history);
      if (history?.schema === 1 && Array.isArray(history.points)) rt.history = { schema: 1, points: history.points.filter((p) => Number.isFinite(p?.t) && plainObject(p.rows)) };
      if (rt.snapshot) rt.rows = buildRows({ chain, registry: rt.registry, snapshot: rt.snapshot, prev: rt.prev, history: rt.history });
      // 重启后按已存历史估算待补整点，让未补完的回填继续按短间隔追批。
      if (chain.archive && rt.registry?.blockTime) { rt.backfillPending = missingSlots(rt, now() / 1000).length; rt.backfillPhase = rt.backfillPending > 0 ? 'catching_up' : 'complete'; }
    } catch (error) {
      log.warn?.({ type: 'aero-market', chain: id, err: error.message }, 'Aero 市场缓存无法读取，将重新扫描');
      rt.registry = null; rt.snapshot = null; rt.prev = null; rt.history = { schema: 1, points: [] }; rt.rows = [];
    }
  }

  function startAll() {
    AERO_CHAINS.forEach((c, i) => {
      const rt = runtimes.get(c.id);
      if (!config.enabled || !config.chains[c.id].enabled) { schedule(c.id, 0); return; }
      if (rt.running || rt.timer) return;
      const age = rt.snapshot ? now() / 1000 - rt.snapshot.t : Infinity;
      const due = rt.backfillPending > 0 ? Math.min(BACKFILL_FOLLOW_SEC, config.intervalMin * 60) : config.intervalMin * 60;
      schedule(c.id, Math.max(2 + i * 3, age < due ? due - age : 0));
    });
  }

  function aeroPrice() {
    const base = runtimes.get('base');
    const row = base.rows.find((r) => r.token0.address === AERO_BASE.toLowerCase() || r.token1.address === AERO_BASE.toLowerCase());
    const token = row ? (row.token0.address === AERO_BASE.toLowerCase() ? row.token0 : row.token1) : null;
    return { usd: token?.usd ?? null, at: base.snapshot ? base.snapshot.t * 1000 : null };
  }

  // Base 行情快照里各代币的美元价（小写地址），与页面估值同源；扫描关闭或尚无快照时为 null。供实盘自动调仓按总资产比例核对单池上限。
  function tokenPrices() {
    const base = runtimes.get('base');
    if (!config.enabled || !config.chains.base?.enabled || !base?.snapshot) return null;
    const usd = {};
    for (const r of base.rows) for (const t of [r.token0, r.token1]) if (typeof t.usd === 'number' && Number.isFinite(t.usd) && t.usd > 0) usd[t.address.toLowerCase()] = t.usd;
    return { at: base.snapshot.t * 1000, usd };
  }

  function state({ since } = {}) {
    if (since !== undefined && since === revision) return { schema: 1, revision, unchanged: true, serverNow: now() };
    return {
      schema: 1, revision, serverNow: now(), config: structuredClone(config), configError, aero: aeroPrice(), favorites: [...favorites], favoritesError,
      chains: AERO_CHAINS.map((c) => {
        const rt = runtimes.get(c.id), cfg = config.chains[c.id];
        const points = rt.history.points;
        const phase = c.archive && config.enabled && cfg.enabled ? rt.backfillPhase : 'disabled';
        // 下次尝试：追批或退避时为下一次排定的轮次；归档读取暂停时不早于暂停结束。
        // 轮次进行中没有“下次”：排定的时刻已过去。
        const backfillAt = !rt.running && (phase === 'catching_up' || phase === 'backoff') ? Math.max(rt.nextAt ?? 0, rt.backfillRetryAt ?? 0) || null : null;
        return { id: c.id, name: c.name, enabled: config.enabled && cfg.enabled, rpcHost: rpcHost(cfg.rpcUrl), status: config.enabled && cfg.enabled ? rt.running ? 'loading' : rt.status : 'disabled',
          updatedAt: rt.snapshot ? rt.snapshot.t * 1000 : null, checkedAt: rt.checkedAt, nextAt: rt.running ? null : rt.nextAt, error: rt.error, errorAt: rt.errorAt,
          poolCount: rt.registry?.poolCount ?? null, activeCount: rt.registry?.active.length ?? null, gaugeCount: rt.registry ? rt.registry.pools.filter((p) => p.gauge).length : null,
          history: { points: points.length, from: points.length ? points[0].t * 1000 : null, archive: c.archive ? rt.archive?.ok === false ? 'unavailable' : 'archive' : 'local', pending: rt.backfillPending, phase, nextAt: backfillAt },
          discovery: { at: rt.registry ? rt.registry.discoveredAt * 1000 : null, stale: !!rt.registry && now() / 1000 - rt.registry.discoveredAt > DISCOVERY_STALE_SEC,
            failures: rt.rediscoverFailures, error: rt.rediscoverError, retryAt: rt.rediscoverRetryAt, phase: rt.rediscoverPhase, refreshPending: rt.refreshPending, stalledAttempts: rt.rediscoverStalls } };
      }),
      pools: AERO_CHAINS.filter((c) => config.enabled && config.chains[c.id].enabled).flatMap((c) => runtimes.get(c.id).rows),
      samples: samples ? samples.status() : { available: false, error: null, version: 0 },
    };
  }

  return {
    state,
    tokenPrices,
    pool(chainId, address) {
      const rt = runtimes.get(chainId);
      const key = String(address).toLowerCase();
      if (!rt || !/^0x[0-9a-f]{40}$/.test(key) || !rt.rows.some((r) => r.address === key)) throw new HttpError(404, '没有这个池子的数据');
      // 回填进行中历史点按从新到旧追加，尚未排序。
      const points = rt.history.points.filter((p) => p.rows[key]).map((p) => [p.t * 1000, p.rows[key][0]]).sort((a, b) => a[0] - b[0]);
      if (rt.snapshot?.states[key]) points.push([rt.snapshot.t * 1000, rt.snapshot.states[key].tick]);
      // 本机历史之前的整点用样本库补到 30 天；样本库不可用时只有 7 天。
      const first = points.length ? points[0][0] / 1000 : now() / 1000;
      const older = samples ? samples.ticks(chainId, key, Math.floor(now() / 1000) - PRICE_HISTORY_SEC, first).map(([t, tick]) => [t * 1000, tick]) : [];
      return { chain: chainId, address: key, points: [...older, ...points] };
    },
    // 详情页的流动性分布：按需读链，不进每轮扫描。停用的链不读，避免绕过扫描设置访问 RPC。
    async liquidity(chainId, address) {
      const rt = runtimes.get(chainId), chain = chainById.get(chainId);
      const key = String(address).toLowerCase();
      const row = rt && /^0x[0-9a-f]{40}$/.test(key) ? rt.rows.find((r) => r.address === key) : null;
      if (!row) throw new HttpError(404, '没有这个池子的数据');
      if (!config.enabled || !config.chains[chainId].enabled) throw new HttpError(409, `${chain.name} 扫描已停用，无法读取流动性分布`);
      // 仅复用同一 RPC、60 秒内且池子读数未变的结果；更换节点还会移除在途缓存条目。
      const rpcUrl = config.chains[chainId].rpcUrl;
      const id = `${chainId}:${key}`, hit = liquidityCache.get(id), state = `${row.sqrtPriceX96}:${row.liquidity}:${row.stakedLiquidity}`;
      if (hit && hit.rpcUrl === rpcUrl && hit.state === state && (hit.pending || now() - hit.at < LIQUIDITY_TTL_MS)) return hit.promise;
      const rpc = createRpc({ url: rpcUrl, chainId: chain.chainId, timeoutMs: LIQUIDITY_RPC_TIMEOUT_MS, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(LIQUIDITY_DEADLINE_MS)]) });
      const entry = { at: now(), rpcUrl, state, pending: true, promise: null };
      entry.promise = (async () => {
        try {
          const read = await reads.readPoolLiquidity(rpc, { address: key, tickSpacing: row.tickSpacing });
          return { chain: chainId, address: key, at: now(), block: read.block, tick: read.tick, sqrtPriceX96: read.sqrtPriceX96, liquidity: read.liquidity, stakedLiquidity: read.stakedLiquidity,
            from: read.from, to: read.to, initialized: read.ticks.length, segments: liquiditySegments(read) };
        } catch (reason) {
          if (liquidityCache.get(id) === entry) liquidityCache.delete(id);
          throw new HttpError(502, `读取流动性分布失败：${scrubRpcMessage(reason?.message || reason, rpcUrl, 200)}`);
        } finally { entry.pending = false; entry.at = now(); }
      })();
      liquidityCache.delete(id); liquidityCache.set(id, entry);
      while (liquidityCache.size > LIQUIDITY_CACHE_SIZE) liquidityCache.delete(liquidityCache.keys().next().value);
      return entry.promise;
    },
    // 收藏整体替换；写入串行，内存与文件始终是最后一次请求的结果。
    async saveFavorites(value, authorize = () => {}) {
      authorize();
      const next = strictFavorites(value);
      const write = favoriteWrites.then(() => atomicWrite(favoritesPath, next));
      favoriteWrites = write.catch(() => {});
      await write;
      favorites = next; favoritesError = null; changed();
      return state();
    },
    // known 为浏览器缓存里的标签：内容未变时只回未变化标记，不重发约 700 KB 的样本。
    samples(windowKey, known = null) {
      if (!Object.hasOwn(SAMPLE_WINDOWS, windowKey)) throw new HttpError(400, `窗口须为 ${Object.keys(SAMPLE_WINDOWS).join('、')} 之一`);
      if (!samples) return { window: windowKey, available: false, error: null, version: 0, pools: {} };
      const enabled = AERO_CHAINS.filter((c) => config.enabled && config.chains[c.id].enabled).map((c) => c.id);
      const result = samples.read(windowKey);
      if (!result.available) return result;
      // 标签覆盖内容的全部来源：启动、样本版本、窗口起点（每整点前移）与启用的链。
      const tag = `${boot}.${result.version}.${result.from}.${enabled.join(',')}`;
      if (known === tag) return { window: windowKey, available: true, unchanged: true, tag, version: result.version };
      const on = new Set(enabled);
      // 与列表一致：停用的链不返回样本。
      return { ...result, tag, pools: Object.fromEntries(Object.entries(result.pools).filter(([k]) => on.has(k.slice(0, k.indexOf(':'))))) };
    },
    // 历史回放：按窗口取每个池子的逐小时序列，用页面给的格数与当前读数估算的单次调仓成本重放自动调仓策略。
    // 停用的链、不在跟踪中的池子、样本不足 MIN_REPLAY_HOURS 的池子不返回。
    async replay(value) {
      const request = strictReplayRequest(value);
      const empty = (error) => ({ window: request.window, available: false, error, version: samples?.status().version ?? 0, pools: {} });
      if (!samples) return empty(null);
      let store;
      try { store = await samples.series(); } catch (reason) { return empty(String(reason?.message || reason).slice(0, 240)); }
      if (!store) return empty(samples.status().error);
      const nowSec = Math.floor(now() / 1000), from = Math.floor(nowSec / HOUR) * HOUR - SAMPLE_WINDOWS[request.window] + HOUR;
      const pools = {}, rowsOf = new Map();
      for (const { chain, address, cells } of request.pools) {
        if (!config.enabled || !config.chains[chain].enabled) continue;
        if (!rowsOf.has(chain)) rowsOf.set(chain, new Map(runtimes.get(chain).rows.map((r) => [r.address, r])));
        const row = rowsOf.get(chain).get(address), key = `${chain}:${address}`, s = store.get(key);
        if (!row || !s) continue;
        const i = s.slots.findIndex((slot) => slot >= from);
        if (i < 0) continue;
        const view = Object.fromEntries(Object.entries(s).map(([f, list]) => [f, list.slice(i)]));
        const result = replayPool(view, { tickSpacing: row.tickSpacing, decimals0: row.token0.decimals, decimals1: row.token1.decimals, cells,
          costFraction: rebalanceCostFraction(row, request.deposit), deposit: request.deposit, delaySec: request.delayMin * 60 });
        if (!result || result.hours < MIN_REPLAY_HOURS) continue;
        const r = (v, d = 5) => Number(v.toPrecision(d));
        pools[key] = { hours: r(result.hours, 4), net: r(result.net), emission: r(result.emission), impermanent: r(result.impermanent), cost: r(result.cost),
          rebalances: result.rebalances, intraHour: r(result.intraHour, 3), inRange: r(result.inRange, 3), missingHours: r(result.missingHours, 3), apr: r(result.apr) };
      }
      return { window: request.window, available: true, error: null, version: samples.status().version, from: from * 1000, pools };
    },
    async initialize() {
      if (initialized) return;
      initialized = true;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      samples = openSamples({ file: path.join(directory, 'samples.sqlite'), log, now });
      try { const saved = readBounded(configPath, LIMITS.config); if (saved) config = strictMarketConfig(saved); }
      catch { configError = '扫描配置无效，已按默认配置运行，原文件已保留；重新保存后覆盖'; }
      try { const saved = readBounded(favoritesPath, LIMITS.favorites); if (saved) favorites = strictFavorites(saved); }
      catch { favoritesError = '收藏文件无效，已按空收藏显示，原文件已保留；重新收藏后覆盖'; }
      for (const c of AERO_CHAINS) load(c.id);
      startAll();
    },
    async save(value, authorize = () => {}) {
      authorize();
      const next = strictMarketConfig(value);
      await atomicWrite(configPath, next);
      const before = config;
      config = next; configError = null;
      for (const c of AERO_CHAINS) {
        const rt = runtimes.get(c.id);
        const rpcChanged = before.chains[c.id].rpcUrl !== next.chains[c.id].rpcUrl;
        const discoveryChanged = before.minTvlUsd !== next.minTvlUsd || rpcChanged;
        if (discoveryChanged) {
          rt.generation++; rt.configAbort.abort(); rt.configAbort = new AbortController();
          rt.discoveryDraft = null; rt.rediscover = true; rt.rediscoverPhase = 'pending';
          rt.rediscoverStalls = 0; rt.rediscoverFailures = 0; rt.rediscoverError = null; rt.rediscoverRetryAt = null;
          rt.status = rt.snapshot ? 'ok' : 'idle'; rt.error = null; rt.errorAt = null; rt.failures = 0;
        }
        if (rpcChanged) {
          // 归档能力和历史退避属于旧节点；TVL 阈值不改变节点能力，不清除此结论。
          rt.archive = null; rt.backfillRetryAt = null;
          rt.backfillPending = c.archive && rt.registry?.blockTime ? missingSlots(rt, now() / 1000).length : 0;
          rt.backfillPhase = rt.backfillPending ? 'catching_up' : null;
          for (const key of liquidityCache.keys()) if (key.startsWith(`${c.id}:`)) liquidityCache.delete(key);
        }
        if (!rt.running) { clearTimer(rt.timer); rt.timer = null; if (discoveryChanged) schedule(c.id, 2); }
      }
      startAll(); changed();
      return state();
    },
    refresh(authorize = () => {}) {
      authorize();
      if (!config.enabled) throw new HttpError(409, '扫描已停用，请先启用');
      for (const c of AERO_CHAINS) {
        const rt = runtimes.get(c.id);
        if (!config.chains[c.id].enabled || rt.running || now() - rt.lastStart < MANUAL_MIN_GAP_MS) continue;
        clearTimer(rt.timer); rt.timer = null; void run(c.id);
      }
      return state();
    },
    async close() {
      closed = true; abort.abort();
      for (const rt of runtimes.values()) { clearTimer(rt.timer); rt.timer = null; }
      await Promise.allSettled([...runtimes.values()].map((rt) => rt.running));
      await Promise.allSettled([...runtimes.values()].map((rt) => rt.writes));
      await favoriteWrites;
      samples?.close(); samples = null;
    },
    get directory() { return directory; },
  };
}
