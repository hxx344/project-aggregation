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
  // phase：追批中 / 出错后等下次尝试 / 不回填（停用或非归档链）/ 已补齐；null 为尚未回填。nextAt 为下次回填尝试时间。旧版服务端没有这两个字段。
  history: { points: number; from: number | null; archive: 'archive' | 'unavailable' | 'local'; pending: number; phase?: 'catching_up' | 'backoff' | 'disabled' | 'complete' | null; nextAt?: number | null };
  // 池子列表：at 为最近一次发现完成时间；stale 为超过 12 小时未更新；failures/error/retryAt 为重新发现的连续失败次数、最近错误与下次尝试时间。旧版服务端没有此字段。
  // phase 区分发现进行中、待继续、真实失败退避、无进展预算退避与空闲；refreshPending 表示下一轮必须先刷新当前数据。
  // stalledAttempts 只统计连续预算耗尽且无新增草稿进展的发现尝试，不计入 failures。
  discovery?: { at: number | null; stale: boolean; failures: number; error: string | null; retryAt: number | null; phase?: 'idle' | 'running' | 'pending' | 'backoff' | 'budget_backoff'; refreshPending?: boolean; stalledAttempts?: number };
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
