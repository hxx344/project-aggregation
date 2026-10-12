import { loadQuote } from "../../../lib/quote-service";
import type { LiveQuote } from "../../../lib/market";

let cached: LiveQuote | undefined;
let expiresAt = 0;
let pending: Promise<LiveQuote> | undefined;
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  if (cached && Date.now() < expiresAt) return Response.json(cached, { headers });
  try {
    pending ??= loadQuote().finally(() => { pending = undefined; });
    const quote = await pending;
    cached = quote;
    expiresAt = Date.now() + 5_000;
    return Response.json(quote, { headers });
  } catch {
    // Do not re-stamp an old quote as fresh. The client retains its last success.
    return Response.json({ error: "实时行情暂不可用" }, { status: 503, headers });
  }
}
