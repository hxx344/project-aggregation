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
  history: { points: number; from: number | null; archive: 'archive' | 'unavailable' | 'local'; pending: number };
};
export type MarketSnapshot = {
  schema: 1; revision: number; serverNow: number; unchanged?: false;
  config: MarketConfig; configError: string | null; aero: { usd: number | null; at: number | null };
  chains: MarketChain[]; pools: MarketPool[];
  // 旧版服务端没有样本库与收藏字段。
  samples?: MarketSamplesStatus;
  // 收藏的池子："链:地址"（小写），按加入顺序。
  favorites?: string[]; favoritesError?: string | null;
};
export type MarketSamplesStatus = { available: boolean; error: string | null; version: number };
export type MarketWindow = '24h' | '3d' | '7d' | '30d';
// [整点秒, tick, 质押流动性, token0 美元价, token1 美元价, 排放美元/秒, 24h 日波动, 7d 日波动, 费率]
export type MarketSampleRow = [number, number, number, number | null, number | null, number | null, number | null, number | null, number | null];
// tag 标识这份样本的内容；浏览器带着缓存的 tag 来问，未变时服务端只回 MarketSamplesUnchanged。
export type MarketSamples = MarketSamplesStatus & { window: MarketWindow; unchanged?: false; tag?: string; from?: number; pools: Record<string, { hours: number; samples: MarketSampleRow[] }> };
export type MarketSamplesUnchanged = { window: MarketWindow; available: true; unchanged: true; tag: string; version: number };
export type MarketUnchanged = { schema: 1; revision: number; serverNow: number; unchanged: true };
export type MarketPoolHistory = { chain: string; address: string; points: [number, number][] };
// 详情页的流动性分布：segments 为 [下沿 tick, 上沿 tick, 流动性, 质押流动性]，只覆盖 [from, to]。
export type MarketLiquidity = {
  chain: string; address: string; at: number; block: number; tick: number; sqrtPriceX96: string; liquidity: string; stakedLiquidity: string;
  from: number; to: number; initialized: number; segments: [number, number, number, number][];
};
