// /api/automation/aero-safe 的返回结构（server/automation/aero-safe.mjs state()）。链上数量一律是原始单位的十进制字符串。
export type AeroSafePermissions = {
  roleKey: string;
  pools: { name?: string; token0: string; token1: string; tickSpacing: number; gauge: string }[];
  swaps: { tokenIn: string; tokenOut: string; tickSpacing: number }[];
  allowances: { token: string; symbol: string; perDay: string }[];
};
export type AeroSafeConfig = { schema?: number; rpcUrl: string; safe: string; roles: string; permissions: AeroSafePermissions; slippageBps: number; autoSellRewards: boolean; minRewardSell: string };
export type AeroSafeToken = { address: string; symbol: string; decimals: number; balance: string | null };
export type AeroSafePosition = {
  tokenId: string; staked: boolean; tickLower: number; tickUpper: number; liquidity: string; amount0: number | null; amount1: number | null;
  tokensOwed0: string; tokensOwed1: string; depositBlock: string | null; penaltyUntilBlock: string | null;
};
export type AeroSafePool = {
  name: string; address: string; gauge: string; token0: string; token1: string; tickSpacing: number; sqrtPriceX96: string; tick: number; feePips: number;
  earned: string; penalty: { minStakeBlocks: string; penaltyRate: string }; positions: AeroSafePosition[];
};
export type AeroSafeChain = {
  blockNumber: number; timestamp: number; bot: string | null; botEth: string | null; inflight: boolean; tokens: AeroSafeToken[]; ownedNfts?: string | null; ownedScanned?: number | null;
  allowances: { token: string; symbol: string; perDay: string; remaining: string; maxRefill: string; refillAt: number | null }[];
  pools: AeroSafePool[];
};
export type AeroSafeAction = 'open' | 'close' | 'stake' | 'unstake' | 'claim' | 'sell' | 'swap';
export type AeroSafeJob = {
  id: string; action: AeroSafeAction; label: string; params: Record<string, unknown>; status: 'running' | 'done' | 'failed'; step: string | null;
  startedAt: number; finishedAt: number | null; error: string | null; result: unknown; signed?: boolean; code?: string | null;
};
export type AeroSafeLedger = { at: number; hash: string; nonce: number; label: string; status: 'confirmed' | 'reverted' | 'dropped' | 'replaced'; block: number | null; gasUsed: string | null; fee: string | null };
export type AeroSafeEvent = { at: number; event?: string; [key: string]: unknown };
export type AeroSafeState = {
  schema: 1; configured: boolean; config: AeroSafeConfig | null; configError: string | null; defaults: { rpcUrl: string; slippageBps: number; autoSellRewards: boolean; minRewardSell: string };
  wallet: string | null; paused: boolean; pauseReason: string | null;
  pending: { hash: string; nonce: number; label: string; at: number; stale: boolean } | null;
  job: AeroSafeJob | null; chain: AeroSafeChain | null; chainAt: number | null; chainError: string | null; refreshing: boolean;
  events: AeroSafeEvent[]; ledger: AeroSafeLedger[]; serverNow: number;
};
export type AeroSafePreview = {
  pool: string; tick: number; sqrtPriceX96: string; tickLower: number; tickUpper: number; amount0: string; amount1: string;
  swap: { tokenIn: string; tokenOut: string; amountIn: string; quoted: string | null } | null; deposit0: string; deposit1: string; previewedAt: number;
};
