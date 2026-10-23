type ScopeAccount = {
  policy: { symbols: string[]; ordinary_symbol?: string };
};

// Describe the saved execution scope, independently of the visible workspace tab.
export function accountRunScope(account: ScopeAccount): string {
  const ordinary = account.policy.symbols.filter(
    (symbol) =>
      !account.policy.ordinary_symbol ||
      account.policy.ordinary_symbol === 'all' ||
      account.policy.ordinary_symbol === symbol,
  );
  return ordinary.length ? `普通开仓 ${ordinary.join(' / ')}` : '没有可执行品种';
}
