export type PositionsExchangeId = 'binance' | 'bybit' | 'okx' | 'aster' | 'variational';
export type ScopeDefinition = { id: string; label: string; unsupported?: string };
export const POSITIONS_CATALOG: { id: PositionsExchangeId; name: string; scopes: ScopeDefinition[] }[] = [
  { id: 'binance', name: 'Binance', scopes: [
    { id: 'um', label: '普通 USDⓈ-M 合约' }, { id: 'pm-um', label: 'Portfolio Margin · USDⓈ-M' },
    { id: 'cm', label: '普通 COIN-M 合约（张数）' },
    { id: 'pm-cm', label: 'Portfolio Margin · COIN-M（张数）' },
    { id: 'options', label: '期权', unsupported: '暂未接入 Binance 期权' },
  ] },
  { id: 'bybit', name: 'Bybit', scopes: [
    { id: 'linear-usdt', label: 'USDT 线性合约' }, { id: 'linear-usdc', label: 'USDC 线性合约' },
    { id: 'inverse', label: '反向合约' }, { id: 'option', label: '期权' },
  ] },
  { id: 'okx', name: 'OKX', scopes: [
    { id: 'SWAP', label: '永续合约（张数）' }, { id: 'FUTURES', label: '交割合约（张数）' },
    { id: 'OPTION', label: '期权', unsupported: '暂未接入 OKX 期权' },
    { id: 'MARGIN', label: '杠杆现货', unsupported: '暂未接入 OKX 杠杆现货仓位' },
  ] },
  { id: 'aster', name: 'Aster', scopes: [{ id: 'perpetual', label: '合约 · API Pro' }] },
  { id: 'variational', name: 'Variational', scopes: [{ id: 'portfolio', label: 'Omni 永续合约 · 会话只读' }] },
];
