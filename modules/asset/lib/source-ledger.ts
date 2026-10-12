import { z } from 'zod';

export const EXAMPLE_SOURCE = '示例数据（非真实资产）';
export const isVariationalProject = (project: string) => ['var', 'variational'].includes(project.trim().toLowerCase());
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const finite = z.number().finite();
const row = z.object({
  id: z.string().regex(/^row-\d{1,6}$/), project: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(100), quantity: finite.nullable(), price: finite.nullable(),
  value: finite.nullable(), cell: z.string().regex(/^[A-Z]{1,3}\d{1,6}$/),
  formula: z.union([z.string().max(4096), finite, z.null()]).optional(),
});
const schema = z.object({
  source: z.string().min(1).max(255), sheet: z.string().min(1).max(100), startedAt: date,
  baselineId: z.string(), baselineDate: date, fx: finite.positive(),
  periods: z.array(z.object({
    id: z.string().regex(/^[A-Z]{1,3}1$/), date, total: finite, fx: finite.positive(), cny: finite,
    rows: z.array(row).min(1).max(1000), future: z.boolean(), rowSum: finite, difference: finite,
  })).min(1).max(1000),
});
export type SourceLedger = z.infer<typeof schema>;
export function parseSource(input: unknown): SourceLedger {
  const source = schema.parse(input);
  if (new Set(source.periods.map(p => p.id)).size !== source.periods.length) throw new Error('原表快照编号重复');
  for (const period of source.periods) {
    if (new Set(period.rows.map(r => r.id)).size !== period.rows.length) throw new Error('原表资产编号重复');
    period.future = period.date > source.startedAt;
    period.rowSum = period.rows.reduce((sum, asset) => sum + (asset.value ?? 0), 0);
    period.difference = Math.round((period.rowSum - period.total) * 1e8) / 1e8;
    if (!Number.isFinite(period.rowSum)) throw new Error('原表资产合计超出范围');
  }
  const baseline = source.periods.filter(p => !p.future).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!baseline || baseline.id !== source.baselineId || baseline.date !== source.baselineDate || baseline.fx !== source.fx) throw new Error('原表起始快照与日期或汇率不一致');
  if (Math.abs(baseline.difference) > 0.01) throw new Error('原表起始快照的行合计与总额不一致');
  for (const name of ['virtual', 'bybit', 'aster']) {
    if (baseline.rows.filter(r => r.project === name).length !== 1) throw new Error('原表必须各有一条 virtual、bybit 和 aster 资产');
  }
  if (baseline.rows.filter(r => r.project.trim().toLowerCase() === 'binance').length > 1) throw new Error('原表最多包含一条 Binance 资产，避免重复计入');
  if (baseline.rows.filter(r => r.project.trim().toLowerCase() === 'okx').length > 1) throw new Error('原表最多包含一条 OKX 资产，避免重复计入');
  if (baseline.rows.filter(r => isVariationalProject(r.project)).length > 1) throw new Error('原表最多包含一条 Var / Variational 资产，避免重复计入');
  return source;
}
