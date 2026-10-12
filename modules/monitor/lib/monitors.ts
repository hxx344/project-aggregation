/** Public, versioned descriptors. Credentials and backend instances never belong here. */
export interface MonitorDefinition {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  accent: string;
  quoteIntervalMs: number;
  capabilities: readonly string[];
}

export const monitors: readonly MonitorDefinition[] = [
  { id: "oil", title: "原油价差", subtitle: "BRENT / WTI", category: "能源", accent: "#087f83", quoteIntervalMs: 10_000, capabilities: ["quote", "history", "candles/15m", "funding", "alerts"] },
  { id: "cl-xau", title: "金油比", subtitle: "XAU / CL", category: "黄金 / 原油", accent: "#9a6718", quoteIntervalMs: 30_000, capabilities: ["quote", "history", "funding", "alerts"] },
  { id: "hynix", title: "海力士 ADR", subtitle: "SKHY / SKHX", category: "半导体", accent: "#356dc4", quoteIntervalMs: 10_000, capabilities: ["quote", "history", "funding", "indicators", "alerts"] },
  { id: "perpetual", title: "合约价差", subtitle: "CEX / DEX", category: "永续合约", accent: "#356dc4", quoteIntervalMs: 1_000, capabilities: ["quote"] },
];

export function getMonitor(id: string) { return monitors.find(monitor => monitor.id === id); }
