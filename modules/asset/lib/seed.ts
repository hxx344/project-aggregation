import example from './example-ledger.json';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Ledger, Asset } from './types';
import { parseSource, EXAMPLE_SOURCE, isVariationalProject, type SourceLedger } from './source-ledger';
import { embeddedWithdrawals } from './withdrawals';
export type { SourceLedger } from './source-ledger';
export function readSource(): SourceLedger {
  const filenames = process.env.ASSET_DATA_DIR
    ? [resolve(process.env.ASSET_DATA_DIR, 'imported-ledger.json')]
    : [resolve('.data/imported-ledger.json'), resolve('lib/imported-ledger.json')];
  for (const filename of filenames) {
    try { return parseSource(JSON.parse(readFileSync(filename, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return example;
}
export function seedLedger(raw: SourceLedger = readSource(), includeHistory = true): Ledger {
  const base = raw.periods.find(p => p.id === raw.baselineId)!;
  return {
    asterAccounts: [],
    fxStatus: { source: 'saved', fetchedAt: null, rateDate: null, error: null },
    dataKind: raw.source === EXAMPLE_SOURCE ? 'example' : 'personal',
    assets: base.rows.map(row => ({...row, mode: row.project === 'virtual' ? 'market' : row.project === 'bybit' ? 'bybit' : row.project === 'aster' ? 'aster' : row.project.trim().toLowerCase() === 'binance' ? 'binance' : row.project.trim().toLowerCase() === 'okx' ? 'okx' : isVariationalProject(row.project) ? 'variational' : 'manual', updatedAt: base.date + 'T00:00:00+08:00', status: row.project === 'virtual' ? '待更新行情' : (['bybit','aster','binance','okx'].includes(row.project.trim().toLowerCase()) || isVariationalProject(row.project)) ? '待连接 · 表格值' : '手动估值' } as Asset)),
    history: includeHistory ? raw.periods.map(({rows,...period}) => ({...period, withdrawn: embeddedWithdrawals(rows)})) : [], withdrawals: [], fx: raw.fx, baselineDate: raw.baselineDate, startedAt: raw.startedAt, baselineTotal: base.total,
    connections: { bybit: {configured:false,lastSync:null,error:null,scope:'统一账户 + 资金账户'}, aster: {configured:false,lastSync:null,error:null,scope:'合约账户'}, binance: {configured:false,lastSync:null,error:null,scope:'各钱包资产估值（USDT 折合 USD）'}, okx: {configured:false,lastSync:null,error:null,scope:'当前账户总资产估值（USD）'}, variational: {configured:false,lastSync:null,error:null,scope:'Omni 真实账户净权益（USDC 折合 USD）'} }
  };
}
