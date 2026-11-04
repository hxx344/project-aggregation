export type MarketToken = { address: string; symbol: string; decimals: number; usd: number | null };
export type MarketVol = { daily: number; annual: number; samples: number } | null;
export type MarketPool = {
  chain: string; address: string; gauge: string | null; tickSpacing: number;
  token0: MarketToken; token1: MarketToken;
  fee: number | null; unstakedFee: number | null; tick: number; sqrtPriceX96: string; liquidity: string; stakedLiquidity: string;
  tvlUsd: number | null; emissionPerSec: number | null; emissionWindowSec: number | null;
  vol24h: MarketVol; vol7d: MarketVol; change24h: number | null;
};
export type MarketChainConfig = { enabled: boolean; rpcUrl: string };
export type MarketConfig = { enabled: boolean; intervalMin: number; minTvlUsd: number; chains: Record<string, MarketChainConfig> };
export type MarketChain = {
  id: string; name: string; enabled: boolean; rpcHost: string; status: 'idle' | 'loading' | 'ok' | 'error' | 'disabled';
  updatedAt: number | null; checkedAt: number | null; nextAt: number | null; error: string | null; errorAt: number | null;
  poolCount: number | null; activeCount: number | null; gaugeCount: number | null;
  history: { points: number; from: number | null; archive: 'archive' | 'unavailable' | 'local' };
};
export type MarketSnapshot = {
  schema: 1; revision: number; serverNow: number; unchanged?: false;
  config: MarketConfig; configError: string | null; aero: { usd: number | null; at: number | null };
  chains: MarketChain[]; pools: MarketPool[];
};
export type MarketUnchanged = { schema: 1; revision: number; serverNow: number; unchanged: true };
export type MarketPoolHistory = { chain: string; address: string; points: [number, number][] };
