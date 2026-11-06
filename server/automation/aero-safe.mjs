// Aero 市场实盘（Safe + Zodiac Roles）：页面发起手动操作；开启自动调仓后，已质押头寸出区间满设定时间由服务端平仓并居中重开（aero-auto.mjs）。
// bot 私钥经 Roles 以 Safe 名义签名发送。
// 资产与头寸都在 Safe，bot 只付 gas；链上 Roles 是权限的最终判定，tools/aero-roles/policy.mjs 的本地校验是第二道防线。
// 一次只运行一个任务；每笔交易签名后先持久化 pending.json 再广播，重启后按哈希与 nonce 结清，不会重复执行。
import { appendFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Wallet, getAddress, parseUnits } from 'ethers';
import { buildPermissions } from '../../tools/aero-roles/permissions.mjs';
import { allowanceChanges, batchExecuteBefore, buildUpdateBatch, conditionUsage, toTransactionBuilderJson, updateBatchSize, utc } from '../../tools/aero-roles/roles-calls.mjs';
import * as executor from '../../tools/aero-roles/executor.mjs';
import { atomicJson } from '../../tools/entropy-lighter-lab/core.mjs';
import { HttpError } from '../http-common.mjs';
import { AUTO_DEFAULTS, AUTO_HISTORY_LIMIT, centeredRange, deviationBps, evaluateAuto, fitToRoom, poolRoom, readAutoState, roomFullText, roomShortText, strictAutoConfig, stuckReason, usdText } from './aero-auto.mjs';
import { POOL_STATE_LABELS, addBlockedReason, policyOf, readPolicy, strictPoolPolicy, withPoolPolicy } from './aero-policy.mjs';

const PRIVATE_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;
const EVENT_LIMIT = 50;
const LEDGER_TAIL_BYTES = 256 * 1024;
const LEDGER_SHOWN = 30;
const CONTEXT_TTL_MS = 10 * 60_000;
const REFRESH_MIN_MS = 5_000;
// 头寸判为已销毁后，须隔这么久、且区块号前进后再次判定才删除记录（防负载均衡后面滞后的节点）。
const BURN_CONFIRM_MS = 60_000;
const REFRESH_BUDGET_MS = 60_000;
// 白名单变更中要读链的请求（加池、生成批次、核对启用）从开始处理起的总时限，含两次排队等待与队列外读链
// （单次读取另有 20 秒超时、最多 2 次）：须短于 API 转发时限（60 秒），超时即不写盘，
// 避免浏览器或 API 已放弃后仍在后台加入待加池、冻结批次或启用批次。页面等待时间相应长于 API 时限。
export const CHANGE_BUDGET_MS = 50_000;
// API 从收到请求起 60 秒放弃，并随转发带来截止时间：服务端期限不晚于它减去这段余量，
// 收到请求前已花的时间（读请求体、排队转发）也计入，由服务端先回复。
export const CHANGE_DEADLINE_MARGIN_MS = 10_000;
// 已签名未上链超过这个时长后，允许新操作用同一 nonce 提价替换（两笔最多只有一笔上链）。
export const PENDING_STALE_MS = 10 * 60_000;
// 开仓确认基于预览数字：预览超过这个时长后须重新预览。
export const PREVIEW_TTL_MS = 2 * 60_000;
// 本系统开出的头寸 tokenId，只保留最新的这么多个。
const MINTED_LIMIT = 100;
const DEFAULTS = Object.freeze({ rpcUrl: 'https://mainnet.base.org', slippageBps: 50, autoSellRewards: true, minRewardSell: '1' });
const ACTIONS = new Set(['open', 'close', 'reduce', 'exitPool', 'stake', 'unstake', 'claim', 'sell', 'swap']);
const actionLabels = { open: '开仓', close: '平仓', reduce: '减仓', exitPool: '整池平仓', stake: '质押', unstake: '解押', claim: '领取排放', sell: '卖出 AERO', swap: '兑换', rebalance: '自动调仓' };
// 撤出后换币的默认价格冲击上限（基点）。
export const EXIT_IMPACT_BPS = 100;
const AUTO_TICK_MS = 30_000;
// 这些失败不停用自动调仓，下一轮重试：维护或隔离恢复暂停了签名、TWAP 偏离或不可用、单池上限因缺价或读链失败暂时核对不了、
// 仓位策略在任务启动后把本池停止或关闭了自动调仓。
const AUTO_RETRY_CODES = new Set(['halted', 'twap', 'cap', 'policy']);
const autoFile = ({ config, history, halted, reopen, closing }) => ({ schema: 1, config, history, halted, reopen, closing });

function readBounded(file, limit) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.size > limit) throw new Error(`${path.basename(file)} 不是普通文件或过大`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readTail(file, bytes) {
  if (!existsSync(file)) return '';
  const size = lstatSync(file).size, start = Math.max(0, size - bytes), length = size - start;
  const fd = openSync(file, 'r');
  try { const buffer = Buffer.alloc(length); readSync(fd, buffer, 0, length, start); return buffer.toString('utf8'); } finally { closeSync(fd); }
}

const address = (value, label) => {
  try { return getAddress(String(value)); } catch { throw new HttpError(400, `${label} 不是有效地址`); }
};
const integer = (value, label, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${label} 须为 ${min}–${max} 的整数`);
  return value;
};

// 配置：RPC、Safe、Roles 与权限 JSON（与 tools/aero-roles plan 用的是同一份），加上执行参数。
export function strictAeroSafeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '配置须为对象');
  const allowed = new Set(['schema', 'rpcUrl', 'safe', 'roles', 'permissions', 'slippageBps', 'autoSellRewards', 'minRewardSell']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new HttpError(400, `未知配置项 ${key}`);
  const rpcUrl = String(value.rpcUrl ?? DEFAULTS.rpcUrl).trim();
  let url;
  try { url = new URL(rpcUrl); } catch { throw new HttpError(400, 'RPC 地址无效'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'RPC 地址须为 http(s)');
  if (url.username || url.password) throw new HttpError(400, 'RPC 地址不能包含用户名或密码');
  const permissions = value.permissions;
  try { buildPermissions(permissions); } catch (error) { throw new HttpError(400, `权限配置无效：${error.message}`); }
  const minRewardSell = String(value.minRewardSell ?? DEFAULTS.minRewardSell);
  if (!/^\d+(\.\d{1,18})?$/.test(minRewardSell)) throw new HttpError(400, '最小卖出 AERO 数量须为非负小数');
  return {
    schema: 1, rpcUrl, safe: address(value.safe, 'Safe 地址'), roles: address(value.roles, 'Roles 地址'),
    permissions: { roleKey: permissions.roleKey, pools: permissions.pools, swaps: permissions.swaps ?? [], allowances: permissions.allowances },
    slippageBps: integer(value.slippageBps ?? DEFAULTS.slippageBps, '滑点（基点）', 1, 500),
    autoSellRewards: value.autoSellRewards === undefined ? DEFAULTS.autoSellRewards : value.autoSellRewards === true,
    minRewardSell,
  };
}

// 链上快照转成可 JSON 的结构：bigint 一律十进制字符串，附代币精度与符号供页面换算。
function serialize(chain, ctx) {
  const s = (v) => (v == null ? null : String(v));
  return {
    blockNumber: chain.blockNumber, timestamp: chain.timestamp, blockSeconds: chain.blockSeconds ?? null, bot: chain.bot, botEth: s(chain.botEth), ownedNfts: s(chain.ownedNfts), ownedScanned: chain.ownedScanned ?? null,
    inflight: chain.pendingNonce != null && chain.latestNonce != null && chain.pendingNonce > chain.latestNonce,
    tokens: [...ctx.tokens.values()].map((t) => ({ ...t, balance: s(chain.balances[t.address]) })),
    allowances: chain.allowances.map((a) => ({ token: a.token, symbol: a.symbol, perDay: s(a.perDay), remaining: s(a.remaining), maxRefill: s(a.maxRefill), refillAt: a.refillAt == null ? null : Number(a.refillAt) })),
    pools: chain.pools.map((p) => ({
      name: p.name, address: p.address, gauge: p.gauge, token0: p.token0, token1: p.token1, tickSpacing: p.tickSpacing,
      sqrtPriceX96: s(p.sqrtPriceX96), tick: p.tick, feePips: p.feePips, earned: s(p.earned),
      penalty: { minStakeBlocks: s(p.penalty.minStakeBlocks), penaltyRate: s(p.penalty.penaltyRate) },
      positions: p.positions.map((x) => ({ tokenId: s(x.tokenId), staked: x.staked, tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: s(x.liquidity),
        amount0: x.amount0, amount1: x.amount1, tokensOwed0: s(x.tokensOwed0), tokensOwed1: s(x.tokensOwed1), depositBlock: s(x.depositBlock), depositTime: x.depositTime ?? null, penaltyUntilBlock: s(x.penaltyUntilBlock) })),
    })),
  };
}

const rawAmount = (value, label) => {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) throw new HttpError(400, `${label}无效，请重新预览`);
  return BigInt(value);
};
// 开仓须带上用户确认过的预览：服务端签发的预览时间与投入量，执行时偏离则拒绝。
function parseExpect(value, now) {
  const e = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!e) throw new HttpError(400, '开仓须先预览，请预览后再确认');
  if (!Number.isFinite(e.previewedAt) || now - e.previewedAt > PREVIEW_TTL_MS || e.previewedAt > now + 5_000) throw new HttpError(409, `预览已超过 ${PREVIEW_TTL_MS / 60_000} 分钟，请重新预览后再确认`);
  return { amount0: rawAmount(e.amount0, '预览投入量'), amount1: rawAmount(e.amount1, '预览投入量'), swapIn: e.swapIn == null ? 0n : rawAmount(e.swapIn, '预览兑换量'),
    swapTokenIn: e.swapIn == null ? null : address(e.swapTokenIn, '预览兑换代币') };
}

// 投入上限（美元）：{ usd, usd0, usd1 }，后两者为页面行情里两个代币的美元价。价格只用来把按比例算出的投入量等比缩小，不会让投入变多。
function parseCap(value) {
  if (value == null) return null;
  const c = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e15;
  if (!c || Object.keys(c).some((k) => !['usd', 'usd0', 'usd1'].includes(k)) || !positive(c.usd) || !positive(c.usd0) || !positive(c.usd1)) throw new HttpError(400, '投入上限无效：须为正的美元金额，且两个代币都有美元价');
  return { usd: c.usd, usd0: c.usd0, usd1: c.usd1 };
}

// withExpect：执行开仓时为真（必须带预览预期），预览请求本身为假。
function parseParams(action, params, config, tokens, now = Date.now(), withExpect = false) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const slippageBps = p.slippageBps === undefined ? config.slippageBps : integer(p.slippageBps, '滑点（基点）', 1, 500);
  const tokenId = () => { if (typeof p.tokenId !== 'string' || !/^\d{1,78}$/.test(p.tokenId)) throw new HttpError(400, 'tokenId 无效'); return BigInt(p.tokenId); };
  if (action === 'open') {
    return { pool: address(p.pool, '池子地址'), tickLower: integer(p.tickLower, '下沿 tick', -887272, 887272), tickUpper: integer(p.tickUpper, '上沿 tick', -887272, 887272),
      shareBps: integer(p.shareBps ?? 10_000, '投入比例（基点）', 1, 10_000), cap: parseCap(p.cap), rebalance: p.rebalance !== false, slippageBps, stake: p.stake !== false,
      ...(withExpect ? { expect: parseExpect(p.expect, now) } : {}) };
  }
  // 撤出类操作可选 exitToken：撤出后把本池另一种代币（含卖 AERO 所得）换成它；maxImpactBps 为换币的价格冲击上限。
  const exit = () => ({ exitToken: p.exitToken == null ? null : address(p.exitToken, '要换成的代币'),
    maxImpactBps: p.maxImpactBps === undefined ? EXIT_IMPACT_BPS : integer(p.maxImpactBps, '价格冲击上限（基点）', 1, 2000) });
  if (action === 'close') return { tokenId: tokenId(), slippageBps, acceptPenalty: p.acceptPenalty === true, ...exit() };
  if (action === 'reduce') return { tokenId: tokenId(), shareBps: integer(p.shareBps, '减仓比例（基点）', 1, 10_000), slippageBps, acceptPenalty: p.acceptPenalty === true, ...exit() };
  if (action === 'exitPool') return { pool: address(p.pool, '池子地址'), slippageBps, acceptPenalty: p.acceptPenalty === true, ...exit() };
  if (action === 'stake') return { tokenId: tokenId() };
  if (action === 'unstake') return { tokenId: tokenId(), acceptPenalty: p.acceptPenalty === true };
  if (action === 'claim' || action === 'sell') return { slippageBps };
  if (action === 'swap') {
    const tokenIn = address(p.tokenIn, '卖出代币'), tokenOut = address(p.tokenOut, '买入代币');
    const decimals = tokens?.get(tokenIn)?.decimals;
    if (decimals == null) throw new HttpError(409, '代币信息尚未读取，请先刷新');
    if (typeof p.amount !== 'string' || !/^\d+(\.\d+)?$/.test(p.amount)) throw new HttpError(400, '兑换数量须为正小数');
    let amountIn;
    try { amountIn = parseUnits(p.amount, decimals); } catch { throw new HttpError(400, `兑换数量最多 ${decimals} 位小数`); }
    if (amountIn <= 0n) throw new HttpError(400, '兑换数量须大于 0');
    return { tokenIn, tokenOut, amountIn, slippageBps };
  }
  throw new HttpError(404, '未知操作');
}

const jsonable = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v)));

function withBudget(promise, ms, label) {
  let timer;
  const budget = new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, `${label}超过 ${ms / 1000} 秒，请稍后重试`)), ms); timer.unref?.(); });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

const sameAddress = (a, b) => getAddress(a) === getAddress(b);
const listed = (permissions, pool) => permissions.pools.some((p) => sameAddress(p.gauge, pool.gauge)
  || (sameAddress(p.token0, pool.token0.address) && sameAddress(p.token1, pool.token1.address) && Number(p.tickSpacing) === pool.tickSpacing));

// 十进制额度（代币单位）转成最小单位字符串。
export function allowanceUnits(value, symbol, decimals) {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim())) throw new HttpError(400, `请填写 ${symbol} 的每日额度`);
  let raw;
  try { raw = parseUnits(value.trim(), decimals); } catch { throw new HttpError(400, `${symbol} 每日额度最多 ${decimals} 位小数`); }
  if (raw <= 0n || raw >= 1n << 128n) throw new HttpError(400, `${symbol} 每日额度须大于 0 且小于 2^128 最小单位`);
  return String(raw);
}

// 把待变更依次并入权限配置：逐个加池子并补两个方向的兑换路径（该代币对已有路径时沿用），再按待改额度替换或新增每日额度。
// changes.pools 的代币带 { address, symbol, decimals }；changes.allowances 为 { token, symbol, perDay（最小单位字符串）}。
export function applyChanges(permissions, changes) {
  const pools = [...permissions.pools], swaps = [...(permissions.swaps ?? [])], allowances = permissions.allowances.map((a) => ({ ...a }));
  for (const pool of changes.pools) {
    if (listed({ pools }, pool)) continue;
    pools.push({ name: pool.name, token0: pool.token0.address, token1: pool.token1.address, tickSpacing: pool.tickSpacing, gauge: pool.gauge });
    for (const [a, b] of [[pool.token0.address, pool.token1.address], [pool.token1.address, pool.token0.address]]) {
      if (!swaps.some((s) => sameAddress(s.tokenIn, a) && sameAddress(s.tokenOut, b))) swaps.push({ tokenIn: a, tokenOut: b, tickSpacing: pool.tickSpacing });
    }
  }
  for (const change of changes.allowances) {
    const existing = allowances.find((a) => sameAddress(a.token, change.token));
    if (existing) existing.perDay = change.perDay; else allowances.push({ token: change.token, symbol: change.symbol, perDay: change.perDay });
  }
  return { roleKey: permissions.roleKey, pools, swaps, allowances };
}

// 去掉已不需要的待变更：池子已进白名单、额度与配置相同、新代币额度对应的待加池已移出。
export function normalizeChanges(permissions, changes) {
  const pools = changes.pools.filter((p) => !listed(permissions, p));
  const configured = (token) => permissions.allowances.find((a) => sameAddress(a.token, token));
  const needed = new Set(pools.flatMap((p) => [p.token0.address, p.token1.address]).filter((t) => !configured(t)).map((t) => getAddress(t)));
  const allowances = changes.allowances.filter((a) => { const c = configured(a.token); return c ? c.perDay !== a.perDay : needed.has(getAddress(a.token)); });
  return { ...changes, pools, allowances };
}

const EMPTY_CHANGES = Object.freeze({ schema: 1, pools: [], allowances: [], batch: null });
const changeToken = (t) => ({ address: getAddress(t?.address), symbol: String(t?.symbol ?? '').slice(0, 32), decimals: Number(t?.decimals) });
// 加池时 gauge 停用状态的读数（Voter.isActivated 与 CLGaugeFactory.emissionCap）：alive 或 unknown（已停用的池子加不进来）。旧版本加入的池子没有核对过，按 unknown。
const gaugeStatusOf = (value) => (value?.state === 'alive' || value?.state === 'unknown'
  ? { state: value.state, note: String(value.note ?? '').slice(0, 200) }
  : { state: 'unknown', note: '加入时未核对 gauge 是否已被停用' });
// 读回待变更文件：格式不符时整份放弃（随时可重新加入）。
function readChanges(saved) {
  if (saved?.schema !== 1 || !Array.isArray(saved.pools) || !Array.isArray(saved.allowances)) throw new Error('格式不符');
  const pools = saved.pools.map((p) => {
    const pool = { address: getAddress(p.address), name: String(p.name), gauge: getAddress(p.gauge), tickSpacing: Number(p.tickSpacing), token0: changeToken(p.token0), token1: changeToken(p.token1), addedAt: Number(p.addedAt) || 0,
      gaugeStatus: gaugeStatusOf(p.gaugeStatus) };
    if (!Number.isInteger(pool.tickSpacing) || ![pool.token0, pool.token1].every((t) => t.symbol && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36)) throw new Error('池子格式不符');
    return pool;
  });
  const allowances = saved.allowances.map((a) => {
    if (typeof a.perDay !== 'string' || !/^\d{1,39}$/.test(a.perDay) || !Number.isInteger(a.decimals)) throw new Error('额度格式不符');
    return { token: getAddress(a.token), symbol: String(a.symbol).slice(0, 32), decimals: a.decimals, perDay: a.perDay };
  });
  let batch = null;
  if (saved.batch) {
    const b = saved.batch;
    if (typeof b.baseline !== 'string' || !Number.isFinite(b.createdAt) || !Number.isInteger(b.transactions)) throw new Error('批次格式不符');
    buildPermissions(b.permissions);
    if (b.target !== undefined && typeof b.target !== 'string') throw new Error('批次格式不符');
    if (b.executeBefore != null && !Number.isFinite(b.executeBefore)) throw new Error('批次格式不符');
    batch = { createdAt: b.createdAt, baseline: b.baseline, ...(b.target === undefined ? {} : { target: b.target }), permissions: b.permissions, transactions: b.transactions,
      executeBefore: b.executeBefore ?? null,
      pools: (b.pools ?? []).map(String), allowances: (b.allowances ?? []).map((a) => ({ ...(a.token === undefined ? {} : { token: getAddress(a.token) }), symbol: String(a.symbol), perDay: String(a.perDay), decimals: Number(a.decimals) })) };
  }
  return { schema: 1, pools, allowances, batch };
}
// 上一版的单个加池计划（pool-plan.json）转成待变更，批次原样保留。
function migratePoolPlan(saved) {
  if (saved?.schema !== 1 || typeof saved.baseline !== 'string' || !saved.pool?.name) throw new Error('格式不符');
  const p = saved.pool;
  return readChanges({ schema: 1, pools: [{ ...p, addedAt: saved.createdAt }], allowances: (p.allowances ?? []).map((a) => ({ ...a })),
    batch: { createdAt: saved.createdAt, baseline: saved.baseline, permissions: saved.permissions, transactions: p.transactions, pools: [p.name], allowances: p.allowances ?? [] } });
}

// readPrices：行情扫描的 Base 代币美元价 { at, usd: { 小写地址: 美元价 } } 或 null，只用于按总资产比例核对单池上限。
export function createAeroSafe({ dataDir, encrypt, decrypt, readMaintenance = () => false, readAdmission = () => true, readPrices = () => null, log = console, now = Date.now,
  chain = executor, makeProvider = executor.provider, changeBudgetMs = CHANGE_BUDGET_MS } = {}) {
  const directory = path.join(dataDir, 'aero-safe');
  const configPath = path.join(directory, 'config.json'), walletPath = path.join(directory, 'wallet.json');
  const pendingPath = path.join(directory, 'pending.json'), ledgerPath = path.join(directory, 'txs.jsonl'), mintedPath = path.join(directory, 'minted.json');
  const autoPath = path.join(directory, 'auto.json'), changesPath = path.join(directory, 'changes.json'), poolPlanPath = path.join(directory, 'pool-plan.json');
  const policyPath = path.join(directory, 'policy.json');
  // 仓位策略：读不出时 corrupt 为原因，所有池子不能加仓、自动调仓不动，直到人工核对文件。
  let policy = { pools: {} };
  // 白名单待变更：待加池（可多个）与额度调整，合成一份 Safe 批次；批次生成时冻结，链上核对生效后并入配置，批次之后新加的变更继续保留。
  let changes = EMPTY_CHANGES, changesPreview = null, changesWriteError = null, verifyingBatch = false;
  let auto = { config: { ...AUTO_DEFAULTS }, history: [], halted: null, reopen: null, closing: null }, autoError = null, autoWatch = [], autoNote = null, autoCheckedAt = null;
  let outSince = new Map(), autoTimer = null, autoBusy = false, autoCorrupt = null;
  // configGeneration：每次替换 config 加一；在串行队列外等 RPC 的操作回到队列提交前，据此确认配置没被换过。
  let configGeneration = 0;
  let config = null, configError = null, wallet = null, pending = null, job = null, snapshot = null, snapshotAt = null, snapshotError = null;
  let context = null, refreshing = null, closed = false, initialized = false, ledgerError = null, minted = [], burnSeen = new Map();
  const events = [];
  let operation = Promise.resolve();
  const serial = (fn) => {
    const next = operation.then(() => { if (closed) throw new HttpError(503, 'Aero 实盘服务正在关闭'); return fn(); });
    operation = next.catch(() => {}); return next;
  };
  const record = (entry) => { events.push({ at: now(), ...jsonable(entry) }); if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT); };
  const holdReason = () => (readMaintenance() ? '工作台正在更新维护，实盘操作暂停' : !readAdmission() ? '账户写入处于隔离恢复状态，实盘操作暂停' : null);

  function ledger() {
    try {
      const lines = readTail(ledgerPath, LEDGER_TAIL_BYTES).split('\n').filter(Boolean);
      const seen = new Set(), out = [];
      for (const line of lines.reverse()) {
        try { const e = JSON.parse(line); if (typeof e?.hash === 'string' && !seen.has(e.hash)) { seen.add(e.hash); out.push(e); } } catch {}
        if (out.length >= LEDGER_SHOWN) break;
      }
      return out;
    } catch { return []; }
  }
  function state() {
    return {
      schema: 1, configured: Boolean(config), config: config && structuredClone(config), configError, defaults: DEFAULTS, wallet,
      paused: holdReason() !== null, pauseReason: holdReason(),
      pending: pending && { hash: pending.hash, nonce: pending.nonce, label: pending.label, at: pending.at, stale: now() - pending.at >= PENDING_STALE_MS },
      ledgerError,
      job: job && structuredClone(job), chain: snapshot && structuredClone(snapshot), chainAt: snapshotAt, chainError: snapshotError, refreshing: Boolean(refreshing),
      events: structuredClone(events), ledger: ledger(), serverNow: now(),
      changes: changesView(),
      policy: policyView(),
      auto: { config: { ...auto.config }, defaults: AUTO_DEFAULTS, error: autoError, halted: auto.halted && { ...auto.halted }, reopen: auto.reopen && { ...auto.reopen }, closing: auto.closing && { ...auto.closing }, stuck: stuckReason(auto),
        history: auto.history.slice(-10).reverse(), watch: structuredClone(autoWatch), note: autoNote, checkedAt: autoCheckedAt, intervalMs: AUTO_TICK_MS },
    };
  }
  // 仓位策略与各池上限的占用（按最新快照与行情价估算，只供页面显示；执行时按最新链上状态再算）。
  function policyView() {
    const rooms = {};
    let prices = null;
    try { prices = readPrices(); } catch {}
    for (const pool of snapshot?.pools ?? []) {
      const rule = policyOf(policy, pool.address);
      if (rule.capUsd === null) continue;
      const room = poolRoom({ chain: snapshot, prices, pool: pool.address, capUsd: rule.capUsd, now: now() });
      rooms[pool.address.toLowerCase()] = room.error ? { error: room.error } : { error: null, capUsd: room.capUsd, inPoolUsd: room.inPoolUsd, roomUsd: room.roomUsd };
    }
    return { pools: structuredClone(policy.pools), corrupt: policy.corrupt ?? null, rooms };
  }
  // 按仓位策略核对手动开仓、加仓：池子须为「运行」；设了美元上限时按最新链上状态与行情价算出剩余空间，
  // 与页面填的投入上限取小，交给 openPosition 等比缩小投入量。返回 { cap, limit }，limit 供预览显示。
  async function openLimit(ctx, poolAddress, userCap) {
    const blocked = addBlockedReason(policy, poolAddress);
    if (blocked) throw new chain.ExecError(blocked);
    const { capUsd } = policyOf(policy, poolAddress);
    if (capUsd === null) return { cap: userCap, limit: null };
    let fresh, prices = null;
    try { fresh = serialize(await withBudget(chain.readState(ctx, { knownIds: minted }), REFRESH_BUDGET_MS, '读取链上状态'), ctx); } catch (error) {
      throw new chain.ExecError(`核对单池上限时读取链上状态失败（${error.message}），未开仓`);
    }
    try { prices = readPrices(); } catch (error) { log.warn?.({ type: 'aero-safe', err: error }, 'Aero 行情价格读取失败'); }
    const room = poolRoom({ chain: fresh, prices, pool: poolAddress, capUsd, now: now() });
    if (room.error) throw new chain.ExecError(`${room.error}，未开仓`);
    if (!(room.roomUsd > 0)) throw new chain.ExecError(`${roomFullText(room)}，不能再开仓或加仓；可在「仓位」调高本池上限`);
    const usd = Math.min(room.roomUsd, userCap?.usd ?? Infinity);
    return { cap: { usd, usd0: room.usd0, usd1: room.usd1 }, limit: { capUsd, inPoolUsd: room.inPoolUsd, roomUsd: room.roomUsd } };
  }

  // 待变更合成后的权限、批次笔数与条件节点用量；按配置与待变更缓存，不在每次轮询时重算。额度那几笔的参数要读链，生成批次时才算。
  function changesNext() {
    // 批次每笔发往 config.roles、由 config.safe 执行：二者也是缓存键的一部分。
    const key = JSON.stringify([config ? batchTarget(config) : null, config?.permissions ?? null, changes.pools, changes.allowances]);
    if (changesPreview?.key === key) return changesPreview;
    let out = { key, permissions: null, size: 0, usage: [], error: null };
    if (config && (changes.pools.length || changes.allowances.length)) {
      try {
        const permissions = applyChanges(config.permissions, changes), built = buildPermissions(permissions);
        out = { ...out, permissions, size: updateBatchSize({ current: buildPermissions(config.permissions), next: built, roles: config.roles }), usage: conditionUsage(built) };
      } catch (error) {
        out.error = /condition tree has \d+ nodes/.test(error.message) ? `白名单已满：${error.message}（Roles 每个函数最多 255 个条件节点）` : `生成权限失败：${error.message}`;
      }
    }
    changesPreview = out;
    return out;
  }
  // 批次生成时的 Safe 与 Roles；换了任一个，旧批次不能再核对。上一版迁移来的批次没有记录目标，无从确认它发往哪个 Safe/Roles，一律要求重新生成。
  function batchTarget(cfg) { return `${cfg.safe.toLowerCase()}|${cfg.roles.toLowerCase()}`; }
  function staleReason(batch) {
    if (!config) return '请先保存 Safe 配置';
    if (typeof batch.target !== 'string') return '这份批次来自旧版本，没有记录 Safe 与 Roles 地址，不能再核对，请重新生成';
    if (batch.target !== batchTarget(config)) return 'Safe 或 Roles 地址在生成批次后已更换，这份批次不能再核对，请重新生成';
    if (batch.baseline !== JSON.stringify(config.permissions)) return 'Safe 权限配置在生成批次后已变化，这份批次不能再核对，请重新生成';
    return null;
  }
  const permissionsKey = (p) => JSON.stringify({ roleKey: p.roleKey, pools: p.pools, swaps: p.swaps ?? [], allowances: p.allowances });
  // 批次的权限已是当前配置（核对启用写入配置后，待变更没写进去就重启）：当作已启用，不再要求重新生成或签名。
  function batchApplied(batch) {
    return Boolean(config) && typeof batch.target === 'string' && batch.target === batchTarget(config) && permissionsKey(batch.permissions) === permissionsKey(config.permissions);
  }
  // 冻结批次与最新草稿的差异：added 只在草稿里（不在这份批次）；withdrawn 只在批次里（草稿已撤回或改了值，旧批次文件执行时仍会生效）。
  function batchDiff(batch) {
    const draftPools = changes.pools.map((p) => p.name);
    const draft = changes.allowances.map((a) => ({ token: a.token, symbol: a.symbol, perDay: a.perDay, decimals: a.decimals }));
    const same = (a, b) => (a.token && b.token ? sameAddress(a.token, b.token) : a.symbol === b.symbol) && a.perDay === b.perDay;
    const label = ({ symbol, perDay, decimals }) => ({ symbol, perDay, decimals });
    return {
      added: { pools: draftPools.filter((name) => !batch.pools.includes(name)), allowances: draft.filter((a) => !batch.allowances.some((b) => same(a, b))).map(label) },
      withdrawn: { pools: batch.pools.filter((name) => !draftPools.includes(name)), allowances: batch.allowances.filter((b) => !draft.some((a) => same(a, b))).map(label) },
    };
  }
  function changesView() {
    const next = changesNext(), batch = changes.batch;
    const current = (token) => config?.permissions.allowances.find((a) => sameAddress(a.token, token))?.perDay ?? null;
    const stale = batch && staleReason(batch);
    return {
      pools: structuredClone(changes.pools), allowances: changes.allowances.map((a) => ({ ...a, current: current(a.token) })),
      preview: { transactions: next.size, usage: next.usage, error: next.error },
      persistError: changesWriteError,
      batch: batch && { createdAt: batch.createdAt, transactions: batch.transactions, pools: [...batch.pools], allowances: batch.allowances.map(({ symbol, perDay, decimals }) => ({ symbol, perDay, decimals })),
        stale: Boolean(stale), staleReason: stale,
        // 执行期限（毫秒）：本期补满前 10 分钟；到补满时刻后才在 Safe 执行，执行当期额度会补满、执行前已花的不计入。过期不妨碍核对已在期限前执行的批次。
        executeBefore: batch.executeBefore ?? null, expired: batch.executeBefore != null && now() >= batch.executeBefore,
        behind: Boolean(next.permissions) && JSON.stringify(next.permissions) !== JSON.stringify(batch.permissions),
        ...batchDiff(batch) },
    };
  }
  // 保存待变更；全空时删除文件。失败时内存保持原样。
  function saveChanges(next) {
    const empty = !next.pools.length && !next.allowances.length && !next.batch;
    try { if (empty) rmSync(changesPath, { force: true }); else atomicJson(changesPath, next); } catch (error) {
      log.warn?.({ type: 'aero-safe', err: error }, 'Aero 白名单待变更保存失败');
      throw new HttpError(500, '白名单待变更保存失败，请检查数据目录权限后重试');
    }
    changes = empty ? EMPTY_CHANGES : next; changesWriteError = null;
  }
  // 配置已经写入、待变更必须跟着整理时：写不进去也按整理后的内容继续，并在页面报告；下次写入成功即清除。
  function keepChanges(next, message) {
    try { saveChanges(next); } catch (error) {
      changes = next; changesWriteError = message;
      record({ event: 'changes_write_failed', error: message });
    }
  }
  // 配置变化后清掉已生效或已无意义的待变更。recognizeApplied 只在启动时为 true：
  // 认出「核对启用写入配置后待变更没写进去」的批次；运行时手动保存出相同权限不代表批次已在 Safe 执行，仍按失效处理。
  function settleChanges({ recognizeApplied = false } = {}) {
    if (!config) return;
    const applied = recognizeApplied && changes.batch && batchApplied(changes.batch);
    const next = normalizeChanges(config.permissions, applied ? { ...changes, batch: null } : changes);
    if (JSON.stringify(next) === JSON.stringify(changes)) return;
    if (applied) record({ event: 'changes_batch_recognized', pools: changes.batch.pools });
    keepChanges(next, '白名单待变更文件 aero-safe/changes.json 写入失败，页面显示的是整理后的内容；重启后会按配置重新整理。请检查数据目录权限');
  }
  // 一次白名单变更请求的整体期限（changeBudgetMs，从开始处理起；有请求截止时间 requestDeadline 时不晚于它减去余量）：
  // 两次排队与队列外读链都计入，超时返回 504。提示里的秒数按从 API 收到请求起算。
  // 超时后才轮到的队列回调直接放弃、不写盘。queued 的回调须同步完成写盘，开始写盘后期限不会打断它，不会半写。
  function changeBudget(what, undone, requestDeadline) {
    const own = now() + changeBudgetMs;
    const deadline = Number.isSafeInteger(requestDeadline) ? Math.min(own, requestDeadline - CHANGE_DEADLINE_MARGIN_MS) : own;
    let abandoned = false;
    const late = () => { abandoned = true; return new HttpError(504, `${what}超过 ${changeBudgetMs / 1000} 秒（含排队等待其他操作），${undone}，请稍后重试`); };
    const left = () => { const ms = deadline - now(); if (ms <= 0) throw late(); return ms; };
    const queued = (fn) => {
      let ms;
      try { ms = left(); } catch (error) { return Promise.reject(error); }
      let timer;
      const budget = new Promise((_, reject) => { timer = setTimeout(() => reject(late()), ms); timer.unref?.(); });
      return Promise.race([serial(() => { if (abandoned || now() >= deadline) throw late(); return fn(); }), budget]).finally(() => clearTimeout(timer));
    };
    // start 在确认还有剩余时间后才调用，免得已超时仍发出读链请求。
    const read = async (start, label) => {
      const ms = left();
      try { return await withBudget(start(), ms, label); } catch (error) {
        if (error instanceof HttpError && error.status === 504) throw late();
        throw error;
      }
    };
    return { queued, read };
  }
  // 链上读取并核验池子，返回带精度与符号的池子信息。
  async function inspect(poolAddress, cfg, budget) {
    let info;
    try { info = await budget.read(() => chain.inspectPool(makeProvider(cfg.rpcUrl), poolAddress), '链上核验池子'); } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof chain.ExecError && error.code !== 'rpc') throw new HttpError(400, error.message);
      throw new HttpError(502, `链上核验池子失败：${error.message}`);
    }
    for (const a of [info.gauge, info.token0.address, info.token1.address]) {
      if ([cfg.safe, cfg.roles].some((own) => sameAddress(own, a))) throw new HttpError(400, '池子的代币或 gauge 不能是 Safe 或 Roles 合约');
    }
    return info;
  }
  // 变更后的权限须能生成（条件树不超限）才接受。
  function acceptChanges(next) {
    const before = changes, beforePreview = changesPreview;
    changes = next; changesPreview = null;
    const { error } = changesNext();
    changes = before; changesPreview = beforePreview;
    if (error) throw new HttpError(/^白名单已满/.test(error) ? 409 : 400, error);
    saveChanges(next);
  }
  const requireChangesConfig = () => {
    if (!config) throw new HttpError(409, '请先保存 Safe 配置');
  };

  function readKey() {
    const saved = readBounded(walletPath, 16 * 1024);
    if (!saved) return null;
    const key = decrypt(saved.key);
    if (typeof key !== 'string' || !PRIVATE_KEY_PATTERN.test(key) || new Wallet(key).address !== saved.address) throw new Error('invalid_wallet');
    return key;
  }
  // 连接按配置与钱包缓存 10 分钟；配置或钱包变化时作废。
  async function connection() {
    if (!config) throw new HttpError(409, '请先保存 Safe 配置');
    const stamp = `${JSON.stringify(config)}:${wallet}`;
    if (context?.stamp === stamp && now() - context.at < CONTEXT_TTL_MS) return context.ctx;
    const rpc = makeProvider(config.rpcUrl);
    let key = null;
    try { key = readKey(); } catch { throw new HttpError(500, '已保存的 bot 私钥无法读取，请重新填写'); }
    const ctx = await chain.connect({ rpc, signer: key ? new Wallet(key, rpc) : null, safe: config.safe, roles: config.roles, config: config.permissions, now });
    context = { stamp, at: now(), ctx };
    return ctx;
  }
  // quiet：同 nonce 替换时旧交易的 replaced 行。写失败只记事件、不设 ledgerError：旧哈希留在新交易记录的 replaces 里，
  // 旧交易上链时结清会补记 confirmed；新交易上链时旧交易的 replaced 行就缺失（只剩事件），不影响资金判断。
  function settle(entry, receipt, outcome, { quiet = false } = {}) {
    const status = outcome ?? (receipt?.status === 1 ? 'confirmed' : 'reverted');
    try {
      appendFileSync(ledgerPath, `${JSON.stringify({ at: now(), hash: entry.hash, nonce: entry.nonce, label: entry.label, status, block: receipt?.blockNumber ?? null,
        gasUsed: receipt?.gasUsed != null ? String(receipt.gasUsed) : null, fee: receipt?.fee != null ? String(receipt.fee) : null })}\n`, { mode: 0o600 });
    } catch (error) {
      // 台账没写上就保留待确认记录：它是这笔交易唯一的持久记录，下次结清时按回执重写。
      log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘交易记录写入失败');
      record({ event: 'ledger_write_failed', label: entry.label, hash: entry.hash, status });
      if (quiet) return false;
      ledgerError = `交易记录写入失败（${entry.label}，${status}）：${error.code ?? error.message}；交易本身已有结果，修复数据目录后刷新即可补记`;
      return false;
    }
    if (!quiet) ledgerError = null;
    // 删除失败时记录留在磁盘，下次结清会按回执再记一次（台账按哈希去重）。
    if (pending?.hash === entry.hash) {
      try { rmSync(pendingPath, { force: true }); pending = null; } catch (error) { log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘待确认记录删除失败'); }
    }
    record({ event: 'tx_settled', label: entry.label, hash: entry.hash, status });
    return true;
  }
  // 结清上一笔已签名交易。返回 null（无待确认）或 'waiting'。
  // await 期间 pending 可能被同 nonce 替换，结清只针对开始时的那一笔。
  async function resolve(ctx) {
    const current = pending;
    if (!current) return null;
    if (current.unreadable) return 'waiting';
    const result = await chain.resolvePending(ctx, current);
    if (result.state === 'waiting') return 'waiting';
    // 替换交易被丢弃而旧交易上链：先按旧交易的回执改记（台账按哈希取最新一行），再结清替换交易。
    // 旧交易那一行没写上时不结清替换交易：保留待确认记录，下次重试补记。
    if (result.replacedReceipt && result.replaced && !settle({ hash: result.replaced.hash, nonce: current.nonce, label: result.replaced.label }, result.replacedReceipt)) return 'waiting';
    settle(current, result.receipt ?? null, result.state === 'dropped' ? 'dropped' : undefined);
    return pending ? 'waiting' : null;
  }
  const hooks = (jobId, ctx) => ({
    halted: () => holdReason() !== null || closed,
    pending: () => pending,
    resolvePrior: () => resolve(ctx),
    persistPending: (entry) => {
      const replaced = pending && pending.hash !== entry.hash && pending.nonce === entry.nonce ? pending : null;
      if (pending && !replaced) throw new Error('上一笔交易尚未结清');
      atomicJson(pendingPath, entry); pending = entry;
      if (job?.id === jobId) job.signed = true;
      // 同 nonce 提价替换：旧交易与新交易最多一笔上链，旧的结果记为 replaced（以链上为准）。
      if (replaced) settle(replaced, null, 'replaced', { quiet: true });
    },
    settle: (entry, receipt) => settle(entry, receipt),
    log: (entry) => record({ job: jobId, ...entry }),
    step: (name) => { if (job?.id === jobId) job.step = name; },
    minted: (tokenId) => remember(tokenId),
  });

  async function readChain() {
    const ctx = await connection();
    try { await resolve(ctx); } catch (error) { record({ event: 'pending_check_failed', error: error.message }); }
    const value = await chain.readState(ctx, { knownIds: minted });
    // 每次刷新都判为已销毁、且距首次判定满 BURN_CONFIRM_MS 并跨过更新的区块才删除，偶发误判不会丢掉头寸记录。
    const at = now(), block = Number(value.blockNumber);
    const seen = new Map((value.burnedIds ?? []).map((id) => [String(id), burnSeen.get(String(id)) ?? { at, block }]));
    const confirmed = [...seen].filter(([, first]) => at - first.at >= BURN_CONFIRM_MS && block > first.block).map(([id]) => id);
    forget(confirmed);
    for (const id of confirmed) seen.delete(id);
    burnSeen = seen;
    snapshot = serialize(value, ctx); snapshotAt = now(); snapshotError = null;
  }
  function refresh() {
    if (refreshing) return refreshing;
    let timer;
    const budget = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`读取超过 ${REFRESH_BUDGET_MS / 1000} 秒`)), REFRESH_BUDGET_MS); timer.unref?.(); });
    refreshing = Promise.race([readChain(), budget])
      .catch((error) => { snapshotError = error.message; context = null; })
      .finally(() => { clearTimeout(timer); refreshing = null; });
    return refreshing;
  }

  async function run(action, params) {
    const id = job.id;
    try {
      const ctx = await connection();
      const h = hooks(id, ctx);
      let result;
      const sellAfter = async (maxAmount = null) => {
        if (!config.autoSellRewards) return null;
        h.step('卖出 AERO');
        const minAmount = parseUnits(config.minRewardSell, ctx.tokens.get(chain.REWARD_TOKEN)?.decimals ?? 18);
        return chain.sellRewards(ctx, h, { slippageBps: params.slippageBps ?? config.slippageBps, minAmount, maxAmount });
      };
      if (action === 'open') {
        h.step('核对仓位策略');
        const { cap } = await openLimit(ctx, params.pool, params.cap);
        result = await chain.openPosition(ctx, h, { ...params, cap });
      } else if (action === 'close' || action === 'reduce' || action === 'exitPool') result = await withdraw(ctx, h, action, params, sellAfter);
      else if (action === 'stake') result = await chain.stakePosition(ctx, h, params);
      else if (action === 'unstake') { result = await chain.unstakePosition(ctx, h, params); result.sold = await sellAfter(); }
      else if (action === 'claim') { h.step('领取排放'); result = await chain.claimRewards(ctx, h); result.sold = await sellAfter(); }
      else if (action === 'sell') result = await chain.sellRewards(ctx, h, { slippageBps: params.slippageBps, minAmount: 1n });
      else if (action === 'swap') result = await chain.swap(ctx, h, params);
      else if (action === 'rebalance') result = await rebalance(ctx, h, params, sellAfter);
      Object.assign(job, { status: 'done', finishedAt: now(), result: jsonable(result), step: null });
      record({ event: 'job_done', job: id, action });
    } catch (error) {
      // 前面的步骤已签名上链时，后续步骤失败也不能显示为"未签名"。
      Object.assign(job, { status: 'failed', finishedAt: now(), error: error.message, signed: error.signed === true || job.signed === true, code: error.code ?? null });
      record({ event: 'job_failed', job: id, action, error: error.message });
      if (!(error instanceof chain.ExecError)) log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘操作异常');
      // 自动调仓出错一律停用、等人工处理。只有暂停签名与 TWAP 核对不过、这笔没签名、进度也都已落盘（没有平仓中断或结果未定的兑换/开仓）时下一轮重试；
      // 已平仓时重试只做重开，已开出新头寸时只做质押。
      if (action === 'rebalance') {
        const retry = error instanceof chain.ExecError && AUTO_RETRY_CODES.has(error.code) && error.signed !== true && !stuckReason(auto) && !autoError;
        if (retry) autoNote = error.message;
        else { auto.halted = { at: now(), reason: stuckReason(auto) ?? error.message }; saveAuto(); record({ event: 'auto_halted', error: error.message }); }
      }
    }
    await refresh();
  }

  // 撤出：平仓、减仓或整池平仓，之后按设置卖出 AERO，再可选地把本池另一种代币换成 exitToken。
  // 换币只卖这次任务新增到 Safe 的部分（撤出所得与卖 AERO 所得），不超过今日剩余额度；额度不够、价格冲击过大或报价失败时
  // 未换的币留在 Safe，任务仍算完成并写明原因。换币路径与罚没期在签名前先核对。
  async function withdraw(ctx, h, action, params, sellAfter) {
    let pool, ids;
    if (action === 'exitPool') {
      pool = ctx.pools.find((p) => p.address.toLowerCase() === params.pool.toLowerCase());
      if (!pool) throw new chain.ExecError('池子不在白名单里');
      h.step('读取本池头寸');
      let fresh;
      try { fresh = await withBudget(chain.readState(ctx, { knownIds: minted }), REFRESH_BUDGET_MS, '读取链上状态'); } catch (error) { throw new chain.ExecError(`读取本池头寸失败：${error.message}，未操作`); }
      const positions = fresh.pools.find((p) => p.address.toLowerCase() === pool.address.toLowerCase())?.positions ?? [];
      if (!positions.length) throw new chain.ExecError('Safe 在本池没有头寸');
      const locked = positions.filter((x) => x.staked && x.penaltyUntilBlock != null && BigInt(fresh.blockNumber) < BigInt(x.penaltyUntilBlock));
      if (locked.length && !params.acceptPenalty) throw new chain.ExecError(`头寸 ${locked.map((x) => `#${x.tokenId}`).join('、')} 仍在提前解押罚没期内，确认接受罚没后再整池平仓，未操作`, { code: 'penalty' });
      ids = positions.map((x) => BigInt(x.tokenId));
    } else {
      ({ pool } = await chain.locate(ctx, params.tokenId));
      ids = [params.tokenId];
    }
    const route = params.exitToken ? chain.exitRoute(ctx, pool, params.exitToken) : null;
    const before = route ? (await chain.safeBalances(ctx, [route.tokenIn]))[0] : 0n;
    const result = { pool: pool.address };
    if (action === 'reduce' && params.shareBps < 10_000) Object.assign(result, await chain.reducePosition(ctx, h, params));
    else {
      const closed = [];
      for (const tokenId of ids) {
        if (ids.length > 1) h.step(`平仓 #${tokenId}`);
        try { await chain.closePosition(ctx, h, { tokenId, slippageBps: params.slippageBps, acceptPenalty: params.acceptPenalty }); } catch (error) {
          // 整池平仓中途失败：写明已平的头寸，且之后的卖出与换币都没做，免得重试时以为前面的币也换过了。
          if (!closed.length) throw error;
          throw new chain.ExecError(`已平 ${closed.map((x) => `#${x}`).join('、')}；平 #${tokenId} 失败：${error.message}。剩余头寸未平，已平头寸收回的币未卖出、未换币，留在 Safe`, { signed: true, code: error.code });
        }
        closed.push(String(tokenId));
      }
      result.closed = closed;
    }
    // 池子本身含 AERO 时不卖：收回的 AERO 是本金，卖掉再换回来白付两次滑点。
    const holdsReward = [pool.token0, pool.token1].some((t) => t.toLowerCase() === chain.REWARD_TOKEN.toLowerCase());
    result.sold = holdsReward ? null : await sellAfter();
    if (!route) return result;
    h.step('换币');
    const symbol = (t) => ctx.tokens.get(t)?.symbol ?? t;
    const what = `${symbol(route.tokenIn)} → ${symbol(route.tokenOut)}`;
    const after = (await chain.safeBalances(ctx, [route.tokenIn]))[0];
    const gained = after > before ? after - before : 0n;
    const remaining = await chain.remainingAllowance(ctx, route.tokenIn);
    const amountIn = gained < remaining ? gained : remaining;
    const exit = { tokenIn: route.tokenIn, tokenOut: route.tokenOut, gained: String(gained), amountIn: String(amountIn), received: null, left: String(gained - amountIn), reason: null };
    result.exit = exit;
    if (gained === 0n) { exit.reason = `没有新收回的 ${symbol(route.tokenIn)}，无需兑换`; return result; }
    if (amountIn === 0n) { exit.reason = `${symbol(route.tokenIn)} 今日额度已用完，未兑换，收回的币留在 Safe，额度恢复后可手动兑换`; return result; }
    // 兑换签名后（记待确认之后）的任何失败都按已签名处理：确认后读余额失败时兑换其实已上链，不能写成"未兑换"。
    let swapSigned = false;
    const sh = { ...h, persistPending: (entry) => { const saved = h.persistPending(entry); swapSigned = true; return saved; } };
    try {
      const swapped = await chain.swap(ctx, sh, { tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn, slippageBps: params.slippageBps, maxImpactBps: params.maxImpactBps });
      exit.received = String(swapped.received);
    } catch (error) {
      // 兑换已签名而结果未知时照常报错：交给台账与人工核对。没签名的失败（价格冲击、报价、额度）只记原因，撤出已经完成。
      if (swapSigned) throw error.signed === true ? error : new chain.ExecError(`${what} 已签名发送，结果待核对：${error.message}`, { signed: true, code: error.code });
      if (error.signed === true) throw error;
      exit.left = String(gained); exit.amountIn = '0';
      exit.reason = `${what} 未兑换：${error.message}，收回的币留在 Safe`;
      return result;
    }
    if (gained > amountIn) exit.reason = `${symbol(route.tokenIn)} 今日额度只够兑换一部分，其余留在 Safe，额度恢复后可手动兑换`;
    return result;
  }

  // ---- 自动调仓 ----
  // 返回是否写入成功。写不进去时停用：进度与次数统计只在内存里，重启会丢。
  function saveAuto() {
    try { atomicJson(autoPath, autoFile(auto)); autoError = null; return true; } catch (error) {
      log.warn?.({ type: 'aero-safe', err: error }, 'Aero 自动调仓记录写入失败');
      autoError = `自动调仓记录写入失败：${error.code ?? error.message}`;
      if (auto.config.enabled && !auto.halted) auto.halted = { at: now(), reason: autoError };
      return false;
    }
  }
  const mustSaveAuto = (what) => { if (!saveAuto()) throw new chain.ExecError(`${autoError}，${what}`); };
  // 现价须贴近 TWAP 才动手：拒绝在被拉偏的价格上平仓、兑换和定区间。返回现价 tick。
  async function checkTwap(ctx, pool) {
    const t = await chain.poolTwap(ctx, pool, auto.config.twapSeconds);
    if (t.twap === null) throw new chain.ExecError(`${t.reason}，未调仓`, { code: 'twap' });
    const off = deviationBps(t.tick, t.twap);
    if (off > auto.config.maxTwapDeviationBps) throw new chain.ExecError(`现价偏离 ${auto.config.twapSeconds / 60} 分钟 TWAP ${off / 100}%（上限 ${auto.config.maxTwapDeviationBps / 100}%），本轮不调仓`, { code: 'twap' });
    return t.tick;
  }
  // 单池上限：按最新链上状态（平仓收回的币已回到 Safe，总资产基本不变）与行情价算出本池还能放多少，把重开数量等比缩进去，余下的留在 Safe。
  // 没设上限时返回 null。缺价、价格过期或读链失败时下一轮重试（code 'cap'），本池其他头寸已占满上限时停用等人工处理。
  async function fitPoolCap(ctx, h, pool, amounts, closed) {
    const { capUsd } = policyOf(policy, pool.address);
    if (capUsd === null) return null;
    h.step('核对单池上限');
    let fresh, prices = null;
    try { fresh = serialize(await withBudget(chain.readState(ctx, { knownIds: minted }), REFRESH_BUDGET_MS, '读取链上状态'), ctx); } catch (error) {
      throw new chain.ExecError(`核对单池上限时读取链上状态失败（${error.message}），暂不重开`, { code: 'cap' });
    }
    try { prices = readPrices(); } catch (error) { log.warn?.({ type: 'aero-safe', err: error }, 'Aero 行情价格读取失败'); }
    const room = poolRoom({ chain: fresh, prices, pool: pool.address, capUsd, exclude: closed, now: now() });
    if (room.error) throw new chain.ExecError(`${room.error}，暂不重开`, { code: 'cap' });
    const fit = fitToRoom({ ...amounts, token0: pool.token0, token1: pool.token1, room, valueOf: room.valueOf });
    const short = roomShortText(room, fit.valueUsd);
    if (short) throw new chain.ExecError(`${short}，未重开，收回的币留在 Safe。可调高上限后重新启用，或放弃待重开记录`);
    if (fit.amount0 === 0n && fit.amount1 === 0n) throw new chain.ExecError('按单池上限缩减后数量过小，未重开，收回的币留在 Safe');
    if (fit.capped) h.log({ event: 'auto_pool_capped', pool: pool.address, capUsd, roomUsd: Math.round(room.roomUsd), valueUsd: Math.round(fit.valueUsd) });
    return fit;
  }
  // 调仓：核对 TWAP → 记一次并落盘"平仓中"（计入次数与冷却）→ 平仓 → 按余额变化落盘"待重开" → 卖出本次领到的 AERO 并计入 → 按单池上限缩减 → 再核对 TWAP → 居中重开并质押。
  // 每一步的进度都先落盘：兑换确认后记下兑换后的数量，开仓签名前记下"开仓结果未定"，开出后记下新头寸；重试按进度续做，不重复挪动 Safe 的币。
  async function rebalance(ctx, h, params, sellAfter) {
    const poolOf = (address) => ctx.pools.find((p) => p.address.toLowerCase() === address.toLowerCase());
    const stuck = stuckReason(auto);
    if (stuck) throw new chain.ExecError(stuck);
    if (!auto.reopen && params.kind !== 'rebalance') return { skipped: '没有待重开的记录' };
    // 判定之后、任务启动前仓位策略可能已变：已停止或关闭了自动调仓的池子不平仓也不重开（尚未签名，下一轮按新策略判定）。
    const rule = policyOf(policy, auto.reopen?.pool ?? params.pool);
    if (policy.corrupt || rule.state === 'stopped' || !rule.auto) throw new chain.ExecError(policy.corrupt ?? `本池${rule.state === 'stopped' ? POOL_STATE_LABELS.stopped : '关闭了自动调仓'}，未调仓`, { code: 'policy' });
    if (!auto.reopen) {
      const pool = poolOf(params.pool);
      if (!pool) throw new chain.ExecError('池子不在白名单里');
      h.step('核对 TWAP'); await checkTwap(ctx, pool.address);
      const tokens = [pool.token0, pool.token1, chain.REWARD_TOKEN];
      const [before0, before1, beforeReward] = await chain.safeBalances(ctx, tokens);
      const entry = { at: now(), pool: pool.address, closed: params.tokenId, opened: null, tickLower: null, tickUpper: null };
      const history = auto.history;
      auto.history = [...history, entry].slice(-AUTO_HISTORY_LIMIT);
      auto.closing = { pool: pool.address, tokenId: params.tokenId, cells: params.cells, at: entry.at };
      if (!saveAuto()) { auto.history = history; auto.closing = null; throw new chain.ExecError(`${autoError}，未平仓`); }
      h.step('平仓');
      try {
        await chain.closePosition(ctx, h, { tokenId: BigInt(params.tokenId), slippageBps: config.slippageBps, acceptPenalty: auto.config.acceptPenalty });
      } catch (error) {
        // 一笔都没签名时链上没有变化：撤回这次记录，不计次数与冷却。签过名就保留"平仓中"，等人工核对。
        if (error.signed !== true && job?.signed !== true) { auto.history = history; auto.closing = null; saveAuto(); }
        throw error;
      }
      const [after0, after1, afterReward] = await chain.safeBalances(ctx, tokens);
      const gain = (a, b) => (a > b ? a - b : 0n);
      auto.closing = null;
      auto.reopen = { pool: pool.address, cells: params.cells, amount0: String(gain(after0, before0)), amount1: String(gain(after1, before1)), closed: params.tokenId, at: now(), minted: null, inflight: null };
      mustSaveAuto('已平仓，待重开的数量只在内存里');
      // 池子本身含 AERO 时不卖：收回的 AERO 是要重开的本金。只卖这次平仓领到的 AERO，Safe 原有的不动。
      const holdsReward = [pool.token0, pool.token1].some((t) => t.toLowerCase() === chain.REWARD_TOKEN.toLowerCase());
      const reward = gain(afterReward, beforeReward);
      if (!holdsReward && reward > 0n) {
        let sold = null;
        try { sold = await sellAfter(reward); } catch (error) {
          if (error.signed === true) throw error; // 卖出已签名、结果未定：停用，待重开的数量不含卖出所得
          h.log({ event: 'auto_sell_failed', error: error.message });
        }
        if (sold?.sold) {
          const [sold0, sold1] = await chain.safeBalances(ctx, tokens);
          auto.reopen.amount0 = String(BigInt(auto.reopen.amount0) + gain(sold0, after0));
          auto.reopen.amount1 = String(BigInt(auto.reopen.amount1) + gain(sold1, after1));
          mustSaveAuto('卖出所得只在内存里');
        }
      }
    }
    const target = auto.reopen;
    const pool = poolOf(target.pool);
    if (!pool) throw new chain.ExecError('待重开的池子已不在白名单里');
    let opened, tickLower, tickUpper, capped = false;
    if (target.minted) {
      // 新头寸已开出，上次在质押前停下：只做质押。
      h.step('质押');
      await chain.stakePosition(ctx, h, { tokenId: BigInt(target.minted) });
      opened = target.minted;
    } else {
      let amounts = { amount0: BigInt(target.amount0), amount1: BigInt(target.amount1) };
      if (amounts.amount0 === 0n && amounts.amount1 === 0n) throw new chain.ExecError('平仓没有收回任何代币，未重开');
      // 平仓之后到重开之前，本池可能已被停止或关闭自动调仓：不重开，待重开记录保留（改回后续做）。
      const latest = policyOf(policy, pool.address);
      if (policy.corrupt || latest.state === 'stopped' || !latest.auto) throw new chain.ExecError(policy.corrupt ?? `本池${latest.state === 'stopped' ? POOL_STATE_LABELS.stopped : '关闭了自动调仓'}，未重开，收回的币留在 Safe`, { code: 'policy' });
      const fit = await fitPoolCap(ctx, h, pool, amounts, target.closed);
      if (fit) amounts = { amount0: fit.amount0, amount1: fit.amount1 };
      // 兑换确认后待重开记下的是缩减后的数量，重试时不会再被判为缩减：标记随兑换结果一起落盘并沿用。
      capped = fit?.capped === true || target.capped === true;
      h.step('核对 TWAP');
      const tick = await checkTwap(ctx, pool.address);
      [tickLower, tickUpper] = centeredRange(tick, pool.tickSpacing, target.cells);
      h.step('重开');
      let stage = null;
      const rh = {
        ...h,
        moving: (next) => { stage = next; },
        // 兑换或开仓签名后、广播前先记下"结果未定"；写不进去就不广播。
        persistPending: (entry) => {
          if (stage) { target.inflight = stage; stage = null; if (!saveAuto()) { target.inflight = null; throw new Error(autoError); } }
          // 待确认记录写不进去时交易不会广播：撤回"结果未定"，免得误判为已签名。
          try { return h.persistPending(entry); } catch (error) { if (target.inflight) { target.inflight = null; saveAuto(); } throw error; }
        },
        swapped: ({ amount0, amount1 }) => { Object.assign(target, { amount0: String(amount0), amount1: String(amount1), inflight: null, ...(capped ? { capped: true } : {}) }); saveAuto(); },
        minted: (tokenId) => {
          h.minted(tokenId);
          Object.assign(target, { minted: String(tokenId), inflight: null });
          const entry = [...auto.history].reverse().find((x) => x.closed === target.closed);
          if (entry) Object.assign(entry, { opened: String(tokenId), tickLower, tickUpper, ...(capped ? { capped: true } : {}) });
          saveAuto();
        },
      };
      const result = await chain.openPosition(ctx, rh, { pool: pool.address, tickLower, tickUpper, amounts, shareBps: 10_000, rebalance: true, slippageBps: config.slippageBps, stake: true });
      opened = result.tokenId == null ? null : String(result.tokenId);
    }
    auto.reopen = null;
    const last = [...auto.history].reverse().find((x) => x.closed === target.closed);
    if (last) last.opened = opened;
    saveAuto();
    const done = { closed: target.closed, opened, tickLower: last?.tickLower ?? tickLower ?? null, tickUpper: last?.tickUpper ?? tickUpper ?? null, capped: last?.capped === true || capped };
    record({ event: 'auto_rebalanced', ...done });
    return done;
  }
  function startJob(action, parsed) {
    job = { id: randomUUID(), action, label: actionLabels[action], params: jsonable(parsed), status: 'running', step: null, signed: false, startedAt: now(), finishedAt: null, error: null, result: null };
    record({ event: 'job_started', job: job.id, action });
    void run(action, parsed);
  }
  // 每 30 秒一轮：读链 → 判定 → 需要时启动调仓任务。手动任务、未结清交易、维护与隔离恢复期间不动。
  async function autoTick() {
    if (autoBusy || closed || !auto.config.enabled || auto.halted || stuckReason(auto)) return;
    autoBusy = true;
    try {
      autoCheckedAt = now();
      if (!config || !wallet) { autoNote = '请先保存 Safe 配置并填写 bot 私钥'; return; }
      const hold = holdReason();
      if (hold) { autoNote = hold; return; }
      if (job?.status === 'running') return;
      await refresh(); // 也会结清上一笔已签名交易
      if (pending) { autoNote = `等待上一笔交易（${pending.label}）结清`; return; }
      if (!snapshot || snapshotError) { autoNote = `链上读取失败：${snapshotError ?? '尚无数据'}`; return; }
      let prices = null;
      try { prices = readPrices(); } catch (error) { log.warn?.({ type: 'aero-safe', err: error }, 'Aero 行情价格读取失败'); }
      const result = evaluateAuto({ config: auto.config, policy, chain: snapshot, outSince, history: auto.history, reopen: auto.reopen, closing: auto.closing, prices, now: now() });
      outSince = result.outSince; autoWatch = result.watch; autoNote = result.note;
      if (!result.due) return;
      const ctx = await connection();
      // 先核对 TWAP 再启动任务：偏离时不留下失败任务，也不计次数。
      try { await checkTwap(ctx, result.due.pool); } catch (error) { if (error instanceof chain.ExecError && error.code === 'twap') { autoNote = error.message; return; } throw error; }
      await serial(async () => {
        if (closed || !auto.config.enabled || auto.halted || holdReason() || job?.status === 'running' || pending) return;
        startJob('rebalance', result.due);
      });
    } catch (error) {
      autoNote = `自动调仓检查失败：${error.message}`;
    } finally { autoBusy = false; }
  }

  function saveMinted() {
    try { atomicJson(mintedPath, { schema: 1, ids: minted }); } catch (error) {
      log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘头寸记录写入失败');
      record({ event: 'minted_write_failed', error: error.code ?? error.message });
    }
  }
  function remember(tokenId) {
    if (tokenId == null) return;
    minted = [String(tokenId), ...minted.filter((id) => id !== String(tokenId))].slice(0, MINTED_LIMIT);
    saveMinted();
  }
  function forget(ids) {
    const next = minted.filter((id) => !ids.includes(id));
    if (next.length !== minted.length) { minted = next; saveMinted(); }
  }

  function requireIdle(what) {
    if (job?.status === 'running') throw new HttpError(409, `${actionLabels[job.action]}正在执行，${what}`);
  }

  return {
    state,
    async initialize() {
      if (initialized) return;
      initialized = true;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { const saved = readBounded(configPath, 256 * 1024); config = saved && strictAeroSafeConfig(saved); } catch (error) { configError = `已保存的配置无效：${error.message}`; config = null; }
      try { wallet = readBounded(walletPath, 16 * 1024)?.address ?? null; } catch { wallet = null; }
      // 待变更可随时重新加入：读不出或不完整时当作没有。上一版的单个加池计划转成待变更后删除。
      try { const saved = readBounded(changesPath, 512 * 1024); if (saved) changes = readChanges(saved); } catch (error) {
        changes = EMPTY_CHANGES; log.warn?.({ type: 'aero-safe', err: error }, 'Aero 白名单待变更无法读取，已忽略');
      }
      try {
        const old = readBounded(poolPlanPath, 256 * 1024);
        if (old) {
          if (!changes.pools.length && !changes.allowances.length && !changes.batch) saveChanges(migratePoolPlan(old));
          rmSync(poolPlanPath, { force: true });
        }
      } catch (error) { log.warn?.({ type: 'aero-safe', err: error }, 'Aero 旧加池计划无法转换，已忽略'); }
      settleChanges({ recognizeApplied: true });
      try { const ids = readBounded(mintedPath, 64 * 1024)?.ids; minted = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && /^\d{1,78}$/.test(id)).slice(0, MINTED_LIMIT) : []; } catch { minted = []; }
      try { pending = readBounded(pendingPath, 64 * 1024); } catch (error) {
        // 待确认记录损坏时不能当作没有：保留文件，禁止新操作，等人工核对。
        pending = { hash: 'unreadable', nonce: -1, label: '待确认记录损坏', at: 0, unreadable: true };
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘待确认记录无法读取');
      }
      try { const saved = readBounded(autoPath, 64 * 1024); if (saved) auto = readAutoState(saved); } catch (error) {
        // 记录损坏时不能当作没有：可能有平仓后待重开的币。停用并保留文件，等人工核对。
        auto = { config: { ...AUTO_DEFAULTS }, history: [], halted: { at: now(), reason: `自动调仓记录 aero-safe/auto.json 无法读取（${error.message}），请核对 Safe 头寸后删除该文件` }, reopen: null, closing: null };
        autoError = autoCorrupt = auto.halted.reason;
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 自动调仓记录无法读取');
      }
      // 仓位策略读不出时不能当作"不限"：所有池子不能加仓、自动调仓不动，等人工核对文件。
      try { const saved = readBounded(policyPath, 64 * 1024); if (saved) policy = readPolicy(saved); } catch (error) {
        policy = { pools: {}, corrupt: `仓位策略 aero-safe/policy.json 无法读取（${error.message}），开仓、加仓与自动调仓暂停；请核对或删除该文件后重启` };
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 仓位策略无法读取');
      }
      // 旧版按总资产比例的单池上限不再生效：启用中的自动调仓先停用，等在「仓位」按池子设好美元上限再启用，免得悄悄变成不限。
      if (auto.legacyCaps) {
        delete auto.legacyCaps;
        if (auto.config.enabled && !auto.halted && !autoCorrupt) {
          auto.halted = { at: now(), reason: '单池上限已改为在「仓位」按池子设置美元上限，原按总资产比例的上限不再生效；请设置后重新启用自动调仓' };
          record({ event: 'auto_halted', error: auto.halted.reason });
        }
        saveAuto();
      }
      // 上次在平仓中或兑换/开仓结果未定时退出（停机、崩溃）：停用并写明要核对什么。
      const stuck = stuckReason(auto);
      if (stuck && !autoCorrupt && !auto.halted) { auto.halted = { at: now(), reason: stuck }; saveAuto(); record({ event: 'auto_halted', error: stuck }); }
      autoTimer = setInterval(() => { void autoTick(); }, AUTO_TICK_MS); autoTimer.unref?.();
      if (config) void refresh();
    },
    // 保存自动调仓设置；重新启用会清除停用原因，若有待重开的币，下一轮先重开。
    setAuto: (value, authorize = () => {}) => serial(() => {
      authorize();
      if (autoCorrupt) throw new HttpError(409, autoCorrupt);
      const next = strictAutoConfig(value);
      const stuck = stuckReason(auto);
      if (next.enabled && stuck) throw new HttpError(409, stuck);
      const previous = auto;
      auto = { ...auto, config: next, halted: next.enabled ? null : auto.halted };
      try { atomicJson(autoPath, autoFile(auto)); autoError = null; } catch (error) {
        auto = previous;
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 自动调仓设置保存失败');
        throw new HttpError(500, '自动调仓设置保存失败，请检查数据目录权限后重试');
      }
      if (!next.enabled) { outSince = new Map(); autoWatch = []; autoNote = null; }
      record({ event: next.enabled ? 'auto_enabled' : 'auto_disabled' });
      if (next.enabled) setTimeout(() => { void autoTick(); }, 0).unref?.();
      return state();
    }),
    // 保存一个池子的仓位策略 { pool, state, capUsd, auto }：立即生效，不需要 Safe 签名。
    // 不等进行中的任务：任务在开仓、重开前按最新策略再核对；已签名的步骤不受影响。
    setPolicy: (value, authorize = () => {}) => serial(() => {
      authorize();
      if (policy.corrupt) throw new HttpError(409, policy.corrupt);
      const entry = strictPoolPolicy(value);
      const next = withPoolPolicy(policy, entry);
      try { atomicJson(policyPath, { schema: 1, pools: next.pools }); } catch (error) {
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 仓位策略保存失败');
        throw new HttpError(500, '仓位策略保存失败，请检查数据目录权限后重试');
      }
      policy = next;
      record({ event: 'pool_policy', pool: entry.pool, state: entry.state, capUsd: entry.capUsd, auto: entry.auto });
      return state();
    }),
    // 放弃进行中调仓的记录（平仓中断、待重开）：人工核对 Safe 后使用，之后自动调仓不再续做这一次。
    discardAuto: (authorize = () => {}) => serial(() => {
      authorize();
      if (autoCorrupt) throw new HttpError(409, autoCorrupt);
      requireIdle('请等它结束');
      if (!auto.closing && !auto.reopen) throw new HttpError(409, '没有进行中的调仓记录');
      if (pending) throw new HttpError(409, `上一笔交易（${pending.label}）尚未结清，结清后再核对并放弃`);
      const previous = auto;
      const dropped = auto.closing ? { closing: auto.closing } : { reopen: auto.reopen };
      auto = { ...auto, closing: null, reopen: null };
      try { atomicJson(autoPath, autoFile(auto)); autoError = null; } catch (error) {
        auto = previous;
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 自动调仓记录保存失败');
        throw new HttpError(500, '自动调仓记录保存失败，请检查数据目录权限后重试');
      }
      record({ event: 'auto_discarded', ...dropped });
      return state();
    }),
    refresh: (authorize = () => {}) => { authorize(); if (!config) throw new HttpError(409, '请先保存 Safe 配置'); if (!refreshing && snapshotAt && now() - snapshotAt < REFRESH_MIN_MS) return state(); void refresh(); return state(); },
    save: (value, authorize = () => {}) => serial(() => {
      authorize();
      requireIdle('不能修改配置');
      if (pending) throw new HttpError(409, '有已签名交易尚未结清，暂不能修改配置');
      const next = strictAeroSafeConfig(value);
      atomicJson(configPath, next); config = next; configGeneration += 1; configError = null; context = null; snapshot = null; snapshotAt = null; snapshotError = null;
      settleChanges();
      void refresh();
      return state();
    }),
    // 加入待加池：链上核验池子，记下它与新代币的每日额度。不改配置、不签名；多个池子可并行等待同一份 Safe 批次。
    // allowances 为 { 代币地址: 十进制数量（代币单位）}：尚无额度的新代币必填，也可顺带改这两个代币的已有额度。
    // 链上核验在串行队列外等待，不挡自动调仓；回到队列后按配置代际与当前待变更重新检查再写入。
    // 从开始处理起整体（两次排队与读链）不超过 changeBudgetMs，超时返回 504，之后轮到的回调不再写入。
    // deadline：API 转发带来的请求截止时间（毫秒时间戳），没有时只按 changeBudgetMs。
    addPoolChange: async (input, authorize = () => {}, { deadline } = {}) => {
      const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const budget = changeBudget('加池', '未加入待加池', deadline);
      const { poolAddress, generation, cfg } = await budget.queued(() => {
        authorize();
        requireChangesConfig();
        const poolAddress = address(body.pool, '池子地址');
        if (changes.pools.some((p) => sameAddress(p.address, poolAddress))) throw new HttpError(409, '这个池子已在待加池里');
        return { poolAddress, generation: configGeneration, cfg: config };
      });
      const info = await inspect(poolAddress, cfg, budget);
      return budget.queued(() => {
        authorize();
        requireChangesConfig();
        if (configGeneration !== generation) throw new HttpError(409, 'Safe 配置在核验池子期间已变化，请重新加入');
        if (changes.pools.some((p) => sameAddress(p.address, poolAddress))) throw new HttpError(409, '这个池子已在待加池里');
        if (listed(config.permissions, info)) throw new HttpError(409, '这个池子已在白名单里');
        if (changes.pools.some((p) => listed({ pools: [{ ...p, token0: p.token0.address, token1: p.token1.address }] }, info))) throw new HttpError(409, '同一代币对与 tickSpacing 的池子已在待加池里');
        const given = body.allowances && typeof body.allowances === 'object' && !Array.isArray(body.allowances) ? body.allowances : {};
        const tokens = [info.token0, info.token1];
        for (const key of Object.keys(given)) {
          let token;
          try { token = getAddress(key); } catch { throw new HttpError(400, '额度代币地址无效'); }
          if (!tokens.some((t) => t.address === token)) throw new HttpError(400, `代币 ${token} 不属于这个池子`);
        }
        const known = (token) => config.permissions.allowances.some((a) => sameAddress(a.token, token)) || changes.allowances.some((a) => sameAddress(a.token, token));
        const set = [];
        for (const t of tokens) {
          const value = Object.entries(given).find(([key]) => getAddress(key) === t.address)?.[1];
          if (value == null && known(t.address)) continue;
          set.push({ token: t.address, symbol: t.symbol, decimals: t.decimals, perDay: allowanceUnits(value, t.symbol, t.decimals) });
        }
        const name = `${info.token0.symbol}/${info.token1.symbol} ts${info.tickSpacing}`;
        const pool = { address: info.address, name, gauge: info.gauge, tickSpacing: info.tickSpacing, token0: changeToken(info.token0), token1: changeToken(info.token1), addedAt: now(), gaugeStatus: gaugeStatusOf(info.gaugeStatus) };
        const allowances = [...changes.allowances.filter((a) => !set.some((x) => sameAddress(x.token, a.token))), ...set];
        acceptChanges(normalizeChanges(config.permissions, { ...changes, pools: [...changes.pools, pool], allowances }));
        record({ event: 'pool_queued', pool: name, gauge: pool.gaugeStatus.state });
        return state();
      });
    },
    // 设定每日额度：{ 代币地址: 十进制数量 | null }。null 撤回对已有额度的调整；待加池新代币的额度只能改不能撤。
    setAllowanceChanges: (input, authorize = () => {}) => serial(() => {
      authorize();
      requireChangesConfig();
      const given = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
      if (!given || !Object.keys(given).length) throw new HttpError(400, '请填写要调整的额度');
      let allowances = [...changes.allowances];
      for (const [key, value] of Object.entries(given)) {
        let token;
        try { token = getAddress(key); } catch { throw new HttpError(400, '额度代币地址无效'); }
        const configured = config.permissions.allowances.find((a) => sameAddress(a.token, token));
        const queued = changes.pools.flatMap((p) => [p.token0, p.token1]).find((t) => t.address === token);
        if (!configured && !queued) throw new HttpError(400, `代币 ${token} 不在白名单额度里`);
        if (value === null) {
          if (!configured) throw new HttpError(400, `${queued.symbol} 是待加池的新代币，须有额度；不需要时请移出对应的待加池`);
          allowances = allowances.filter((a) => !sameAddress(a.token, token));
          continue;
        }
        const decimals = queued?.decimals ?? snapshot?.tokens?.find((t) => sameAddress(t.address, token))?.decimals;
        if (decimals == null) throw new HttpError(409, '代币精度尚未读取，请先刷新链上状态');
        const symbol = configured?.symbol ?? queued.symbol;
        allowances = [...allowances.filter((a) => !sameAddress(a.token, token)), { token, symbol, decimals, perDay: allowanceUnits(value, symbol, decimals) }];
      }
      acceptChanges(normalizeChanges(config.permissions, { ...changes, allowances }));
      record({ event: 'allowance_queued', tokens: Object.keys(given).length });
      return state();
    }),
    // 移出一个待加池（{ pool }）；它独有的新代币额度一并移除。
    removePoolChange: (input, authorize = () => {}) => serial(() => {
      authorize();
      requireChangesConfig();
      const poolAddress = address(input?.pool, '池子地址');
      if (!changes.pools.some((p) => sameAddress(p.address, poolAddress))) throw new HttpError(404, '这个池子不在待加池里');
      saveChanges(normalizeChanges(config.permissions, { ...changes, pools: changes.pools.filter((p) => !sameAddress(p.address, poolAddress)) }));
      return state();
    }),
    // 生成 Safe 批次（Transaction Builder JSON）：配置 → 全部待变更的增量，冻结下来供执行后核对。不改配置、不签名。
    // 要 setAllowance 的额度先在串行队列外读链上当前额度（读不到即拒绝生成，不按满额猜），按本期已用折算新余额；
    // 回到队列后确认配置代际与待变更都没变才冻结。从开始处理起整体（两次排队与读链）不超过 changeBudgetMs，
    // 须短于 API 转发时限（60 秒）；超时即返回 504，排在队列里的回调之后轮到时也不再冻结。
    buildChangeBatch: async (authorize = () => {}, { deadline } = {}) => {
      const budget = changeBudget('生成批次', '未生成批次', deadline);
      const plan = await budget.queued(() => {
        authorize();
        requireChangesConfig();
        const next = changesNext();
        if (next.error) throw new HttpError(/^白名单已满/.test(next.error) ? 409 : 400, next.error);
        if (!next.permissions || !next.size) throw new HttpError(409, '没有待变更');
        const keys = allowanceChanges({ current: buildPermissions(config.permissions), next: buildPermissions(next.permissions) }).map((c) => c.allowance.key);
        return { key: next.key, generation: configGeneration, cfg: config, keys };
      });
      let allowanceState = null;
      if (plan.keys.length) {
        try { allowanceState = await budget.read(() => chain.readAllowances(makeProvider(plan.cfg.rpcUrl), plan.cfg.roles, plan.keys), '读取链上额度'); } catch (error) {
          if (error instanceof HttpError) throw error.status === 504 ? error : new HttpError(error.status, `${error.message}；未生成批次`);
          throw new HttpError(502, `读取链上额度失败，未生成批次：${error.message}`);
        }
      }
      return budget.queued(() => {
        authorize();
        requireChangesConfig();
        const next = changesNext();
        if (configGeneration !== plan.generation || next.key !== plan.key) throw new HttpError(409, 'Safe 配置或待变更在读取链上额度期间已变化，请重新生成');
        let transactions;
        try { transactions = buildUpdateBatch({ current: buildPermissions(config.permissions), next: buildPermissions(next.permissions), roles: config.roles, allowanceState }); } catch (error) {
          throw new HttpError(error.code === 'period_ending' ? 409 : 400, `生成批次失败：${error.message}`);
        }
        const createdAt = now();
        const executeBefore = batchExecuteBefore(transactions);
        const label = (a) => ({ symbol: a.symbol, perDay: a.perDay, decimals: a.decimals });
        const batch = { createdAt, baseline: JSON.stringify(config.permissions), target: batchTarget(config), permissions: next.permissions, transactions: transactions.length,
          executeBefore: executeBefore === null ? null : executeBefore * 1000,
          pools: changes.pools.map((p) => p.name), allowances: changes.allowances.map((a) => ({ token: a.token, ...label(a) })) };
        saveChanges({ ...changes, batch });
        const names = batch.pools.length ? batch.pools.join('、') : '调整额度';
        // 额度那几笔的执行效果：本期已用、执行后本期剩余，以及重复执行或执行前 bot 再消耗时每次最多可再花的数量（单列给界面）。
        const decimalsOf = (token) => changes.allowances.find((a) => sameAddress(a.token, token))?.decimals ?? null;
        const allowances = transactions.filter((t) => t.allowance).map((t) => ({ ...t.allowance, decimals: decimalsOf(t.allowance.token) }));
        record({ event: 'changes_batched', pools: batch.pools, allowances: batch.allowances.length, transactions: batch.transactions });
        const deadlineNote = executeBefore === null ? '' : `。须在 ${utc(executeBefore)} 前执行；过了期限不要再执行，请重新生成（到本期补满时刻后才执行，执行当期额度补满、执行前已花的不计入）`;
        const replayNote = allowances.length ? `。额度按生成时链上读数折算；同一批次重复执行或执行前 bot 再消耗时，本期累计可超过新额度：${allowances.map((a) => `${a.symbol} 每次执行最多再花 ${a.replay.samePeriod}，之后周期执行当期计满 ${a.replay.laterPeriod}`).join('；')}（最小单位）` : '';
        const builder = toTransactionBuilderJson({ safe: config.safe, transactions, createdAt, name: `Aero 白名单变更 ${names}`.slice(0, 120),
          description: `Roles ${config.roles}：${[batch.pools.length ? `增加池子 ${batch.pools.join('、')}` : '', batch.allowances.length ? `调整 ${batch.allowances.map((a) => a.symbol).join('、')} 每日额度` : ''].filter(Boolean).join('；')}${deadlineNote}${replayNote}` });
        return { transactions: transactions.map((t) => ({ to: t.to, description: t.description })), allowances, executeBefore: batch.executeBefore, builder, usage: next.usage, state: state() };
      });
    },
    // 硬件钱包在 Safe{Wallet} 执行批次后：以 bot 身份模拟核对批次里的权限全部已在链上生效，再并入配置。批次之后新加的变更继续保留。
    // 模拟核对在串行队列外等待，不挡自动调仓。核对进行中再次请求会被拒绝；但读链超时后核对标记即释放，
    // 重试可能与上一次未结束、结果已丢弃的只读核对并行，同一时间仍只有一次能写入配置。回到队列后重新检查登录、维护、
    // 任务与未结清交易，并确认配置代际、批次与 bot 都没变，才写入配置。
    // 从开始处理起整体（两次排队与模拟核对）不超过 changeBudgetMs，超时返回 504，之后轮到的回调不再写入配置。
    applyChangeBatch: async (authorize = () => {}, { deadline } = {}) => {
      const budget = changeBudget('核对启用', '未启用批次', deadline);
      const ready = () => {
        authorize();
        requireIdle('不能修改配置');
        const hold = holdReason();
        if (hold) throw new HttpError(503, hold);
        if (pending) throw new HttpError(409, '有已签名交易尚未结清，暂不能修改配置');
        const batch = changes.batch;
        if (!batch) throw new HttpError(409, '还没有生成 Safe 批次');
        const stale = staleReason(batch);
        if (stale) throw new HttpError(409, stale);
        if (!wallet) throw new HttpError(409, '请先填写 bot 私钥：生效核对以 bot 身份模拟');
        return batch;
      };
      // 只有本次请求占用了核对标记才在结束时清除，排队超时被放弃的请求不能清掉别人正在进行的核对。
      let claimed = false;
      try {
        const plan = await budget.queued(() => {
          if (verifyingBatch) throw new HttpError(409, '正在核对链上权限，请等这一次结束');
          const batch = ready();
          verifyingBatch = claimed = true;
          return { batch, generation: configGeneration, cfg: config, bot: wallet };
        });
        const { batch, cfg, bot } = plan;
        let result;
        try {
          result = await budget.read(() => chain.verifyActive({ rpc: makeProvider(cfg.rpcUrl), safe: cfg.safe, roles: cfg.roles, bot,
            current: buildPermissions(cfg.permissions), next: buildPermissions(batch.permissions), now }), '核对链上权限');
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, `核对链上权限失败：${error.message}`);
        }
        if (!result.ok) {
          const failed = result.checks.filter((c) => !c.ok);
          throw new HttpError(409, `批次尚未在链上生效（${failed.length}/${result.checks.length} 项未通过）：${failed.slice(0, 3).map((c) => `${c.label} ${c.status}`).join('；')}。请确认 Safe 已执行完整批次后再试`);
        }
        return await budget.queued(() => {
          if (ready() !== batch || configGeneration !== plan.generation || wallet !== bot) throw new HttpError(409, 'Safe 配置、批次或 bot 在核对期间已变化，请重新核对');
          const next = strictAeroSafeConfig({ ...config, permissions: batch.permissions });
          atomicJson(configPath, next);
          config = next; configGeneration += 1; configError = null; context = null; snapshot = null; snapshotAt = null; snapshotError = null;
          // 配置已是提交点：待变更写不进去时页面报告，重启后 settleChanges 按配置认出这份已启用的批次，不要求重新签名。
          keepChanges(normalizeChanges(config.permissions, { ...changes, batch: null }),
            '批次已核对启用并写入配置，但待变更文件 aero-safe/changes.json 写入失败；重启后会按配置认出这份已启用的批次，不需要重新签名。请检查数据目录权限');
          record({ event: 'changes_applied', pools: batch.pools, allowances: batch.allowances.length, checks: result.checks.length });
          void refresh();
          return state();
        });
      } finally { if (claimed) verifyingBatch = false; }
    },
    // 放弃全部待变更与已生成的批次（批次如已在 Safe 执行，链上权限不会因此撤回）。
    clearChanges: (authorize = () => {}) => serial(() => {
      authorize();
      saveChanges({ ...EMPTY_CHANGES });
      return state();
    }),
    setKey: (privateKey, authorize = () => {}) => serial(() => {
      authorize();
      if (typeof privateKey !== 'string' || !PRIVATE_KEY_PATTERN.test(privateKey.trim())) throw new HttpError(400, '私钥须为 64 位十六进制字符（可带 0x 前缀）');
      requireIdle('不能更换 bot 私钥');
      if (pending) throw new HttpError(409, '有已签名交易尚未结清，暂不能更换 bot 私钥');
      const key = privateKey.trim();
      const next = new Wallet(key).address;
      try { atomicJson(walletPath, { schema: 1, address: next, key: encrypt(key) }); } catch (error) {
        try { rmSync(`${walletPath}.tmp`, { force: true }); } catch {}
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘钱包保存失败');
        throw new HttpError(500, 'bot 私钥保存失败，原私钥未更换，请检查数据目录权限后重试');
      }
      wallet = next; context = null;
      if (config) void refresh();
      return state();
    }),
    clearKey: (authorize = () => {}) => serial(() => {
      authorize();
      requireIdle('不能清除 bot 私钥');
      if (pending) throw new HttpError(409, '有已签名交易尚未结清，暂不能清除 bot 私钥');
      try { rmSync(walletPath, { force: true }); } catch (error) {
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘钱包清除失败');
        throw new HttpError(500, 'bot 私钥清除失败，请检查数据目录权限后重试');
      }
      wallet = null; context = null; return state();
    }),
    preview: (params, authorize = () => {}) => serial(async () => {
      authorize();
      const parsed = parseParams('open', params, config ?? DEFAULTS, null);
      let ctx;
      try { ctx = await connection(); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, `连接链上失败：${error.message}`); }
      try {
        const { cap, limit } = await openLimit(ctx, parsed.pool, parsed.cap);
        return jsonable({ ...(await chain.previewOpen(ctx, { ...parsed, cap })), capUsd: cap?.usd ?? null, limit, previewedAt: now() });
      } catch (error) {
        if (error instanceof chain.ExecError) throw new HttpError(400, error.message);
        throw new HttpError(502, `预览失败：${error.message}`);
      }
    }),
    // 启动任务后立即返回；页面轮询 state().job。
    execute: (action, params, authorize = () => {}) => serial(async () => {
      authorize();
      if (!ACTIONS.has(action)) throw new HttpError(404, '未知操作');
      if (!config) throw new HttpError(409, '请先保存 Safe 配置');
      if (!wallet) throw new HttpError(409, '请先填写 bot 私钥');
      const hold = holdReason();
      if (hold) throw new HttpError(503, hold);
      requireIdle('请等它结束');
      if (pending?.unreadable) throw new HttpError(409, '待确认交易记录损坏，请核对 bot 地址的链上交易后删除 aero-safe/pending.json');
      let ctx;
      try { ctx = await connection(); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, `连接链上失败：${error.message}`); }
      const parsed = parseParams(action, params, config, ctx.tokens, now(), action === 'open');
      if (pending) {
        let status;
        try { status = await resolve(ctx); } catch (error) { throw new HttpError(502, `核对上一笔交易失败：${error.message}`); }
        if (status === 'waiting' && ledgerError) throw new HttpError(409, ledgerError);
        if (status === 'waiting' && now() - pending.at < PENDING_STALE_MS) throw new HttpError(409, `上一笔交易（${pending.label}）仍在等待上链，请稍后再试`);
      }
      startJob(action, parsed);
      return state();
    }),
    // 更新停机前：维护标记已让任务在下一次签名前停下；只有已签名、回执未到时拒绝停机。
    async prepareStop() {
      // 调仓任务在平仓与落盘待重开之间也没有待确认交易，停机会丢进度：等它在下一次签名前因维护停下。
      if (job?.status === 'running' && job.action === 'rebalance') throw new HttpError(409, 'Aero 自动调仓正在执行，尚未满足安全停机条件，请稍后重试');
      if (job?.status === 'running' && pending) throw new HttpError(409, 'Aero 实盘正在等待链上交易回执，尚未满足安全停机条件，请稍后重试');
    },
    async close() {
      closed = true;
      clearInterval(autoTimer);
      await operation;
      try { await refreshing; } catch {}
    },
    // 立即跑一轮自动调仓检查（测试与启用后使用；平时由定时器每 30 秒调用）。
    tickAuto: () => autoTick(),
    get directory() { return directory; },
  };
}
