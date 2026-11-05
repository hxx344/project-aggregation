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
export type AeroSafeAction = 'open' | 'close' | 'stake' | 'unstake' | 'claim' | 'sell' | 'swap' | 'rebalance';
// 自动调仓（server/automation/aero-auto.mjs）。
export type AeroAutoConfig = { enabled: boolean; triggerMinutes: number; cooldownMinutes: number; maxPerDay: number; acceptPenalty: boolean; twapSeconds: number; maxTwapDeviationBps: number;
  // 单池上限（基点，10000 即不限）；poolCaps 按池子地址（小写）单独设置。
  poolCapBps: number; poolCaps: Record<string, number> };
export type AeroAutoState = {
  config: AeroAutoConfig; defaults: AeroAutoConfig; error: string | null; halted: { at: number; reason: string } | null;
  reopen: { pool: string; cells: number; amount0: string; amount1: string; closed: string | null; at: number; minted: string | null; inflight: 'swap' | 'mint' | null } | null;
  closing: { pool: string; tokenId: string; cells: number; at: number } | null;
  stuck: string | null;
  history: { at: number; pool: string; closed: string | null; opened: string | null; tickLower: number | null; tickUpper: number | null; capped?: boolean }[];
  watch: { tokenId: string; pool: string; outSince: number | null; dueAt: number | null; blocked: string | null }[];
  note: string | null; checkedAt: number | null; intervalMs: number;
};
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
  ledgerError?: string | null; job: AeroSafeJob | null; chain: AeroSafeChain | null; chainAt: number | null; chainError: string | null; refreshing: boolean;
  events: AeroSafeEvent[]; ledger: AeroSafeLedger[]; serverNow: number; auto?: AeroAutoState;
  changes?: AeroSafeChanges;
};
type ChangeToken = { address: string; symbol: string; decimals: number };
export type AeroSafeChangePool = { address: string; name: string; gauge: string; tickSpacing: number; token0: ChangeToken; token1: ChangeToken; addedAt: number };
// 白名单待变更：待加池与额度调整（perDay / current 为最小单位；current 为配置里的现值，新代币为 null）。
export type AeroSafeChanges = {
  pools: AeroSafeChangePool[];
  allowances: { token: string; symbol: string; decimals: number; perDay: string; current: string | null }[];
  preview: { transactions: number; usage: { label: string; nodes: number }[]; error: string | null };
  // stale：配置在生成后已变化，不能再核对；behind：生成后又有变更，未包含在这份批次里。
  batch: { createdAt: number; transactions: number; pools: string[]; allowances: { symbol: string; perDay: string; decimals: number }[]; stale: boolean; behind: boolean } | null;
};
// POST /changes/batch：builder 为 Safe{Wallet} Transaction Builder 可导入的批次 JSON。
export type AeroSafeChangeBatch = { transactions: { to: string; description: string }[]; builder: unknown; usage: { label: string; nodes: number }[]; state: AeroSafeState };
export type AeroSafePreview = {
  pool: string; tick: number; sqrtPriceX96: string; tickLower: number; tickUpper: number; amount0: string; amount1: string; capped?: boolean;
  swap: { tokenIn: string; tokenOut: string; amountIn: string; quoted: string | null } | null; deposit0: string; deposit1: string; previewedAt: number;
};
