// Startup checks of a live API key, ported from the workbench's execution client
// (server/trading-execution-exchanges.mjs, permissionSnapshot): the key may read and trade futures and nothing else,
// so a leaked key cannot withdraw, transfer or trade other products.

/** A key or account that must not be used; the message says what to change. */
export class PreflightError extends Error {
  constructor(message: string) { super(message); this.name = 'PreflightError'; }
}

const BINANCE_RISKY = ['enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableMargin', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
const BINANCE_ALLOWED = ['enableReading', 'enableFutures', 'enablePortfolioMarginTrading', 'enableFixReadOnly'];
// Names as shown on Binance's API management page, so the operator knows which box to change.
const BINANCE_LABELS: Record<string, string> = {
  enableReading: '允许读取', enableFutures: '允许合约', enablePortfolioMarginTrading: '开启统一账户交易',
  enableWithdrawals: '允许提现', enableInternalTransfer: '允许子母账户划转', permitsUniversalTransfer: '允许万向划转',
  enableMargin: '允许杠杆借贷', enableVanillaOptions: '允许欧式期权', enableSpotAndMarginTrading: '启用现货、杠杆和股票交易',
  enableFixApiTrade: '允许 FIX API 交易',
};
const BYBIT_SCOPES: Record<string, string> = { ContractTrade: '合约交易', Derivatives: '统一账户衍生品', Wallet: '钱包', Spot: '现货', Options: '期权' };
/** Exchange-supplied names reach the operator only as short printable text. */
const labelOf = (labels: Record<string, string>, name: string): string => Object.hasOwn(labels, name) ? labels[name] : name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);

/** What to change on a Binance key (apiRestrictions answer), or null when it has exactly the permissions the account mode needs. */
export function binancePermissionProblem(info: Record<string, unknown>, accountMode: string): string | null {
  const label = (name: string): string => labelOf(BINANCE_LABELS, name);
  const portfolio = accountMode === 'portfolio-margin';
  const parts: string[] = [];
  // A key for the other account mode is reported as a mode problem, so the remaining checks do not also ask to toggle
  // that mode's trading permission.
  let mismatch = true;
  if (portfolio && info.enableFutures === true && info.enablePortfolioMarginTrading !== true) parts.push('密钥为普通合约密钥，请将账户模式改为 standard，或在组合保证金账户下新建开启统一账户交易的密钥');
  else if (!portfolio && info.enablePortfolioMarginTrading === true) parts.push('密钥已开启统一账户交易，请将账户模式改为 portfolio-margin');
  else mismatch = false;
  const required = mismatch ? ['enableReading'] : ['enableReading', portfolio ? 'enablePortfolioMarginTrading' : 'enableFutures'];
  const missing = required.filter(name => info[name] !== true);
  const unknown = [...BINANCE_RISKY, 'enableFutures'].filter(name => typeof info[name] !== 'boolean');
  const enabled = Object.entries(info).filter(([name, value]) => /^(?:enable|permits)/.test(name) && !BINANCE_ALLOWED.includes(name) && value !== false).map(([name]) => name);
  if (!portfolio && !mismatch && Object.hasOwn(info, 'enablePortfolioMarginTrading') && info.enablePortfolioMarginTrading !== false) enabled.push('enablePortfolioMarginTrading');
  if (missing.length) parts.push(`请开启：${missing.map(label).join('、')}`);
  const toClose = enabled.filter(name => !unknown.includes(name));
  if (toClose.length) parts.push(`请关闭：${toClose.map(label).join('、')}`);
  if (unknown.length) parts.push(`Binance 未返回权限状态：${unknown.map(label).join('、')}`);
  return parts.length ? parts.join('；') : null;
}

/** What to change on a Bybit key (query-api answer), or null when it may trade contracts and nothing else. */
export function bybitPermissionProblem(info: Record<string, unknown>): string | null {
  if (info.readOnly !== 0) return '密钥为只读，请改为读写并开启合约交易（订单、持仓）';
  const scopes = info.permissions;
  if (typeof scopes !== 'object' || scopes === null || Array.isArray(scopes)) return 'Bybit 未返回密钥权限清单';
  const table = scopes as Record<string, unknown>;
  // Missing Wallet/Spot/Options cannot prove absence, so each one must be listed.
  for (const name of Object.keys(BYBIT_SCOPES)) if (!Array.isArray(table[name])) return `Bybit 未返回「${BYBIT_SCOPES[name]}」权限状态`;
  for (const values of Object.values(table)) if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) return 'Bybit 权限清单格式无效';
  if (!(table.ContractTrade as string[]).includes('Order')) return '请开启：合约交易 - 订单';
  for (const [name, values] of Object.entries(table) as [string, string[]][]) {
    // ContractTrade is documented as [Order, Position]; DerivativesTrade is the unified-account scope. Everything else
    // (transfers and withdrawals included) must be off.
    const allowed = name === 'ContractTrade' ? ['Order', 'Position'] : name === 'Derivatives' ? ['DerivativesTrade'] : [];
    const extra = values.filter(value => !allowed.includes(value));
    if (extra.length) return `请关闭：${labelOf(BYBIT_SCOPES, name)} - ${extra.map(value => labelOf({}, value)).join('、')}`;
  }
  return null;
}

/** Bybit /v5/account/info unifiedMarginStatus: 3–6 are unified trading accounts, 1 is a classic account. */
export function bybitAccountProblem(status: unknown): string | null {
  if (status === 3 || status === 4 || status === 5 || status === 6) return null;
  return status === 1 ? 'Bybit 账户为经典账户，请先升级为统一交易账户'
    : Number.isSafeInteger(status) ? `Bybit 返回了未识别的账户状态 ${status as number}` : status === undefined ? 'Bybit 未返回账户状态' : 'Bybit 返回的账户状态格式无效';
}
