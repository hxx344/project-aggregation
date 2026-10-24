import type { openDatabase } from './sqlite.ts';
import type { Asset, Withdrawal } from './types.ts';
import { assetMeasures, compareEmbeddedWithdrawals, embeddedWithdrawals } from './withdrawals.ts';
import { analyzePositions, positionsOf, type PositionAnalysis, type PositionsCapture } from './daily-positions.ts';
import { knownAssetValue, knownWorkbookValue, sumKnownValues } from './asset-values.ts';

/** Day-over-day changes of the adjusted asset measure, attributed to ledger rows. */
export const DAILY_CHANGE_DAYS = 90;
const DAY_MS = 86_400_000;
const CENT = 0.005;

type DetailRow = { coin: string; account: string; value: number; price: number };
type ChangeRow = Pick<Asset, 'id' | 'project' | 'kind' | 'value'> & { mode?: string; quantity?: number | null; details?: DetailRow[] };
export type ChangeSnapshot = { id: string; date: string; total: number; withdrawn?: number; partial?: boolean; future?: boolean; archived?: boolean; rows: ChangeRow[]; positions?: PositionsCapture | null };
/** Balance lines inside one exchange row, matched by account and coin. */
export type DetailChange = { label: string; previous: number | null; current: number | null; change: number };
export type SourceChange = { id: string; project: string; kind: string; previous: number | null; current: number | null; change: number; details: DetailChange[] };
export type DailyChange = {
  date: string; previousDate: string; gapDays: number;
  previousAdjusted: number; adjusted: number; change: number;
  heldChange: number; withdrawnChange: number; unattributed: number;
  sources: SourceChange[]; partial: boolean;
  /** Null before holdings were recorded with snapshots. */
  positions: PositionAnalysis | null;
};
export type DailyChangeReport = { today: string; windowStart: string; days: DailyChange[] };

const isWithdrawalRow = (row: Pick<Asset, 'project'>) => row.project.trim() === '出金';
const validDate = (date: unknown): date is string => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
};
const cents = (value: number) => Math.abs(value) < CENT ? 0 : value;
export const shiftDay = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);

/** Same day selection as assetTrend(): last original column, overridden by a saved daily snapshot. */
function observedDays(snapshots: readonly ChangeSnapshot[], today: string) {
  const days = new Map<string, ChangeSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.future || snapshot.archived || !validDate(snapshot.date) || snapshot.date > today || !Number.isFinite(snapshot.total)) continue;
    const existing = days.get(snapshot.date);
    if (!existing?.id.startsWith('daily-') || snapshot.id.startsWith('daily-')) days.set(snapshot.date, snapshot);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function measures(snapshot: ChangeSnapshot, withdrawals: Pick<Withdrawal, 'date' | 'amount'>[], baselineDate: string) {
  const embedded = snapshot.withdrawn ?? embeddedWithdrawals(snapshot.rows);
  return assetMeasures(snapshot.total, embedded, withdrawals, snapshot.date, snapshot.id.startsWith('daily-') || snapshot.date > baselineDate);
}

function detailChanges(previous: DetailRow[] | undefined, current: DetailRow[] | undefined): DetailChange[] {
  if (!previous || !current) return [];
  const sum = (rows: DetailRow[]) => {
    const map = new Map<string, { label: string; value: number }>();
    for (const row of rows) {
      const key = JSON.stringify([row.account, row.coin]), item = map.get(key);
      if (item) item.value += row.value; else map.set(key, { label: row.account + ' · ' + row.coin, value: row.value });
    }
    return map;
  };
  const before = sum(previous), after = sum(current), changes: DetailChange[] = [];
  for (const key of new Set([...after.keys(), ...before.keys()])) {
    const old = before.get(key), next = after.get(key), change = cents((next?.value ?? 0) - (old?.value ?? 0));
    if (change) changes.push({ label: (next ?? old)!.label, previous: old?.value ?? null, current: next?.value ?? null, change });
  }
  return changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

function sourceChanges(previous: ChangeRow[], current: ChangeRow[]): SourceChange[] {
  const before = new Map(previous.filter(row => !isWithdrawalRow(row)).map(row => [row.id, row]));
  const after = new Map(current.filter(row => !isWithdrawalRow(row)).map(row => [row.id, row]));
  const changes: SourceChange[] = [];
  for (const id of new Set([...after.keys(), ...before.keys()])) {
    const old = before.get(id), next = after.get(id), label = next ?? old!;
    const previousValue = old ? knownAssetValue(old) : null, currentValue = next ? knownAssetValue(next) : null;
    if ((old && previousValue === null) || (next && currentValue === null)) continue;
    const change = cents((currentValue ?? 0) - (previousValue ?? 0));
    // A transfer between accounts of one exchange leaves the row total unchanged but is still a source of movement.
    const details = detailChanges(old?.details, next?.details);
    if (change || details.length) changes.push({ id, project: label.project, kind: label.kind, previous: previousValue, current: currentValue, change, details });
  }
  return changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.project.localeCompare(b.project));
}

/** Latest day first. Each change compares two observed days and never interpolates missing dates. */
export function calculateDailyChanges(input: { snapshots: readonly ChangeSnapshot[]; withdrawals: Pick<Withdrawal, 'date' | 'amount'>[]; baselineDate: string; today: string; days?: number }): DailyChangeReport {
  const windowStart = shiftDay(input.today, -((input.days ?? DAILY_CHANGE_DAYS) - 1));
  const days = observedDays(input.snapshots, input.today);
  const result: DailyChange[] = [];
  for (let index = 1; index < days.length; index++) {
    const previous = days[index - 1], current = days[index];
    if (current.date < windowStart) continue;
    const before = measures(previous, input.withdrawals, input.baselineDate), after = measures(current, input.withdrawals, input.baselineDate);
    const sources = sourceChanges(previous.rows, current.rows);
    const heldChange = after.held - before.held;
    const embedded = compareEmbeddedWithdrawals(previous.rows, current.rows);
    const withdrawnChange = cents(embedded.change + after.recorded - before.recorded);
    result.push({
      date: current.date, previousDate: previous.date,
      gapDays: Math.round((Date.parse(current.date) - Date.parse(previous.date)) / DAY_MS),
      previousAdjusted: before.adjusted, adjusted: after.adjusted, change: after.adjusted - before.adjusted,
      heldChange, withdrawnChange,
      // Missing-value range changes and workbook/row-sum differences have no comparable source.
      unattributed: cents(after.adjusted - before.adjusted - withdrawnChange - sources.reduce((sum, source) => sum + source.change, 0)),
      sources, partial: !!previous.partial || !!current.partial || embedded.partial || sumKnownValues(previous.rows).partial || sumKnownValues(current.rows).partial,
      positions: analyzePositions({ previous: previous.positions, current: current.positions, rows: current.rows }),
    });
  }
  return { today: input.today, windowStart, days: result.reverse() };
}

type ChangeDatabase = Pick<ReturnType<typeof openDatabase>, 'prepare'>;
type StoredSnapshot = Omit<ChangeSnapshot, 'rows' | 'positions'> & { assets?: ChangeRow[]; positions?: unknown };
type StoredSource = { baselineDate?: string; periods?: (Omit<ChangeSnapshot, 'rows'> & { rows?: ChangeRow[] })[] };
const DAILY_KEY = "date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const detailsOf = (details: unknown): DetailRow[] | undefined => Array.isArray(details) ? details.filter((row): row is DetailRow =>
  !!row && typeof row.coin === 'string' && typeof row.account === 'string' && finite(row.value)).map(row => ({
  coin: row.coin, account: row.account, value: row.value, price: finite(row.price) ? row.price : 0,
})) : undefined;
const rowsOf = (rows: unknown, workbook = false): ChangeRow[] => Array.isArray(rows) ? rows.filter((row): row is ChangeRow =>
  !!row && typeof row.id === 'string' && typeof row.project === 'string').map(row => ({
  id: row.id, project: row.project, kind: typeof row.kind === 'string' ? row.kind : '',
  value: workbook ? knownWorkbookValue(row) : knownAssetValue(row),
  ...(typeof row.mode === 'string' ? { mode: row.mode } : {}),
  ...(row.quantity === null || finite(row.quantity) ? { quantity: row.quantity } : {}),
  ...(Array.isArray(row.details) ? { details: detailsOf(row.details) } : {}),
})) : [];

export async function readDailyChanges(database: ChangeDatabase, owner: string, now = Date.now(), days = DAILY_CHANGE_DAYS): Promise<DailyChangeReport> {
  const today = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const windowStart = shiftDay(today, -(days - 1));
  // The window needs the latest earlier daily snapshot as the first comparison base.
  const [source, inWindow, before, withdrawals] = await Promise.all([
    database.prepare("SELECT value FROM settings WHERE owner = ? AND key = 'source-ledger'").bind(owner).first<{ value: string }>(),
    database.prepare(`SELECT data FROM snapshots WHERE owner = ? AND ${DAILY_KEY} AND date >= ? AND date <= ? ORDER BY date`).bind(owner, windowStart, today).all<{ data: string }>(),
    database.prepare(`SELECT data FROM snapshots WHERE owner = ? AND ${DAILY_KEY} AND date < ? ORDER BY date DESC LIMIT 1`).bind(owner, windowStart).first<{ data: string }>(),
    database.prepare("SELECT value FROM settings WHERE owner = ? AND key = 'withdrawals'").bind(owner).first<{ value: string }>(),
  ]);
  const ledger: StoredSource = source ? JSON.parse(source.value) : {};
  const original = (ledger.periods ?? []).map(({ rows, ...period }) => ({ ...period, rows: rowsOf(rows, true) }));
  const daily = [...(before ? [before] : []), ...inWindow.results].map(row => {
    const { assets, positions, ...snapshot } = JSON.parse(row.data) as StoredSnapshot;
    return { ...snapshot, rows: rowsOf(assets), positions: positionsOf(positions) };
  });
  return calculateDailyChanges({ snapshots: [...original, ...daily], withdrawals: withdrawals ? JSON.parse(withdrawals.value) : [], baselineDate: ledger.baselineDate ?? '', today, days });
}
