// Mirrors server/automation/aero-lp.mjs state(); the private key is never part of it.
export type AeroLpConfig = {
  rpcUrl: string; pool: string; factory: string; nft: string; token: string;
  upperPrice: number; gapBps: number; intervalSec: number; twapSec: number; maxTwapDeviationBps: number; slippageBps: number;
  keepInWallet: string; minDeploy: string; minEthForGas: string;
};
export type AeroLpPosition = { id: string; range: [number, number]; staked: boolean; liquidity: string };
export type AeroLpCycle = {
  at: string; event: 'cycle'; block: number; price: number; twapPrice: number | null; twapError?: string;
  target: [number, number] | null; positions: AeroLpPosition[]; status: string; wallet: Record<string, string>; actions: string[]; notes: string[];
};
export type AeroLpEvent = { at: string; event: string } & Record<string, unknown>;
export type AeroLpState = 'starting' | 'running' | 'stopping' | 'stopped' | 'fault';
export type AeroLpSnapshot = {
  schema: 1; enabled: boolean; state: AeroLpState; error: string | null; wallet: string | null; paused: boolean;
  phase: { name: string; at: number; nextAt: string | null } | null; lastCycle: AeroLpCycle | null; events: AeroLpEvent[];
  config: AeroLpConfig; defaults: AeroLpConfig; serverNow: number;
};
