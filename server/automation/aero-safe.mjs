// Aero 市场实盘（Safe + Zodiac Roles）：手动执行。页面发起操作，bot 私钥经 Roles 以 Safe 名义签名发送。
// 资产与头寸都在 Safe，bot 只付 gas；链上 Roles 是权限的最终判定，tools/aero-roles/policy.mjs 的本地校验是第二道防线。
// 一次只运行一个任务；每笔交易签名后先持久化 pending.json 再广播，重启后按哈希与 nonce 结清，不会重复执行。
import { appendFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Wallet, getAddress, parseUnits } from 'ethers';
import { buildPermissions } from '../../tools/aero-roles/permissions.mjs';
import * as executor from '../../tools/aero-roles/executor.mjs';
import { atomicJson } from '../../tools/entropy-lighter-lab/core.mjs';
import { HttpError } from '../http-common.mjs';

const PRIVATE_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;
const EVENT_LIMIT = 50;
const LEDGER_TAIL_BYTES = 256 * 1024;
const LEDGER_SHOWN = 30;
const CONTEXT_TTL_MS = 10 * 60_000;
const REFRESH_MIN_MS = 5_000;
const REFRESH_BUDGET_MS = 60_000;
// 已签名未上链超过这个时长后，允许新操作用同一 nonce 提价替换（两笔最多只有一笔上链）。
export const PENDING_STALE_MS = 10 * 60_000;
// 开仓确认基于预览数字：预览超过这个时长后须重新预览。
export const PREVIEW_TTL_MS = 2 * 60_000;
const DEFAULTS = Object.freeze({ rpcUrl: 'https://mainnet.base.org', slippageBps: 50, autoSellRewards: true, minRewardSell: '1' });
const ACTIONS = new Set(['open', 'close', 'stake', 'unstake', 'claim', 'sell', 'swap']);
const actionLabels = { open: '开仓', close: '平仓', stake: '质押', unstake: '解押', claim: '领取排放', sell: '卖出 AERO', swap: '兑换' };

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
    blockNumber: chain.blockNumber, timestamp: chain.timestamp, bot: chain.bot, botEth: s(chain.botEth), ownedNfts: s(chain.ownedNfts), ownedScanned: chain.ownedScanned ?? null,
    inflight: chain.pendingNonce != null && chain.latestNonce != null && chain.pendingNonce > chain.latestNonce,
    tokens: [...ctx.tokens.values()].map((t) => ({ ...t, balance: s(chain.balances[t.address]) })),
    allowances: chain.allowances.map((a) => ({ token: a.token, symbol: a.symbol, perDay: s(a.perDay), remaining: s(a.remaining), maxRefill: s(a.maxRefill), refillAt: a.refillAt == null ? null : Number(a.refillAt) })),
    pools: chain.pools.map((p) => ({
      name: p.name, address: p.address, gauge: p.gauge, token0: p.token0, token1: p.token1, tickSpacing: p.tickSpacing,
      sqrtPriceX96: s(p.sqrtPriceX96), tick: p.tick, feePips: p.feePips, earned: s(p.earned),
      penalty: { minStakeBlocks: s(p.penalty.minStakeBlocks), penaltyRate: s(p.penalty.penaltyRate) },
      positions: p.positions.map((x) => ({ tokenId: s(x.tokenId), staked: x.staked, tickLower: x.tickLower, tickUpper: x.tickUpper, liquidity: s(x.liquidity),
        amount0: x.amount0, amount1: x.amount1, tokensOwed0: s(x.tokensOwed0), tokensOwed1: s(x.tokensOwed1), depositBlock: s(x.depositBlock), penaltyUntilBlock: s(x.penaltyUntilBlock) })),
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
  return { amount0: rawAmount(e.amount0, '预览投入量'), amount1: rawAmount(e.amount1, '预览投入量'), swapIn: e.swapIn == null ? 0n : rawAmount(e.swapIn, '预览兑换量') };
}

function parseParams(action, params, config, tokens, now = Date.now()) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const slippageBps = p.slippageBps === undefined ? config.slippageBps : integer(p.slippageBps, '滑点（基点）', 1, 500);
  const tokenId = () => { if (typeof p.tokenId !== 'string' || !/^\d{1,78}$/.test(p.tokenId)) throw new HttpError(400, 'tokenId 无效'); return BigInt(p.tokenId); };
  if (action === 'open') {
    return { pool: address(p.pool, '池子地址'), tickLower: integer(p.tickLower, '下沿 tick', -887272, 887272), tickUpper: integer(p.tickUpper, '上沿 tick', -887272, 887272),
      shareBps: integer(p.shareBps ?? 10_000, '投入比例（基点）', 1, 10_000), rebalance: p.rebalance !== false, slippageBps, stake: p.stake !== false,
      ...(tokens ? { expect: parseExpect(p.expect, now) } : {}) };
  }
  if (action === 'close') return { tokenId: tokenId(), slippageBps, acceptPenalty: p.acceptPenalty === true };
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

export function createAeroSafe({ dataDir, encrypt, decrypt, readMaintenance = () => false, readAdmission = () => true, log = console, now = Date.now,
  chain = executor, makeProvider = executor.provider } = {}) {
  const directory = path.join(dataDir, 'aero-safe');
  const configPath = path.join(directory, 'config.json'), walletPath = path.join(directory, 'wallet.json');
  const pendingPath = path.join(directory, 'pending.json'), ledgerPath = path.join(directory, 'txs.jsonl');
  let config = null, configError = null, wallet = null, pending = null, job = null, snapshot = null, snapshotAt = null, snapshotError = null;
  let context = null, refreshing = null, closed = false, initialized = false;
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
      job: job && structuredClone(job), chain: snapshot && structuredClone(snapshot), chainAt: snapshotAt, chainError: snapshotError, refreshing: Boolean(refreshing),
      events: structuredClone(events), ledger: ledger(), serverNow: now(),
    };
  }
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
  function settle(entry, receipt, outcome) {
    const status = outcome ?? (receipt?.status === 1 ? 'confirmed' : 'reverted');
    try {
      appendFileSync(ledgerPath, `${JSON.stringify({ at: now(), hash: entry.hash, nonce: entry.nonce, label: entry.label, status, block: receipt?.blockNumber ?? null,
        gasUsed: receipt?.gasUsed != null ? String(receipt.gasUsed) : null, fee: receipt?.fee != null ? String(receipt.fee) : null })}\n`, { mode: 0o600 });
    } catch (error) {
      // 台账没写上就保留待确认记录：它是这笔交易唯一的持久记录，下次结清时按回执重写。
      log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘交易记录写入失败');
      record({ event: 'ledger_write_failed', label: entry.label, hash: entry.hash, status });
      return;
    }
    // 删除失败时记录留在磁盘，下次结清会按回执再记一次（台账按哈希去重）。
    if (pending?.hash === entry.hash) {
      try { rmSync(pendingPath, { force: true }); pending = null; } catch (error) { log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘待确认记录删除失败'); }
    }
    record({ event: 'tx_settled', label: entry.label, hash: entry.hash, status });
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
    if (result.replacedReceipt && result.replaced) settle({ hash: result.replaced.hash, nonce: current.nonce, label: result.replaced.label }, result.replacedReceipt);
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
      if (replaced) settle(replaced, null, 'replaced');
    },
    settle: (entry, receipt) => settle(entry, receipt),
    log: (entry) => record({ job: jobId, ...entry }),
    step: (name) => { if (job?.id === jobId) job.step = name; },
  });

  async function readChain() {
    const ctx = await connection();
    try { await resolve(ctx); } catch (error) { record({ event: 'pending_check_failed', error: error.message }); }
    const value = await chain.readState(ctx);
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
      const sellAfter = async () => {
        if (!config.autoSellRewards) return null;
        h.step('卖出 AERO');
        const minAmount = parseUnits(config.minRewardSell, ctx.tokens.get(chain.REWARD_TOKEN)?.decimals ?? 18);
        return chain.sellRewards(ctx, h, { slippageBps: params.slippageBps ?? config.slippageBps, minAmount });
      };
      if (action === 'open') result = await chain.openPosition(ctx, h, params);
      else if (action === 'close') { result = await chain.closePosition(ctx, h, params); result.sold = await sellAfter(); }
      else if (action === 'stake') result = await chain.stakePosition(ctx, h, params);
      else if (action === 'unstake') { result = await chain.unstakePosition(ctx, h, params); result.sold = await sellAfter(); }
      else if (action === 'claim') { h.step('领取排放'); result = await chain.claimRewards(ctx, h); result.sold = await sellAfter(); }
      else if (action === 'sell') result = await chain.sellRewards(ctx, h, { slippageBps: params.slippageBps, minAmount: 1n });
      else if (action === 'swap') result = await chain.swap(ctx, h, params);
      Object.assign(job, { status: 'done', finishedAt: now(), result: jsonable(result), step: null });
      record({ event: 'job_done', job: id, action });
    } catch (error) {
      // 前面的步骤已签名上链时，后续步骤失败也不能显示为"未签名"。
      Object.assign(job, { status: 'failed', finishedAt: now(), error: error.message, signed: error.signed === true || job.signed === true, code: error.code ?? null });
      record({ event: 'job_failed', job: id, action, error: error.message });
      if (!(error instanceof chain.ExecError)) log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘操作异常');
    }
    await refresh();
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
      try { pending = readBounded(pendingPath, 64 * 1024); } catch (error) {
        // 待确认记录损坏时不能当作没有：保留文件，禁止新操作，等人工核对。
        pending = { hash: 'unreadable', nonce: -1, label: '待确认记录损坏', at: 0, unreadable: true };
        log.warn?.({ type: 'aero-safe', err: error }, 'Aero 实盘待确认记录无法读取');
      }
      if (config) void refresh();
    },
    refresh: (authorize = () => {}) => { authorize(); if (!config) throw new HttpError(409, '请先保存 Safe 配置'); if (!refreshing && snapshotAt && now() - snapshotAt < REFRESH_MIN_MS) return state(); void refresh(); return state(); },
    save: (value, authorize = () => {}) => serial(() => {
      authorize();
      requireIdle('不能修改配置');
      if (pending) throw new HttpError(409, '有已签名交易尚未结清，暂不能修改配置');
      const next = strictAeroSafeConfig(value);
      atomicJson(configPath, next); config = next; configError = null; context = null; snapshot = null; snapshotAt = null; snapshotError = null;
      void refresh();
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
      try { return jsonable({ ...(await chain.previewOpen(ctx, parsed)), previewedAt: now() }); } catch (error) {
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
      const parsed = parseParams(action, params, config, ctx.tokens, now());
      if (pending) {
        let status;
        try { status = await resolve(ctx); } catch (error) { throw new HttpError(502, `核对上一笔交易失败：${error.message}`); }
        if (status === 'waiting' && now() - pending.at < PENDING_STALE_MS) throw new HttpError(409, `上一笔交易（${pending.label}）仍在等待上链，请稍后再试`);
      }
      job = { id: randomUUID(), action, label: actionLabels[action], params: jsonable(parsed), status: 'running', step: null, signed: false, startedAt: now(), finishedAt: null, error: null, result: null };
      record({ event: 'job_started', job: job.id, action });
      void run(action, parsed);
      return state();
    }),
    // 更新停机前：维护标记已让任务在下一次签名前停下；只有已签名、回执未到时拒绝停机。
    async prepareStop() {
      if (job?.status === 'running' && pending) throw new HttpError(409, 'Aero 实盘正在等待链上交易回执，尚未满足安全停机条件，请稍后重试');
    },
    async close() {
      closed = true;
      await operation;
      try { await refreshing; } catch {}
    },
    get directory() { return directory; },
  };
}
