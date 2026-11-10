import { compare, multiply, negate } from './positions-cycle.ts';

export type CashFlowInput = {
  id: string; revision: number; date: string; account: string; currency: string; amount: string;
  kind: 'external' | 'internal'; transferId: string | null; usdRate: string | null; rateAt: string | null;
  reference: string; reason: string; void: boolean;
};
export type CashFlowRecord = CashFlowInput & { recordedAt: string };
export type CashFlowEvidence = CashFlowRecord & { status: 'external' | 'paired' | 'pending'; usdValue: number | null; note: string | null };
export const CASH_FLOW_LIMIT = 4000;
export const CASH_FLOW_KEY = 'cash-flow-audit-v1';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^-?\d{1,15}(?:\.\d{1,18})?$/.test(value);
const boundedText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
export const businessDay = (time: number) => new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);

/** User annotations, never detected from balance differences. Revision is the expected current version. */
export function parseCashFlow(value: unknown, now = Date.now()): CashFlowInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资金流格式无效');
  const row = value as Record<string, unknown>;
  const keys = ['id', 'revision', 'date', 'account', 'currency', 'amount', 'kind', 'transferId', 'usdRate', 'rateAt', 'reference', 'reason', 'void'];
  if (Object.keys(row).some(key => !keys.includes(key)) || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || typeof row.date !== 'string' || !DATE.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date || row.date > businessDay(now)
    || !boundedText(row.account, 80) || typeof row.currency !== 'string' || !/^[A-Z0-9]{1,20}$/.test(row.currency)
    || !decimal(row.amount) || compare(row.amount, '0') === 0 || typeof row.kind !== 'string' || !['external', 'internal'].includes(row.kind)
    || !(row.transferId === null || boundedText(row.transferId, 80)) || row.kind === 'internal' && !row.transferId || row.kind === 'external' && row.transferId !== null
    || !(row.usdRate === null || decimal(row.usdRate) && compare(row.usdRate, '0') > 0)
    || !(row.rateAt === null || typeof row.rateAt === 'string' && TIMESTAMP.test(row.rateAt) && Number.isFinite(Date.parse(row.rateAt)) && Date.parse(row.rateAt) <= now)
    || row.usdRate !== null && row.rateAt === null || row.usdRate === null && row.rateAt !== null
    || row.currency === 'USD' && row.usdRate !== null && compare(row.usdRate as string, '1') !== 0
    || !boundedText(row.reference, 200) || !boundedText(row.reason, 200) || typeof row.void !== 'boolean') throw new Error('资金流字段无效；请填写账户、币种、原始凭证及修改原因');
  if (row.usdRate !== null && Math.abs(Number(row.amount) * Number(row.usdRate)) > 1e15) throw new Error('资金流美元估值超过支持范围');
  return Object.fromEntries(keys.map(key => [key, row[key]])) as CashFlowInput;
}

export function latestCashFlows(audit: readonly CashFlowRecord[]): CashFlowRecord[] {
  const latest = new Map<string, CashFlowRecord>();
  for (const row of audit) if (!latest.has(row.id) || latest.get(row.id)!.revision < row.revision) latest.set(row.id, row);
  return [...latest.values()].filter(row => !row.void);
}
export function amendCashFlows(audit: readonly CashFlowRecord[], input: CashFlowInput, now = Date.now()): CashFlowRecord[] {
  const current = audit.filter(row => row.id === input.id).at(-1);
  const comparable = (row: CashFlowInput) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => !['revision', 'recordedAt'].includes(key))));
  // A response can be lost after persistence; retrying the identical preceding revision is idempotent.
  if (current && current.revision === input.revision + 1 && comparable(current) === comparable(input)) return [...audit];
  if ((current?.revision ?? 0) !== input.revision) throw new Error('资金流记录已被修改，请重新读取后再保存');
  if (audit.length >= CASH_FLOW_LIMIT) throw new Error('资金流审计记录已达到 4000 条上限，不能覆盖历史');
  if (!current && input.void) throw new Error('不能作废不存在的资金流');
  return [...audit, { ...input, revision: input.revision + 1, recordedAt: new Date(now).toISOString() }];
}
export function readCashFlowAudit(value: string | null | undefined): CashFlowRecord[] {
  if (!value) return [];
  const raw: unknown = JSON.parse(value);
  if (!Array.isArray(raw) || raw.length > CASH_FLOW_LIMIT) throw new Error('资金流审计记录格式无效');
  const revisions = new Map<string, number>();
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资金流审计记录格式无效');
    const { recordedAt, ...input } = value;
    if (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) throw new Error('资金流审计时间无效');
    const parsed = parseCashFlow(input, Math.max(Date.now(), Date.parse(recordedAt)));
    if (parsed.revision !== (revisions.get(parsed.id) ?? 0) + 1) throw new Error('资金流审计版本不连续');
    revisions.set(parsed.id, parsed.revision);
    return { ...parsed, recordedAt };
  });
}

export function cashFlowEvidence(audit: readonly CashFlowRecord[]): CashFlowEvidence[] {
  const rows = latestCashFlows(audit), groups = new Map<string, CashFlowRecord[]>();
  for (const row of rows) if (row.kind === 'internal') {
    const key = JSON.stringify([row.transferId, row.currency]); groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return rows.map(row => {
    const rate = row.currency === 'USD' ? '1' : row.usdRate !== null && row.rateAt && businessDay(Date.parse(row.rateAt)) === row.date ? row.usdRate : null;
    if (row.kind === 'external') return { ...row, status: 'external', usdValue: rate === null ? null : Number(multiply(row.amount, rate)),
      note: rate === null ? row.usdRate === null ? '缺少同日 USD 汇率证据' : '汇率证据日期与资金流日期不一致' : row.currency === 'USD' ? null : '使用人工登记的同日 USD 汇率' };
    const pair = groups.get(JSON.stringify([row.transferId, row.currency]))!;
    const paired = pair.length === 2 && pair[0].account !== pair[1].account && pair[0].date === pair[1].date
      && compare(pair[0].amount, negate(pair[1].amount)) === 0;
    return { ...row, status: paired ? 'paired' : 'pending', usdValue: paired ? 0 : null,
      note: paired ? '同币种、同日、不同账户的唯一等额反向双边；净贡献为零' : '待配对：需同日、同币种、不同账户且唯一等额反向记录；跨日不自动配对' };
  });
}
export function intervalCashFlows(audit: readonly CashFlowRecord[], previous: string, current: string) {
  const rows = cashFlowEvidence(audit).filter(row => row.date > previous && row.date <= current);
  const known = rows.filter(row => row.status === 'external' && row.usdValue !== null);
  return { knownNetUsd: known.length ? known.reduce((sum, row) => sum + row.usdValue!, 0) : null,
    rows, pending: rows.filter(row => row.status === 'pending').length, missingRate: rows.filter(row => row.status === 'external' && row.usdValue === null).length,
    complete: false as const, note: '仅覆盖已标注记录，未登记流量仍可能存在；金额不代表投资收益。内部配对净贡献为零。' };
}
