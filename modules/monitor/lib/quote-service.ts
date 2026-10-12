import { ADR_PER_SHARE, type LiveQuote } from "./market.ts";
import { parseHynixFunding } from "./hynix-funding.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function info(type: string, fetcher: Fetcher) {
  const response = await fetcher("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, dex: "xyz" }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function loadMids(fetcher: Fetcher, clock: () => number): Promise<LiveQuote> {
  const mids = await info("allMids", fetcher);
  if (!mids || typeof mids !== "object" || Array.isArray(mids)) throw new Error("Invalid quote response");
  const values = mids as Record<string, unknown>;
  const ordinary = Number(values["xyz:SKHX"]);
  const adr = Number(values["xyz:SKHY"]);
  if (![ordinary,adr].every(v => Number.isFinite(v) && v > 0)) throw new Error("Incomplete quote pair");
  const equivalent = ordinary / ADR_PER_SHARE;
  // allMids has no exchange timestamp. This is the time we received the pair.
  return { ordinary, adr, equivalent, spread: adr-equivalent, premium: (adr/equivalent-1)*100, fetchedAt: new Date(clock()).toISOString() };
}

export async function loadQuote(fetcher: Fetcher = fetch, clock = Date.now): Promise<LiveQuote> {
  const [quote, funding] = await Promise.allSettled([
    loadMids(fetcher, clock),
    info("metaAndAssetCtxs", fetcher).then(value => parseHynixFunding(value, new Date(clock()).toISOString())),
  ]);
  if (quote.status === "rejected") throw quote.reason;
  // Funding failures must neither disable premium alerts nor revive old funding
  // alongside a fresh mid quote. The client replaces this complete snapshot.
  return { ...quote.value, funding: funding.status === "fulfilled" ? funding.value : null, fundingError: funding.status === "rejected" ? "资金费暂不可用，下一轮自动重试。" : "" };
}
