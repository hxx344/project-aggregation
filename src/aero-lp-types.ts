// Mirrors server/automation/aero-lp.mjs state(); the private key is never part of it.
export type AeroLpConfig = {
  rpcUrl: string; pool: string; factory: string; nft: string; token: string;
  upperPrice: number; gapBps: number; intervalSec: number; twapSec: number; maxTwapDeviationBps: number; slippageBps: number;
  keepInWallet: string; minDeploy: string; minEthForGas: string;
};
// state is the pool's own in-range test on ticks (lower inclusive, upper exclusive); amount/value/apr are
// display estimates from the child, absent when reward reads failed that cycle.
export type AeroLpPosition = {
  id: string; range: [number, number]; staked: boolean; liquidity: string; state?: 'below' | 'in' | 'above';
  amount0?: number | null; amount1?: number | null; value?: number | null; apr?: number | null; aprEstimated?: boolean;
};
export type AeroLpRewards = { price: number | null; poolPerDay: number | null; pending: string; deferred: string };
export type AeroLpLedger = { txs: number; failed: number; gasEth: string; reward: string; since: string | null };
export type AeroLpCycle = {
  at: string; event: 'cycle'; block: number; symbols?: [string, string]; price: number; twapPrice: number | null; twapError?: string;
  target: [number, number] | null; positions: AeroLpPosition[]; status: string; wallet: Record<string, string>; actions: string[]; notes: string[];
  rewards?: AeroLpRewards | null; rewardsError?: string;
};
export type AeroLpEvent = { at: string; event: string } & Record<string, unknown>;
export type AeroLpState = 'starting' | 'running' | 'stopping' | 'stopped' | 'fault';
export type AeroLpSnapshot = {
  schema: 1; enabled: boolean; state: AeroLpState; error: string | null; wallet: string | null; paused: boolean;
  phase: { name: string; at: number; nextAt: string | null } | null; lastCycle: AeroLpCycle | null; events: AeroLpEvent[]; ledger: AeroLpLedger | null;
  config: AeroLpConfig; defaults: AeroLpConfig; serverNow: number;
};
