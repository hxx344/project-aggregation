#!/usr/bin/env node
// Aerodrome Slipstream 单边 token0 流动性调仓：status / once / run。
// run --managed 由工作台运行时托管：私钥经 IPC 传入，每轮重读配置。
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, formatEther, formatUnits, getAddress, parseEther, parseUnits } from 'ethers';
import { CONNECTION_KEYS, PRIVATE_KEY_PATTERN, belowTwap, emissionApr, nearestUsableTick, planCycle, positionAmounts, rangeState, targetRange, tickToPrice, validateSettings } from './core.mjs';
import { connect, errorText, execute, provider, readRewards, readState, reconcileLedger } from './chain.mjs';

const USAGE = 'Usage: lp {status|once|run} [--config FILE] [--dry-run]  |  lp run --managed --config FILE --data DIR';
const KEY_TIMEOUT_MS = 10_000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['status', 'once', 'run'].includes(command)) throw new Error(USAGE);
  const options = { command, dryRun: command === 'status', configPath: join(dirname(fileURLToPath(import.meta.url)), 'config.json') };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') options.dryRun = true;
    else if (rest[i] === '--managed' && command === 'run') options.managed = true;
    else if (rest[i] === '--config' && rest[i + 1]) options.configPath = resolve(rest[++i]);
    else if (rest[i] === '--data' && rest[i + 1]) options.dataDir = resolve(rest[++i]);
    else throw new Error(USAGE);
  }
  if (Boolean(options.managed) !== Boolean(options.dataDir) || (options.managed && options.dryRun)) throw new Error(USAGE);
  return options;
}

const expandHome = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const withAddresses = (c) => ({ ...c, pool: getAddress(c.pool), token: getAddress(c.token), factory: getAddress(c.factory), nft: getAddress(c.nft) });

// 托管模式的配置只含可在页面上修改的参数。
export const loadSettings = (source) => withAddresses(validateSettings(JSON.parse(source)));

export function loadConfig(source) {
  const c = JSON.parse(source);
  const settings = validateSettings(c, { extra: ['keyFile', 'address', 'dataDir'] });
  for (const k of ['keyFile', 'address', 'dataDir']) {
    if (c[k] !== undefined && c[k] !== null && typeof c[k] !== 'string') throw new Error(`config.${k} is invalid: ${JSON.stringify(c[k])}`);
  }
  return {
    ...withAddresses(settings),
    address: c.address ? getAddress(c.address) : null,
    keyFile: c.keyFile ? expandHome(c.keyFile) : null,
    dataDir: expandHome(c.dataDir || '~/.local/share/aero-lp'),
  };
}

// 私钥只从环境变量 AERO_LP_PRIVATE_KEY 或权限为 600 的文件读取，从不打印。
function loadKey(config) {
  if (process.env.AERO_LP_PRIVATE_KEY) return process.env.AERO_LP_PRIVATE_KEY.trim();
  if (!config.keyFile) return null;
  if ((statSync(config.keyFile).mode & 0o077) !== 0) throw new Error(`key file ${config.keyFile} must not be readable by group/others (chmod 600)`);
  return readFileSync(config.keyFile, 'utf8').trim();
}

// 托管模式下事件经 IPC 交给工作台，日志文件超过 2MB 时轮转为 events.1.jsonl。
function logger(dataDir, { managed = false } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'events.jsonl');
  return (entry) => {
    const record = { at: new Date().toISOString(), ...entry };
    const line = JSON.stringify(record);
    if (managed) { if (process.connected) process.send({ type: 'aero-lp-event', entry: record }); }
    else console.log(line);
    try { if (managed && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, join(dataDir, 'events.1.jsonl')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    appendFileSync(file, line + '\n', { mode: 0o600 });
  };
}

// 同一钱包只允许一个进程发交易，否则 nonce 与头寸判断会互相干扰。锁按钱包地址区分，
// 只在同一 dataDir 内有效：多份配置共用私钥时须共用 dataDir。
function acquireLock(dataDir, wallet) {
  const lock = join(dataDir, `run-${wallet.toLowerCase()}.lock`);
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid = null;
    try { pid = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid; } catch {}
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error(`another aero-lp process (pid ${pid}) holds ${lock}`); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    rmSync(lock, { recursive: true });
    mkdirSync(lock, { mode: 0o700 });
  }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  return () => rmSync(lock, { recursive: true, force: true });
}

const round = (v, digits = 6) => (Number.isFinite(v) ? Number(v.toPrecision(digits)) : null);

function ledgerWriter(dataDir) {
  const file = join(dataDir, 'txs.jsonl');
  return (entry) => appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

// 账本补记失败只记日志，不影响本轮调仓；dry-run 不加锁，也不写账本。
async function reconcile(ctx, dataDir, wallet, log, dryRun) {
  if (dryRun) return;
  try { await reconcileLedger(ctx, dataDir, wallet, ledgerWriter(dataDir)); } catch (error) { log({ event: 'ledger_error', error: errorText(error) }); }
}

// 奖励展示数据：池子排放速率由相邻两轮的 rewardGrowthGlobalX128 差值除以池子更新时间差得到，
// 即单位质押流动性每秒分得的奖励；第一轮或池子期间无更新时沿用上一次的速率。
function rewardView(ctx, state, rewards, memory) {
  const previous = memory.sample;
  if (previous && rewards.updatedAt > previous.updatedAt && rewards.growth >= previous.growth) {
    memory.perLiquidity = Number(rewards.growth - previous.growth) / 2 ** 128 / (rewards.updatedAt - previous.updatedAt);
  }
  if (!previous || rewards.updatedAt > previous.updatedAt) memory.sample = { growth: rewards.growth, updatedAt: rewards.updatedAt };
  const perSecond = memory.perLiquidity === undefined ? null : (memory.perLiquidity * Number(rewards.stakedLiquidity)) / 1e18;
  const price = { tick: state.tick, sqrt: state.sqrtPrice };
  const positions = state.positions.map((p) => {
    const { amount0, amount1 } = positionAmounts(p, state.sqrtPrice, ctx.decimals0, ctx.decimals1);
    const value = amount0 * tickToPrice(state.tick, ctx.decimals0, ctx.decimals1) + amount1;
    const apr = p.staked && perSecond !== null ? emissionApr({ rewardPerSecond: perSecond, rewardPrice: rewards.price, stakedLiquidity: rewards.stakedLiquidity, position: p, price, decimals0: ctx.decimals0, decimals1: ctx.decimals1 }) : null;
    return { amount0: round(amount0), amount1: round(amount1), value: round(value), apr: apr && round(apr.apr, 4), aprEstimated: apr?.estimated ?? false };
  });
  return {
    summary: {
      price: rewards.price === null ? null : round(rewards.price),
      poolPerDay: perSecond === null ? null : round(perSecond * 86_400),
      pending: formatUnits(rewards.pending, 18),
      deferred: formatUnits(rewards.deferred, 18),
    },
    positions,
  };
}

async function cycle(ctx, config, wallet, log, { dryRun, dataDir, memory = {}, paused = () => false, onExecute = () => {} }) {
  await reconcile(ctx, dataDir, wallet, log, dryRun);
  const amounts = {
    keepInWallet: parseUnits(config.keepInWallet, ctx.decimals0),
    minDeploy: parseUnits(config.minDeploy, ctx.decimals0),
  };
  const upperTick = nearestUsableTick(config.upperPrice, ctx.decimals0, ctx.decimals1, ctx.spacing);
  const state = await readState(ctx, wallet, config.twapSec);
  const retarget = (currentTick) => (state.twapError || belowTwap(currentTick, state.twapTick, config.maxTwapDeviationBps)
    ? null : targetRange({ currentTick, spacing: ctx.spacing, gapBps: config.gapBps, upperTick }));
  const plan = planCycle({
    currentTick: state.tick, twapTick: state.twapTick, twapUnavailable: Boolean(state.twapError), maxTwapDeviationBps: config.maxTwapDeviationBps, spacing: ctx.spacing, gapBps: config.gapBps, upperTick,
    positions: state.positions, walletToken0: state.walletToken0, ...amounts,
    penalty: state.penalty, blockNumber: state.blockNumber,
  });
  const price = (t) => Number(tickToPrice(t, ctx.decimals0, ctx.decimals1).toPrecision(6));
  let rewards = null, rewardsError = null;
  try {
    const raw = await readRewards(ctx, wallet, state.positions.filter((p) => p.staked).map((p) => p.tokenId));
    rewards = { ...rewardView(ctx, state, raw, memory), raw };
  } catch (error) { rewardsError = errorText(error); }
  log({
    event: 'cycle',
    block: state.blockNumber,
    symbols: [ctx.symbol0, ctx.symbol1],
    price: price(state.tick),
    twapPrice: state.twapTick === null ? null : price(state.twapTick),
    ...(state.twapError && { twapError: state.twapError }),
    target: plan.target && [price(plan.target.tickLower), price(plan.target.tickUpper)],
    positions: state.positions.map((p, i) => ({ id: String(p.tokenId), range: [price(p.tickLower), price(p.tickUpper)], staked: p.staked, liquidity: String(p.liquidity), state: rangeState(p, state.tick), ...rewards?.positions[i] })),
    status: plan.status,
    wallet: {
      [ctx.symbol0]: formatUnits(state.walletToken0, ctx.decimals0), ETH: formatEther(state.walletEth),
      ...(rewards && { AERO: formatUnits(rewards.raw.aero, 18) }), ...(rewards?.raw.xaero != null && { xAERO: formatUnits(rewards.raw.xaero, 18) }),
    },
    rewards: rewards?.summary ?? null,
    ...(rewardsError && { rewardsError }),
    actions: plan.actions.map((a) => a.type + (a.tokenId !== undefined ? `#${a.tokenId}` : '')),
    notes: plan.notes,
  });
  if (plan.actions.length === 0 || dryRun) return;
  if (state.inflight) { log({ event: 'skip', reason: 'wallet has pending transactions; waiting for them to settle' }); return; }
  if (state.walletEth < parseEther(config.minEthForGas)) { log({ event: 'skip', reason: `ETH balance below minEthForGas ${config.minEthForGas}` }); return; }
  if (paused()) { log({ event: 'skip', reason: 'workbench maintenance in progress' }); return; }
  onExecute();
  try { await execute(ctx, log, wallet, plan, { ...amounts, slippageBps: config.slippageBps, retarget }); }
  finally { await reconcile(ctx, dataDir, wallet, log, dryRun); }
}

// 工作台托管：先发 ready，收到 IPC 私钥后开始循环；私钥不落盘、不进环境变量。
// 每轮重读配置，连接类参数变化时重连；reload 立即开始下一轮，stop 或 IPC 断开时等当前轮结束后退出。
async function managed({ configPath, dataDir }) {
  if (typeof process.send !== 'function') throw new Error('--managed requires an IPC channel');
  const log = logger(dataDir, { managed: true });
  const phase = (name, extra = {}) => { if (process.connected) process.send({ type: 'aero-lp-phase', phase: name, ...extra }); };
  let stopping = false, paused = false, pendingWake = false, wake = null, receive = null;
  const stop = () => { stopping = true; wake?.(); receive?.(null); };
  const key = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('private key was not received from the workbench')), KEY_TIMEOUT_MS);
    receive = (value) => { clearTimeout(timer); receive = null; resolve(value); };
    process.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'aero-lp-key' && typeof message.key === 'string') { paused = message.paused === true; receive?.(message.key); }
      else if (message.type === 'aero-lp-stop') stop();
      else if (message.type === 'aero-lp-reload') { pendingWake = true; wake?.(); }
      else if (message.type === 'aero-lp-pause') paused = message.paused === true;
    });
    process.once('disconnect', stop);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    process.send({ type: 'aero-lp-ready' });
  });
  if (key === null) return;
  if (!PRIVATE_KEY_PATTERN.test(key)) throw new Error('private key must be 64 hex characters (optionally 0x-prefixed)');
  const wallet = new Wallet(key).address;
  const release = acquireLock(dataDir, wallet);
  let ctx = null, connection = null, memory = {};
  try {
    while (!stopping) {
      let intervalSec = 60;
      try {
        const config = loadSettings(readFileSync(configPath, 'utf8'));
        intervalSec = config.intervalSec;
        const wanted = JSON.stringify(CONNECTION_KEYS.map((k) => config[k]));
        if (wanted !== connection) {
          ctx = null; connection = null;
          phase('connecting');
          ctx = await connect(config, new Wallet(key, provider(config.rpcUrl)));
          connection = wanted; memory = {};
          log({ event: 'start', command: 'managed', wallet, pool: ctx.addresses.pool, gauge: ctx.addresses.gauge, pair: `${ctx.symbol0}/${ctx.symbol1}` });
        }
        phase('cycle');
        await cycle(ctx, config, wallet, log, { dryRun: false, dataDir, memory, paused: () => paused, onExecute: () => phase('executing') });
      } catch (error) {
        log({ event: 'cycle_error', error: errorText(error) });
      }
      if (stopping) break;
      if (pendingWake) { pendingWake = false; continue; }
      phase('sleeping', { nextAt: new Date(Date.now() + intervalSec * 1000).toISOString() });
      await new Promise((r) => { const timer = setTimeout(r, intervalSec * 1000); wake = () => { clearTimeout(timer); r(); }; });
      wake = null; pendingWake = false;
    }
  } finally { release(); log({ event: 'stop' }); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.managed) { await managed(options); process.exit(0); }
  const config = loadConfig(readFileSync(options.configPath, 'utf8'));
  const log = logger(config.dataDir);
  const key = loadKey(config);
  if (!key && !options.dryRun) throw new Error('private key required: set AERO_LP_PRIVATE_KEY or config.keyFile (or use --dry-run with config.address)');
  // 格式错误时 ethers 的报错会带出原始输入，先校验，只报固定提示。
  if (key && !PRIVATE_KEY_PATTERN.test(key)) throw new Error('private key must be 64 hex characters (optionally 0x-prefixed)');
  const signer = key ? new Wallet(key, provider(config.rpcUrl)) : null;
  const wallet = signer ? signer.address : config.address;
  if (!wallet) throw new Error('config.address is required for --dry-run without a key');
  if (signer && config.address && config.address !== signer.address) throw new Error(`key address ${signer.address} != config.address ${config.address}`);
  const ctx = await connect(config, signer);
  log({ event: 'start', command: options.command, dryRun: options.dryRun, wallet, pool: ctx.addresses.pool, gauge: ctx.addresses.gauge, pair: `${ctx.symbol0}/${ctx.symbol1}` });

  const release = options.dryRun ? () => {} : acquireLock(config.dataDir, wallet);
  if (options.command !== 'run') {
    try { await cycle(ctx, config, wallet, log, { ...options, dataDir: config.dataDir }); } finally { release(); }
    return;
  }
  const memory = {};
  let stopping = false, wake = null;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      try { await cycle(ctx, config, wallet, log, { ...options, dataDir: config.dataDir, memory }); } catch (error) {
        log({ event: 'cycle_error', error: errorText(error) });
      }
      if (stopping) break;
      await new Promise((r) => { const timer = setTimeout(r, config.intervalSec * 1000); wake = () => { clearTimeout(timer); r(); }; });
    }
  } finally { release(); log({ event: 'stop' }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(errorText(error)); process.exit(1); });
}
