type OrdinaryAddAccount = {
  policy?: { ordinary_symbol?: string };
  ordinary_add_blocks?: Record<string, string>;
};

export function ordinaryAddBlock(
  account: OrdinaryAddAccount | undefined,
  symbol: string,
): string | null {
  const reported = account?.ordinary_add_blocks?.[symbol];
  if (typeof reported === 'string' && reported.trim()) return reported;
  const selected = account?.policy?.ordinary_symbol ?? 'all';
  if (selected !== 'all' && selected !== symbol) {
    return `本账户有额度开仓仅限 ${selected}，禁止 ${symbol} 普通加仓`;
  }
  return null;
}

export function ordinaryCapacityReady(
  capacity: string | undefined,
  threshold: string,
  live: boolean,
  block: string | null,
): boolean {
  return !block && live && Number(capacity) > Number(threshold);
}
