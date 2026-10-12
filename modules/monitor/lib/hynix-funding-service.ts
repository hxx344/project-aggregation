import archive from "../data/hynix-funding.json" with { type: "json" };
import { createHynixFundingSnapshot, fetchHynixFundingSnapshot, type FundingHistoryData, type FundingSnapshot } from "./hynix-funding-history.ts";

/** Retain the latest successful history on failures, including across cache expiry. */
export function createHynixFundingLoader(seed: FundingSnapshot = archive, fetcher: typeof fetch = fetch, clock = Date.now) {
  let retained = createHynixFundingSnapshot(seed.rows, seed.metadata.fetchedAt);
  return async (): Promise<FundingHistoryData> => {
    try {
      const next = await fetchHynixFundingSnapshot(retained, { fetcher, now: clock(), signal: AbortSignal.timeout(12_000) });
      retained = next;
      return { ...next, status: "live" };
    } catch {
      return { ...retained, status: "snapshot", error: "历史资金费更新失败，保留上次成功获取的结算数据。" };
    }
  };
}
export const loadHynixFunding = createHynixFundingLoader();
