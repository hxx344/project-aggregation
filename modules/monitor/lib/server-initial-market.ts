import type { InitialMarketData } from "./initial-market";

// The custom server registers a read-only database provider for its lifetime.
// No request payload or mutable user state is kept in this process registry.
export async function readInitialMarket(): Promise<InitialMarketData | null> {
  const runtime = globalThis as typeof globalThis & { [key: symbol]: (() => Promise<InitialMarketData>) | undefined };
  return runtime[Symbol.for("market-monitor.initial-data")]?.() ?? null;
}
