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
import { emissionRate, priceChange, realizedVol, solvePrices, tvlUsd } from './aero-market-core.mjs';
import * as chainReads from './aero-market-rpc.mjs';

const HOUR = 3600;
const HISTORY_SEC = 7 * 86400;
const RATE_HISTORY_SEC = 25 * HOUR; // 这段时间内的历史点保留排放累计，更早的只留 tick
const DISCOVERY_SEC = 6 * HOUR;
const BACKFILL_PER_CYCLE = 24;
// 回填未完成时不等常规间隔：每批之间只歇这么久，7 天历史几分钟补齐，而不是按 15 分钟一批拖近 2 小时。
const BACKFILL_FOLLOW_SEC = 30;
const RETRY_SEC = [60, 120, 300, 600];
const MANUAL_MIN_GAP_MS = 30_000;
const LIMITS = { registry: 8 * 1024 * 1024, history: 32 * 1024 * 1024, snapshot: 8 * 1024 * 1024, config: 64 * 1024 };

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

export function createAeroMarket({ dataDir, enabledByDefault = true, log = console, now = Date.now, reads = chainReads, createRpc = chainReads.createRpc, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const directory = path.join(dataDir, 'aero-market');
  const configPath = path.join(directory, 'config.json');
  const file = (kind, id) => path.join(directory, `${kind}-${id}.json`);
  let config = { ...structuredClone(DEFAULT_CONFIG), enabled: enabledByDefault }, configError = null, initialized = false, closed = false;
  // 以启动时刻为起点：重启后不会与浏览器手里的旧 revision 撞号而误判未变化。
  let revision = Math.floor(Date.now() / 1000);
  const abort = new AbortController();
  const runtimes = new Map(AERO_CHAINS.map((c) => [c.id, { registry: null, snapshot: null, prev: null, history: { schema: 1, points: [] }, rows: [], rpc: null, rpcUrl: '',
    status: 'idle', backfillPending: 0, rediscover: false, error: null, errorAt: null, checkedAt: null, nextAt: null, running: null, timer: null, failures: 0, lastStart: 0, archive: null, writes: Promise.resolve() }]));
  const changed = () => { revision += 1; };

  function rpcFor(id) {
    const rt = runtimes.get(id), url = config.chains[id].rpcUrl;
    if (!rt.rpc || rt.rpcUrl !== url) { rt.rpc = createRpc({ url, chainId: chainById.get(id).chainId, signal: abort.signal }); rt.rpcUrl = url; }
    return rt.rpc;
  }

  function schedule(id, delaySec) {
    const rt = runtimes.get(id);
    clearTimer(rt.timer); rt.timer = null; rt.nextAt = null;
    if (closed || !config.enabled || !config.chains[id].enabled) return;
    rt.nextAt = now() + delaySec * 1000;
    rt.timer = setTimer(() => { rt.timer = null; void run(id); }, delaySec * 1000);
    rt.timer?.unref?.();
  }

  async function discover(id, rpc, block) {
    const chain = chainById.get(id), rt = runtimes.get(id);
    const prior = rt.registry?.factory === chain.clFactory ? rt.registry : null;
    const registry = prior ? structuredClone(prior) : { schema: 1, factory: chain.clFactory, poolCount: 0, pools: [], tokens: {}, active: [], discoveredAt: 0, blockTime: null };
    const { total, added } = await reads.readPoolAddresses(rpc, chain.clFactory, registry.poolCount);
    const statics = await reads.readPoolStatics(rpc, added);
    statics.forEach((s, i) => registry.pools.push(s ?? { address: added[i], invalid: true }));
    registry.poolCount = total;
    const valid = registry.pools.filter((p) => !p.invalid);
    // gauge 可能在建池之后才创建，也可能被替换：每次发现都重读。
    const gauges = await reads.readGauges(rpc, valid.map((p) => p.address));
    // gauge 被替换后累计排放份额换了基准，旧的历史排放点不能再和新读数相减。
    const replaced = [];
    valid.forEach((p, i) => { if (p.gauge !== undefined && p.gauge && p.gauge !== gauges[i]) replaced.push(p.address); p.gauge = gauges[i]; });
    const missing = [...new Set(valid.flatMap((p) => [p.token0, p.token1]))].filter((t) => !registry.tokens[t]);
    if (missing.length) (await reads.readTokens(rpc, missing)).forEach((t, i) => { if (t) registry.tokens[missing[i]] = { symbol: t.symbol, decimals: t.decimals }; });
    const known = valid.filter((p) => registry.tokens[p.token0] && registry.tokens[p.token1]);
    const full = await reads.readPoolStates(rpc, known, block);
    const states = Object.fromEntries(known.map((p, i) => [p.address, full.states[i]]).filter(([, s]) => s));
    const tokens = new Map(Object.entries(registry.tokens));
    const pools = known.filter((p) => states[p.address]).map((p) => ({ ...p, state: states[p.address] }));
    const prices = solvePrices({ pools, tokens, stables: chain.stables.map((s) => s.toLowerCase()) });
    registry.active = pools.filter((p) => {
      if (p.gauge && BigInt(p.state.liquidity) > 0n) return true;
      const tvl = tvlUsd(p.state, tokens.get(p.token0), tokens.get(p.token1), prices.get(p.token0), prices.get(p.token1));
      return tvl !== null && tvl >= config.minTvlUsd;
    }).map((p) => p.address);
    const span = Math.min(10_000, block - 1);
    if (span > 100) { const [a, b] = await Promise.all([rpc.blockTimestamp(block - span), rpc.blockTimestamp(block)]); registry.blockTime = (b - a) / span; }
    registry.discoveredAt = full.timestamp;
    const active = new Set(registry.active);
    return { replaced, registry, snapshot: { t: full.timestamp, block, states: Object.fromEntries(Object.entries(states).filter(([a]) => active.has(a))) } };
  }

  async function backfill(id, rpc, active, block, nowSec) {
    const rt = runtimes.get(id);
    rt.backfillPending = 0;
    if (!rt.registry.blockTime || rt.archive?.failedAt && nowSec - rt.archive.failedAt < DISCOVERY_SEC) return false;
    const points = rt.history.points;
    // 按请求的整点判断是否已读：出块时间外推有偏差时，实际时间戳可能离整点超过 20 分钟，不能据此反复重读。
    const covered = (slot) => points.some((p) => p.slot === slot || Math.abs(p.t - slot) <= 1200);
    const slots = [];
    // 早于创世区块的整点读不到，不计入待补数，否则会一直追批。
    const targetOf = (slot) => block - Math.round((nowSec - slot) / rt.registry.blockTime);
    for (let slot = floorHour(nowSec); slot > nowSec - HISTORY_SEC; slot -= HOUR) if (slot < nowSec - 60 && !covered(slot) && targetOf(slot) >= 1) slots.push(slot);
    rt.backfillPending = slots.length;
    for (const slot of slots.slice(0, BACKFILL_PER_CYCLE)) {
      if (closed) return false;
      const target = targetOf(slot);
      rt.backfillPending--;
      try {
        const read = await reads.readPoolHistory(rpc, active, target, slot >= nowSec - RATE_HISTORY_SEC);
        const rows = {};
        read.states.forEach((s, i) => { if (s) rows[active[i].address] = s.rewardShare === undefined ? [s.tick] : fullRow(s); });
        points.push({ t: read.timestamp, slot, block: target, rows });
        rt.archive = { ok: true };
      } catch (error) {
        rt.backfillPending++;
        if (closed) return false;
        // 节点明确拒绝历史状态（非归档节点）时停止回填，6 小时后再试并改用本机样本；
        // 超时、限流等瞬时错误只结束本轮回填，下一轮继续。都不影响本轮当前数据。
        if (error?.kind === 'node') {
          rt.archive = { ok: false, failedAt: nowSec, error: error.message };
          log.warn?.({ type: 'aero-market', chain: id, err: error.message }, 'Aero 历史区块读取失败，改用本机累计样本');
          rt.backfillPending = 0;
        }
        // 出错（含限流、超时）后按常规间隔再试，不连续追批。
        return false;
      }
    }
    return rt.backfillPending > 0;
  }

  function compactHistory(rt, nowSec) {
    rt.history.points = rt.history.points.filter((p) => p.t > nowSec - HISTORY_SEC - HOUR).sort((a, b) => a.t - b.t);
    for (const p of rt.history.points) if (p.t < nowSec - RATE_HISTORY_SEC) for (const [k, row] of Object.entries(p.rows)) if (row.length > 1) p.rows[k] = [row[0]];
  }

  async function cycle(id) {
    const rt = runtimes.get(id), chain = chainById.get(id);
    const rpc = rpcFor(id);
    const block = await rpc.blockNumber();
    let snapshot, registry = rt.registry;
    const stale = rt.rediscover || !registry || registry.factory !== chain.clFactory || (now() / 1000) - registry.discoveredAt > DISCOVERY_SEC;
    let replaced = [];
    if (stale) { rt.rediscover = false; ({ registry, snapshot, replaced } = await discover(id, rpc, block)); }
    const byAddress = new Map(registry.pools.map((p) => [p.address, p]));
    const active = registry.active.map((a) => byAddress.get(a)).filter(Boolean);
    if (!snapshot) {
      const read = await reads.readPoolStates(rpc, active, block);
      snapshot = { t: read.timestamp, block, states: Object.fromEntries(active.map((p, i) => [p.address, read.states[i]]).filter(([, s]) => s)) };
    }
    if (closed) return;
    rt.registry = registry; rt.prev = rt.snapshot; rt.snapshot = snapshot;
    for (const address of replaced) {
      for (const point of rt.history.points) { const row = point.rows[address]; if (row?.length > 1) point.rows[address] = [row[0]]; }
      if (rt.prev?.states[address]) rt.prev.states[address] = { ...rt.prev.states[address], rewardShare: null };
    }
    const nowSec = snapshot.t;
    // 先发布本轮当前数据，再回填历史：回填一批要十几秒，不能挡住价格、TVL 和排放的更新。
    rt.rows = buildRows({ chain, registry, snapshot, prev: rt.prev, history: rt.history }); changed();
    const follow = chain.archive ? await backfill(id, rpc, active, block, nowSec) : false;
    // 非归档链（或回填失败时）用本轮读数作为小时样本。
    const last = rt.history.points.at(-1);
    if ((!chain.archive || rt.archive?.ok === false) && (!last || nowSec - last.t >= 3000)) rt.history.points.push({ t: nowSec, block, rows: Object.fromEntries(Object.entries(snapshot.states).map(([a, s]) => [a, fullRow(s)])) });
    compactHistory(rt, nowSec);
    rt.rows = buildRows({ chain, registry, snapshot, prev: rt.prev, history: rt.history });
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
      try {
        const follow = await cycle(id);
        rt.status = 'ok'; rt.error = null; rt.errorAt = null; rt.failures = 0;
        schedule(id, follow ? Math.min(BACKFILL_FOLLOW_SEC, config.intervalMin * 60) : config.intervalMin * 60);
      } catch (error) {
        if (closed) return;
        rt.status = 'error'; rt.error = String(error?.message || error).slice(0, 240); rt.errorAt = now();
        log.warn?.({ type: 'aero-market', chain: id, err: rt.error }, 'Aero 市场扫描失败，保留上次数据');
        schedule(id, Math.min(RETRY_SEC[Math.min(rt.failures++, RETRY_SEC.length - 1)], config.intervalMin * 60));
      } finally { rt.checkedAt = now(); rt.running = null; changed(); }
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
      schedule(c.id, Math.max(2 + i * 3, age < config.intervalMin * 60 ? config.intervalMin * 60 - age : 0));
    });
  }

  function aeroPrice() {
    const base = runtimes.get('base');
    const row = base.rows.find((r) => r.token0.address === AERO_BASE.toLowerCase() || r.token1.address === AERO_BASE.toLowerCase());
    const token = row ? (row.token0.address === AERO_BASE.toLowerCase() ? row.token0 : row.token1) : null;
    return { usd: token?.usd ?? null, at: base.snapshot ? base.snapshot.t * 1000 : null };
  }

  function state({ since } = {}) {
    if (since !== undefined && since === revision) return { schema: 1, revision, unchanged: true, serverNow: now() };
    return {
      schema: 1, revision, serverNow: now(), config: structuredClone(config), configError, aero: aeroPrice(),
      chains: AERO_CHAINS.map((c) => {
        const rt = runtimes.get(c.id), cfg = config.chains[c.id];
        const points = rt.history.points;
        return { id: c.id, name: c.name, enabled: config.enabled && cfg.enabled, rpcHost: rpcHost(cfg.rpcUrl), status: config.enabled && cfg.enabled ? rt.running ? 'loading' : rt.status : 'disabled',
          updatedAt: rt.snapshot ? rt.snapshot.t * 1000 : null, checkedAt: rt.checkedAt, nextAt: rt.nextAt, error: rt.error, errorAt: rt.errorAt,
          poolCount: rt.registry?.poolCount ?? null, activeCount: rt.registry?.active.length ?? null, gaugeCount: rt.registry ? rt.registry.pools.filter((p) => p.gauge).length : null,
          history: { points: points.length, from: points.length ? points[0].t * 1000 : null, archive: c.archive ? rt.archive?.ok === false ? 'unavailable' : 'archive' : 'local', pending: rt.backfillPending } };
      }),
      pools: AERO_CHAINS.filter((c) => config.enabled && config.chains[c.id].enabled).flatMap((c) => runtimes.get(c.id).rows),
    };
  }

  return {
    state,
    pool(chainId, address) {
      const rt = runtimes.get(chainId);
      const key = String(address).toLowerCase();
      if (!rt || !/^0x[0-9a-f]{40}$/.test(key) || !rt.rows.some((r) => r.address === key)) throw new HttpError(404, '没有这个池子的数据');
      const points = rt.history.points.filter((p) => p.rows[key]).map((p) => [p.t * 1000, p.rows[key][0]]);
      if (rt.snapshot?.states[key]) points.push([rt.snapshot.t * 1000, rt.snapshot.states[key].tick]);
      return { chain: chainId, address: key, points };
    },
    async initialize() {
      if (initialized) return;
      initialized = true;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { const saved = readBounded(configPath, LIMITS.config); if (saved) config = strictMarketConfig(saved); }
      catch { configError = '扫描配置无效，已按默认配置运行，原文件已保留；重新保存后覆盖'; }
      for (const c of AERO_CHAINS) load(c.id);
      startAll();
    },
    async save(value, authorize = () => {}) {
      authorize();
      const next = strictMarketConfig(value);
      await atomicWrite(configPath, next);
      const before = config;
      config = next; configError = null;
      // 正在发现的轮次可能已按旧门槛筛完：用标志让下一轮重新发现。
      if (before.minTvlUsd !== next.minTvlUsd) for (const rt of runtimes.values()) rt.rediscover = true;
      for (const c of AERO_CHAINS) { const rt = runtimes.get(c.id); if (!rt.running) { clearTimer(rt.timer); rt.timer = null; } }
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
    },
    get directory() { return directory; },
  };
}
