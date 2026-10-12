import type { Asset, Ledger, Period, Withdrawal } from './types';

type ValuedRow = Pick<Asset, 'project' | 'value'>;
export const chinaDay = (at = new Date()) => at.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

// The workbook already includes this cumulative withdrawal row in its total.
// Remove it from holdings before adding it back to the adjusted measure.
export function embeddedWithdrawals(rows: ValuedRow[]) {
  return rows.filter(row => row.project.trim() === '出金').reduce((sum, row) => sum + (row.value ?? 0), 0);
}

export function recordedWithdrawals(withdrawals: Pick<Withdrawal, 'date' | 'amount'>[], date: string) {
  return withdrawals.filter(row => row.date <= date).reduce((sum, row) => sum + row.amount, 0);
}

export function assetMeasures(total: number, embedded: number | undefined, withdrawals: Pick<Withdrawal, 'date' | 'amount'>[], date: string, includeRecorded = true) {
  const recorded = includeRecorded ? recordedWithdrawals(withdrawals, date) : 0;
  const withdrawn = (embedded ?? 0) + recorded;
  const held = total - (embedded ?? 0);
  return { held, withdrawn, adjusted: held + withdrawn, recorded };
}

// Display only: stored rows and snapshots retain the original workbook values.
export function assetDisplayRows(assets: Asset[], withdrawals: Withdrawal[], date: string): Asset[] {
  const recorded = recordedWithdrawals(withdrawals, date);
  if (!recorded) return assets;
  const target = assets.find(row => row.project.trim() === '出金' && row.mode === 'manual' && row.price === 1 &&
    row.quantity !== null && Number.isFinite(row.quantity) && row.quantity === row.value);
  if (target) return assets.map(row => row === target ? {
    ...row, quantity: row.quantity! + recorded, value: row.value! + recorded,
  } : row);
  return [...assets, {
    id: 'recorded-withdrawals', project: '出金', kind: '新增出金 / USD', quantity: recorded, price: 1, value: recorded,
    cell: '', mode: 'manual', status: '出金记录汇总',
    updatedAt: withdrawals.filter(row => row.date <= date).map(row => row.updatedAt).sort().at(-1) ?? '',
  }];
}

export function periodMeasures(period: Period, ledger: Pick<Ledger, 'withdrawals' | 'baselineDate'>) {
  return assetMeasures(period.total, period.withdrawn, ledger.withdrawals, period.date, period.id.startsWith('daily-') || period.date > ledger.baselineDate);
}

export function assetTrend(ledger: Pick<Ledger, 'history' | 'withdrawals' | 'baselineDate'>, today: string) {
  const days = new Map<string, Period>();
  for (const period of ledger.history) {
    if (period.future || period.archived || period.date > today) continue;
    const existing = days.get(period.date);
    // Last original column wins; a saved daily snapshot always takes precedence.
    if (!existing?.id.startsWith('daily-') || period.id.startsWith('daily-')) days.set(period.date, period);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(period => ({
    ...period, time: Date.parse(period.date + 'T00:00:00+08:00'),
    ...periodMeasures(period, ledger),
  }));
}
