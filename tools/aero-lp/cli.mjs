#!/usr/bin/env node
// Aerodrome Slipstream 单边 token0 流动性调仓：status / once / run。
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, formatEther, formatUnits, getAddress, parseEther, parseUnits } from 'ethers';
import { belowTwap, nearestUsableTick, planCycle, targetRange, tickToPrice } from './core.mjs';
import { connect, errorText, execute, provider, readState } from './chain.mjs';

const USAGE = 'Usage: lp {status|once|run} [--config FILE] [--dry-run]';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['status', 'once', 'run'].includes(command)) throw new Error(USAGE);
  const options = { command, dryRun: command === 'status', configPath: join(dirname(fileURLToPath(import.meta.url)), 'config.json') };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') options.dryRun = true;
    else if (rest[i] === '--config' && rest[i + 1]) options.configPath = resolve(rest[++i]);
    else throw new Error(USAGE);
  }
  return options;
}

const expandHome = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export function loadConfig(source) {
  const c = JSON.parse(source);
  const need = (k, ok) => { if (!ok(c[k])) throw new Error(`config.${k} is invalid: ${JSON.stringify(c[k])}`); };
  need('rpcUrl', (v) => typeof v === 'string' && /^https:\/\//.test(v));
  for (const k of ['pool', 'token', 'factory', 'nft']) need(k, (v) => typeof v === 'string');
  need('upperPrice', (v) => typeof v === 'number' && v > 0);
  need('gapBps', (v) => Number.isInteger(v) && v >= 0 && v <= 10_000);
  need('intervalSec', (v) => Number.isInteger(v) && v >= 60);
  // 池子每块最多一条观测（本池容量 900，Base 约 2 秒一块），窗口过长时 observe 会回滚。
  need('twapSec', (v) => Number.isInteger(v) && v >= 0 && v <= 3_600);
  need('maxTwapDeviationBps', (v) => Number.isInteger(v) && v >= 1 && v <= 5_000);
  need('slippageBps', (v) => Number.isInteger(v) && v >= 1 && v <= 500);
  for (const k of ['keepInWallet', 'minDeploy', 'minEthForGas']) need(k, (v) => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v));
  return {
    ...c,
    pool: getAddress(c.pool),
    token: getAddress(c.token),
    factory: getAddress(c.factory),
    nft: getAddress(c.nft),
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

function logger(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'events.jsonl');
  return (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    console.log(line);
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

async function cycle(ctx, config, wallet, log, { dryRun }) {
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
  log({
    event: 'cycle',
    block: state.blockNumber,
    price: price(state.tick),
    twapPrice: state.twapTick === null ? null : price(state.twapTick),
    ...(state.twapError && { twapError: state.twapError }),
    target: plan.target && [price(plan.target.tickLower), price(plan.target.tickUpper)],
    positions: state.positions.map((p) => ({ id: String(p.tokenId), range: [price(p.tickLower), price(p.tickUpper)], staked: p.staked, liquidity: String(p.liquidity) })),
    status: plan.status,
    wallet: { [ctx.symbol0]: formatUnits(state.walletToken0, ctx.decimals0), ETH: formatEther(state.walletEth) },
    actions: plan.actions.map((a) => a.type + (a.tokenId !== undefined ? `#${a.tokenId}` : '')),
    notes: plan.notes,
  });
  if (plan.actions.length === 0 || dryRun) return;
  if (state.inflight) { log({ event: 'skip', reason: 'wallet has pending transactions; waiting for them to settle' }); return; }
  if (state.walletEth < parseEther(config.minEthForGas)) { log({ event: 'skip', reason: `ETH balance below minEthForGas ${config.minEthForGas}` }); return; }
  await execute(ctx, log, wallet, plan, { ...amounts, slippageBps: config.slippageBps, retarget });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(readFileSync(options.configPath, 'utf8'));
  const log = logger(config.dataDir);
  const key = loadKey(config);
  if (!key && !options.dryRun) throw new Error('private key required: set AERO_LP_PRIVATE_KEY or config.keyFile (or use --dry-run with config.address)');
  // 格式错误时 ethers 的报错会带出原始输入，先校验，只报固定提示。
  if (key && !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error('private key must be 64 hex characters (optionally 0x-prefixed)');
  const signer = key ? new Wallet(key, provider(config.rpcUrl)) : null;
  const wallet = signer ? signer.address : config.address;
  if (!wallet) throw new Error('config.address is required for --dry-run without a key');
  if (signer && config.address && config.address !== signer.address) throw new Error(`key address ${signer.address} != config.address ${config.address}`);
  const ctx = await connect(config, signer);
  log({ event: 'start', command: options.command, dryRun: options.dryRun, wallet, pool: ctx.addresses.pool, gauge: ctx.addresses.gauge, pair: `${ctx.symbol0}/${ctx.symbol1}` });

  const release = options.dryRun ? () => {} : acquireLock(config.dataDir, wallet);
  if (options.command !== 'run') {
    try { await cycle(ctx, config, wallet, log, options); } finally { release(); }
    return;
  }
  let stopping = false, wake = null;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      try { await cycle(ctx, config, wallet, log, options); } catch (error) {
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
