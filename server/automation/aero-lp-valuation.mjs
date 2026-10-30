// Aero LP wallet valuation for the Asset ledger, in the pool's quote token (USDC): position values, wallet
// token balances and unclaimed AERO from the latest cycle. Gas ETH is left out. null: no wallet configured.
// An incomplete cycle yields total null with an error, so Asset keeps its previous value instead of a partial sum.
// staleAfterSec follows the LP's own check interval (the same limit as the Feishu digest); Asset enforces it.
const DETAIL_LIMIT = 100;
const number = value => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function aeroLpValuation(state) {
  if (!state?.wallet) return null;
  const cycle = state.lastCycle;
  const staleAfterSec = Math.max(600, (state.config?.intervalSec ?? 60) * 3);
  const base = { wallet: state.wallet, state: state.state, at: cycle?.at ?? null, staleAfterSec, total: null, details: [], error: null };
  const fail = error => ({ ...base, error });
  if (!cycle) return fail(state.state === 'running' || state.state === 'starting' ? 'Aero LP 尚未完成首轮检查' : 'Aero LP 未运行，尚无链上估值');
  const [symbol0, symbol1] = Array.isArray(cycle.symbols) ? cycle.symbols : [];
  if (symbol1 !== 'USDC') return fail('Aero LP 计价代币不是 USDC，暂不计入');
  if (!cycle.rewards) return fail('Aero LP 本轮头寸估值读取失败');
  const price = number(cycle.price), aeroPrice = number(cycle.rewards.price), wallet = cycle.wallet ?? {};
  if (price === null || price <= 0) return fail('Aero LP 现价无效');
  const details = [];
  for (const position of cycle.positions ?? []) {
    const value = number(position.value);
    if (value === null) return fail(`Aero LP 头寸 #${position.id} 估值缺失`);
    details.push({ account: `头寸 #${position.id}${position.staked ? '（质押）' : ''}`, coin: symbol1, quantity: value, value });
  }
  const held = [[symbol0, number(wallet[symbol0]), price], [symbol1, number(wallet[symbol1]), 1]];
  // The wallet AERO line is the token0 balance itself when the pool's own token is AERO.
  if (symbol0 !== 'AERO') held.push(['AERO', number(wallet.AERO ?? '0'), aeroPrice]);
  if (wallet.xAERO !== undefined) held.push(['xAERO', number(wallet.xAERO), aeroPrice]);
  for (const [coin, quantity, unit] of held) {
    if (quantity === null) return fail(`Aero LP 钱包 ${coin} 余额缺失`);
    if (quantity === 0) continue;
    if (unit === null) return fail('Aero LP 的 AERO 报价不可用');
    details.push({ account: '钱包', coin, quantity, value: quantity * unit });
  }
  const pending = number(cycle.rewards.pending);
  if (pending === null) return fail('Aero LP 待领取 AERO 读取失败');
  if (pending > 0) {
    if (aeroPrice === null) return fail('Aero LP 的 AERO 报价不可用');
    details.push({ account: '待领取奖励', coin: 'AERO', quantity: pending, value: pending * aeroPrice });
  }
  if (details.length > DETAIL_LIMIT) return fail('Aero LP 明细过多，暂不计入');
  return { ...base, total: details.reduce((sum, row) => sum + row.value, 0), details };
}
