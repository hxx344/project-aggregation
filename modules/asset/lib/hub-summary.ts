import type { openDatabase } from './sqlite.ts';
import type { FxStatus, Withdrawal } from './types.ts';
import { recordedWithdrawals } from './withdrawals.ts';

type SummaryAsset = { project: string; mode: string | null; value: number | null; updatedAt: string | null; error?: string | null };
type SummaryPeriod = { id: string; date: string; total: number | null; future?: boolean | number; archived?: boolean | number };
type SummaryWithdrawal = Pick<Withdrawal, 'date' | 'amount'>;
type SummaryInput = { assets: SummaryAsset[]; fx: number | null; fxStatus: Partial<FxStatus>; example: boolean; history: SummaryPeriod[]; withdrawals?: SummaryWithdrawal[]; baselineDate?: string | null };
type Metric = { key: string; label: string; value: number | string | null; unit?: string; detail?: string };
const STALE_SECONDS = 900;
const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
function oldest(values: (string | null)[]) {
  const times = values.map(iso);
  return times.length && times.every(value => value !== null) ? times.sort()[0] : null;
}
function validDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

export function buildHubSummary(input: SummaryInput, now = Date.now()) {
  const { assets, fxStatus } = input;
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const recorded = input.withdrawals ?? [];
  const manual = assets.filter(asset => asset.mode === 'manual');
  const dynamic = assets.filter(asset => asset.mode !== 'manual');
  const staticValuation = assets.length > 0 && dynamic.length === 0;
  const manualAt = oldest(manual.map(asset => asset.updatedAt));
  const updatedAt = staticValuation ? manualAt : oldest(dynamic.map(asset => asset.updatedAt));
  const unknownMode = dynamic.some(asset => !['market', 'bybit', 'aster', 'binance', 'okx', 'variational'].includes(asset.mode ?? ''));
  const values = assets.map(asset => finite(asset.value));
  const total = values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
  const withdrawals = assets.filter(asset => asset.project?.trim() === '出金').reduce((sum, asset) => sum + (finite(asset.value) ?? 0), 0);
  const fxTime = iso(fxStatus.fetchedAt);
  const fxStale = !fxTime || now - Date.parse(fxTime) > 300000 || !!fxStatus.error || finite(input.fx) === null || (input.fx ?? 0) <= 0;
  const partial = unknownMode || (staticValuation && !manualAt) || fxStale || input.example || assets.some(asset => !!asset.error || finite(asset.value) === null);
  const stale = !staticValuation && (!updatedAt || now - Date.parse(updatedAt) > STALE_SECONDS * 1000);
  const message = [
    input.example ? '上游为示例账本，请先在资产项目配置真实数据' : staticValuation ? '静态估值账本；更新时间为手工估值记录，不代表实时行情' : '资产账本已读取；更新时间取动态资产最早源时间',
    '历史曲线为表内总额，非收益曲线',
    ...(unknownMode ? ['存在未识别的资产来源，按动态数据校验'] : []),
    ...(fxStale ? ['汇率已过期、异常或缺少更新时间'] : []),
    ...(assets.some(asset => !!asset.error) ? ['部分资产更新失败，保留旧值'] : []),
    ...(stale ? ['动态资产源时间已过期或缺失'] : []),
  ].join('；');
  const metrics: Metric[] = [
    { key: 'ledger_total', label: '表内总额', value: total === null ? null : total + recordedWithdrawals(recorded, today), unit: 'USD', detail: '包含原表出金与截至北京时间今天的新增出金；不叠加交易项目账户' },
    { key: 'holdings', label: '当前持有', value: total === null ? null : total - withdrawals, unit: 'USD' },
    { key: 'entries', label: '资产条目', value: assets.length, unit: '项' },
    ...(manual.length ? [{ key: 'manual_valuation_at', label: '手工估值记录', value: manualAt, detail: '最早手工估值记录时间；手工行不参与实时过期判断' }] : []),
    { key: 'fx', label: '美元兑人民币', value: finite(input.fx), unit: 'CNY/USD', detail: `汇率日期：${fxStatus.rateDate || '未提供'}` },
  ];
  const byDay = new Map<string, SummaryPeriod>();
  for (const period of input.history) {
    if (period.future || period.archived || !validDay(period.date) || period.date > today || finite(period.total) === null) continue;
    const existing = byDay.get(period.date);
    if (!existing?.id.startsWith('daily-') || period.id.startsWith('daily-')) byDay.set(period.date, period);
  }
  const trend = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-90).map(period => ({
    at: period.date + 'T00:00:00+08:00',
    value: period.total! + (period.id.startsWith('daily-') || period.date > (input.baselineDate ?? '') ? recordedWithdrawals(recorded, period.date) : 0),
  }));
  return { schemaVersion: 2 as const, data: { updatedAt, health: { state: partial ? 'partial' as const : stale ? 'stale' as const : 'online' as const, message, staleAfterSeconds: STALE_SECONDS }, ...(staticValuation ? { freshness: 'static' as const } : {}), metrics, trend } };
}

export async function readHubSummary(database: Pick<ReturnType<typeof openDatabase>, 'prepare'>, owner: string, now = Date.now()) {
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  // SQLite projects current fields, historical totals and withdrawal dates/amounts.
  // Full snapshots, workbook asset rows and withdrawal notes never enter this path.
  const [assets, settings, metadata, original, daily, withdrawals] = await Promise.all([
    database.prepare("SELECT json_extract(data, '$.project') AS project, json_extract(data, '$.mode') AS mode, json_extract(data, '$.value') AS value, json_extract(data, '$.updatedAt') AS updatedAt, json_extract(data, '$.error') AS error FROM assets WHERE owner = ?").bind(owner).all<SummaryAsset>(),
    database.prepare("SELECT key,value FROM settings WHERE owner = ? AND key IN ('fx','fx-status')").bind(owner).all<{ key: string; value: string }>(),
    database.prepare("SELECT json_extract(value, '$.source') AS source, json_extract(value, '$.baselineDate') AS baselineDate FROM settings WHERE owner = ? AND key = 'source-ledger'").bind(owner).first<{ source: string; baselineDate: string | null }>(),
    database.prepare("SELECT json_extract(p.value, '$.id') AS id, json_extract(p.value, '$.date') AS date, json_extract(p.value, '$.total') AS total, json_extract(p.value, '$.future') AS future, json_extract(p.value, '$.archived') AS archived FROM settings s, json_each(s.value, '$.periods') p WHERE s.owner = ? AND s.key = 'source-ledger' ORDER BY CAST(p.key AS INTEGER)").bind(owner).all<SummaryPeriod>(),
    database.prepare("SELECT json_extract(data, '$.id') AS id, date, json_extract(data, '$.total') AS total FROM snapshots WHERE owner = ? AND date <= ? AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date, '+0 days') = date AND COALESCE(json_extract(data, '$.future'), 0) = 0 AND COALESCE(json_extract(data, '$.archived'), 0) = 0 AND json_type(data, '$.total') IN ('integer','real') ORDER BY date DESC LIMIT 90").bind(owner, today).all<SummaryPeriod>(),
    database.prepare("SELECT json_extract(w.value, '$.date') AS date, json_extract(w.value, '$.amount') AS amount FROM settings s, json_each(s.value) w WHERE s.owner = ? AND s.key = 'withdrawals'").bind(owner).all<SummaryWithdrawal>(),
  ]);
  const settingsByKey = new Map(settings.results.map(row => [row.key, row.value]));
  return buildHubSummary({ assets: assets.results, fx: settingsByKey.has('fx') ? Number(settingsByKey.get('fx')) : null, fxStatus: JSON.parse(settingsByKey.get('fx-status') ?? '{}'), example: metadata?.source === '示例数据（非真实资产）', history: [...original.results, ...daily.results], withdrawals: withdrawals.results, baselineDate: metadata?.baselineDate }, now);
}
