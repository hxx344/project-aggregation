export type PairSymbol = {
  symbol: string;
  display_name: string;
  min_notional: string;
  default_order_notional: string;
  default_threshold: string;
  default_spread_limit: string;
};

// Historical drafts and saved groups without a symbol remain gold groups.
// New choices always come from the authenticated server catalog.
export const DEFAULT_PAIR_SYMBOL: PairSymbol = {
  symbol: 'XAUUSD1',
  display_name: '黄金 XAUUSD1',
  min_notional: '500',
  default_order_notional: '1000',
  default_threshold: '10000',
  default_spread_limit: '0.0005',
};
export const LEGACY_PAIR_SYMBOLS: readonly PairSymbol[] = [DEFAULT_PAIR_SYMBOL];

export function parsePairSymbols(value: unknown): PairSymbol[] {
  const rows =
    value && typeof value === 'object' && 'symbols' in value
      ? value.symbols
      : null;
  if (!Array.isArray(rows) || !rows.length)
    throw new Error('服务器未提供可用配对标的，请刷新目录后重试');
  const seen = new Set<string>();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== 'object')
      throw new Error('配对标的目录格式无效');
    const entry = row as Record<string, unknown>;
    if (
      typeof entry.symbol !== 'string' ||
      !/^[A-Z0-9]{1,32}$/.test(entry.symbol) ||
      seen.has(entry.symbol) ||
      typeof entry.display_name !== 'string' ||
      !entry.display_name.trim()
    )
      throw new Error('配对标的目录格式无效');
    for (const key of [
      'min_notional',
      'default_order_notional',
      'default_threshold',
      'default_spread_limit',
    ]) {
      const amount = entry[key];
      if (
        typeof amount !== 'string' ||
        amount.length > 40 ||
        !/^\d+(?:\.\d+)?$/.test(amount) ||
        (key === 'default_threshold' ? Number(amount) < 0 : Number(amount) <= 0)
      )
        throw new Error('配对标的目录默认参数无效');
    }
    seen.add(entry.symbol);
    return {
      symbol: entry.symbol,
      display_name: entry.display_name,
      min_notional: entry.min_notional as string,
      default_order_notional: entry.default_order_notional as string,
      default_threshold: entry.default_threshold as string,
      default_spread_limit: entry.default_spread_limit as string,
    };
  });
}

export async function fetchPairSymbols(
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<PairSymbol[]> {
  const response = await request('/api/pairs/supported-symbols', {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      data && typeof data === 'object' && 'detail' in data ? data.detail : null;
    throw new Error(
      response.status === 401
        ? '登录已过期，请重新登录后读取配对标的'
        : typeof detail === 'string'
          ? detail
          : '配对标的目录读取失败，请重试',
    );
  }
  signal.throwIfAborted();
  return parsePairSymbols(data);
}
