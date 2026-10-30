// Offline real-CLI fixture: only the chain boundary and deterministic filesystem barriers are replaced.
import fs from 'node:fs';
import { join } from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

const directory = process.env.AERO_FIXTURE_DIR;
const barrier = (name) => {
  fs.writeFileSync(join(directory, `${name}.entered`), String(process.pid));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(join(directory, `${name}.release`))) {
    if (Date.now() > deadline) throw new Error(`fixture barrier timed out: ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
const mkdir = fs.mkdirSync, read = fs.readFileSync;
if (process.env.AERO_FIXTURE_BARRIER === 'publish') {
  fs.mkdirSync = (file, ...args) => {
    const result = mkdir(file, ...args);
    if (/run-.*\.lock$/.test(String(file))) barrier('publish');
    return result;
  };
}
if (process.env.AERO_FIXTURE_BARRIER === 'reclaim') {
  let paused = false;
  fs.readFileSync = (file, ...args) => {
    const result = read(file, ...args);
    if (!paused && String(file).endsWith('owner.json')) { paused = true; barrier('reclaim'); }
    return result;
  };
}
if (process.env.AERO_FIXTURE_EPERM === '1') process.kill = () => { throw Object.assign(new Error('fixture denied'), { code: 'EPERM' }); };
syncBuiltinESMExports();

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('/tools/aero-lp/chain.mjs')) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export const errorText = error => error.message;
      export const provider = () => null;
      export const connect = async config => ({ decimals0: 18, decimals1: 6, spacing: 100, symbol0: 'RSGP', symbol1: 'USDC', addresses: config });
      export const reconcileLedger = async () => {};
      export const execute = async () => { throw new Error('offline fixture must never execute'); };
      let round = 0;
      export const readState = async () => {
        const positions = process.env.AERO_FIXTURE_REWARDS === '1' ? [1n, 2n].map(tokenId => ({ tokenId, staked: true, liquidity: 200n, tickLower: -337000, tickUpper: -329300, depositBlock: 1n })) : [];
        return { tick: -337050, sqrtPrice: 1.0001 ** (-337050 / 2), twapTick: -337050, blockNumber: ++round, positions, walletToken0: 0n, walletToken1: 0n, walletEth: 0n, inflight: false, penalty: null };
      };
      export const readRewards = async () => ({ growth: BigInt(round) * (1n << 128n) * (10n ** 16n), updatedAt: round, stakedLiquidity: 100n, liquidity: 100n, feeGrowth0: 0n, feeGrowth1: 0n, price: null, pending: 0n, deferred: 0n, aero: 0n, xaero: null });
    ` };
  },
});
