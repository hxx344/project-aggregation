export const MAX_CROSSEX_BLOCKED_BASES = 200;
export interface CrossExFilterConfig { requireSpotTransfer: boolean; blockedBases: string[] }

/** Match canonical base codes exactly; never guess a base by stripping a quote currency. */
export function normalizeCrossExBlockedBases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CROSSEX_BLOCKED_BASES) throw new Error(`屏蔽名单必须为数组，最多 ${MAX_CROSSEX_BLOCKED_BASES} 个币种`);
  const bases = value.map(item => {
    if (typeof item !== "string") throw new Error("屏蔽币种必须是币种代码");
    const base = item.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(base)) throw new Error("请输入 1–40 位英文、数字或短横线组成的基础币种，如 BTC、ETH");
    return base;
  });
  return [...new Set(bases)].sort();
}
