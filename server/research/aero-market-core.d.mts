export type TokenMeta = { decimals: number };
export type TokenPrice = { usd: number } | null | undefined;
export const SECONDS_PER_YEAR: number;
export function poolPrice(sqrtPriceX96: string | number, decimals0: number, decimals1: number): number;
export function rangeTicks(tick: number, tickSpacing: number, width: number): [number, number];
export function liquidityUnitUsd(sqrtPriceX96: string | number, tickLower: number, tickUpper: number, t0: TokenMeta, t1: TokenMeta, p0: TokenPrice, p1: TokenPrice): number | null;
export function dilutedApr(input: { usdPerSecond: number; competingLiquidity: string | number | null; unitUsd: number | null; deposit: number }): number | null;
export function expectedDaysInRange(tick: number, lower: number, upper: number, dailyVol: number | null | undefined): number | null;
export function priceChange(fromTick: number, toTick: number): number | null;
