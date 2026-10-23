import { moduleOrigin } from './transport.mjs';

export const moduleCatalog = Object.freeze([
  { id: 'monitor', name: 'Market Monitor', description: '市场价差、资金费率与行情监控', category: 'monitoring', adapter: 'monitor', staleAfterSeconds: 120 },
  { id: 'asset', name: 'Asset Ledger', description: '资产账本、持有金额与历史变化', category: 'assets', adapter: 'asset', staleAfterSeconds: 900 },
  { id: 'crossex', name: 'Gate CrossEx', description: '跨交易所永续手动实盘与持仓观察', category: 'trading', adapter: 'standard', staleAfterSeconds: 120 },
  { id: 'greeks', name: 'Greeks', description: 'BTC 期权、持仓与策略收益', category: 'trading', adapter: 'standard', staleAfterSeconds: 30 },
  { id: 'aster', name: 'Aster 5x', description: 'Aster 账户、配对交易与自动执行管理', category: 'trading', adapter: 'aster', staleAfterSeconds: 30 },
].map((item, order) => Object.freeze({ ...item, order, mode: 'embed', embedded: true, enabled: true,
  accessMode: 'proxy', autoSync: item.id === 'asset', authOrigin: '', apiUrl: moduleOrigin(item.id),
  url: moduleOrigin(item.id) + (item.id === 'monitor' ? '/?monitor=oil' : '/'), hasCredentials: true })));
export const moduleIds = Object.freeze(moduleCatalog.map(item => item.id));
// Kept outside the persisted project records. A worker receives only the
// transports listed here; every other module gets none.
export const moduleDependencies = Object.freeze({ crossex: Object.freeze(['monitor']) });
