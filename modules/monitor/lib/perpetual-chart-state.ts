import type { FundingHistoryPairRequest } from './perpetual-funding-history.ts';

export type PerpetualChartDays = 3 | 7 | 30;
export interface PerpetualChartSelection extends FundingHistoryPairRequest { days: PerpetualChartDays }
const parameters = ['perpView', 'chartBase', 'chartLong', 'chartShort', 'chartDays'] as const;
const basePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const keyPattern = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9][A-Za-z0-9._:-]{0,118}$/;

export function validPerpetualChartSelection(value: unknown): value is PerpetualChartSelection {
  if (!value || typeof value !== 'object') return false;
  const pair = value as PerpetualChartSelection;
  return typeof pair.base === 'string' && basePattern.test(pair.base)
    && typeof pair.longKey === 'string' && pair.longKey.length <= 160 && keyPattern.test(pair.longKey)
    && typeof pair.shortKey === 'string' && pair.shortKey.length <= 160 && keyPattern.test(pair.shortKey)
    && pair.longKey.split(':')[0] !== pair.shortKey.split(':')[0]
    && [3, 7, 30].includes(pair.days);
}

/** Exact contracts and direction are URL state, independent of scanner ranking. */
export function readPerpetualChartSelection(params: URLSearchParams): PerpetualChartSelection | null {
  if (params.get('perpView') !== 'chart' || parameters.some(key => params.getAll(key).length > 1)) return null;
  const days = params.get('chartDays') ?? '7';
  if (!['3', '7', '30'].includes(days)) return null;
  const selection = { base: params.get('chartBase'), longKey: params.get('chartLong'), shortKey: params.get('chartShort'), days: Number(days) };
  return validPerpetualChartSelection(selection) ? selection : null;
}

export function perpetualChartUrl(current: string, selection: PerpetualChartSelection | null): string {
  const url = new URL(current);
  for (const key of parameters) url.searchParams.delete(key);
  if (selection) {
    if (!validPerpetualChartSelection(selection)) throw new Error('无效的组合图表参数');
    url.searchParams.set('monitor', 'perpetual');
    url.searchParams.set('perpView', 'chart');
    url.searchParams.set('chartBase', selection.base);
    url.searchParams.set('chartLong', selection.longKey);
    url.searchParams.set('chartShort', selection.shortKey);
    url.searchParams.set('chartDays', String(selection.days));
  }
  return url.href;
}

export function perpetualWorkspaceUrl(current: string, workspace: 'opportunities' | 'positions'): string {
  const url = new URL(perpetualChartUrl(current, null));
  if (workspace === 'positions') url.searchParams.set('perpView', 'positions');
  return url.href;
}
