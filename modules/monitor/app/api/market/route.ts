import { loadMarket } from "../../../lib/market-service";
import type { MarketData } from "../../../lib/market";

let cache: { data: MarketData; expiresAt: number } | undefined;
let pending: Promise<MarketData> | undefined;

export async function GET() {
  if (cache && Date.now() < cache.expiresAt) return Response.json(cache.data, { headers: { "Cache-Control": "no-store" } });
  pending ??= loadMarket().finally(() => { pending = undefined; });
  const data = await pending;
  if (!data.points.length) return Response.json({ error: "No available market data" }, { status: 503 });
  cache = { data, expiresAt: Date.now() + (data.status === "live" ? 60_000 : 15_000) };
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
