export type WriterModule = 'hub' | 'aster' | 'greeks' | 'crossex' | 'other';
export interface WriterDiagnosticRow {
  accountRef: string;
  moduleId: WriterModule;
  moduleRef: string;
  authority: string;
  environment: string;
  lease: { state: 'active' | 'expired' | 'missing' | 'unknown'; until: number | null; moduleId: WriterModule | null };
  owner: { ref: string | null; state: 'active' | 'closed' | 'missing' | 'unknown'; lastSeenAt: number | null };
  pending: { sending: number; unknown: number; oldestAt: number | null; latestAt: number | null };
  isolation: { reason: 'legacy-conflict' | 'identity-conflict' | 'manual-isolation' | 'unknown'; since: number | null } | null;
  unverifiedModules: WriterModule[];
  reasons: string[];
}
export interface WriterDiagnostics {
  schemaVersion: 1;
  generatedAt: number | null;
  registry: 'available' | 'unavailable' | 'disabled';
  errorCode?: string;
  completeness: 'complete' | 'truncated' | 'unknown';
  scope: 'observed-registry';
  rowLimit: number;
  totalRows: number | null;
  truncated: boolean;
  recovery: { state: 'normal' | 'quarantine' | 'retired' | 'unknown'; since: number | null };
  modules: { moduleId: WriterModule; ownerEvidence: 'observed' | 'unknown'; reachability: 'unknown'; activeOwners: number | null; closedOwners: number | null; lastSeenAt: number | null; unverifiedBindings: number | null }[];
  rows: WriterDiagnosticRow[];
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const time = (value: unknown) => value === null || count(value);
const member = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value);
const moduleId = (value: unknown) => member(value, ['hub', 'aster', 'greeks', 'crossex', 'other']);

// A legacy or incomplete response cannot be interpreted as an empty registry.
export function parseWriterDiagnostics(payload: unknown): WriterDiagnostics {
  const value = object(payload) ? payload.diagnostics : null;
  if (!object(value) || value.schemaVersion !== 1 || value.scope !== 'observed-registry' || !time(value.generatedAt)
    || !member(value.registry, ['available', 'unavailable', 'disabled']) || !member(value.completeness, ['complete', 'truncated', 'unknown'])
    || !count(value.rowLimit) || value.rowLimit < 1 || value.rowLimit > 200 || !time(value.totalRows) || typeof value.truncated !== 'boolean'
    || !object(value.recovery) || !member(value.recovery.state, ['normal', 'quarantine', 'retired', 'unknown']) || !time(value.recovery.since)
    || !Array.isArray(value.modules) || value.modules.length > 5 || !Array.isArray(value.rows) || value.rows.length > value.rowLimit) throw new Error('账户保护诊断响应不完整，状态未知。');
  if (value.registry === 'available' && (!count(value.generatedAt) || !count(value.totalRows) || value.completeness === 'unknown' || value.recovery.state === 'unknown'
    || value.truncated !== (value.totalRows > value.rowLimit) || value.completeness !== (value.truncated ? 'truncated' : 'complete') || value.rows.length !== Math.min(value.totalRows, value.rowLimit))) throw new Error('账户保护诊断响应不完整，状态未知。');
  for (const row of value.modules) {
    if (!object(row) || !moduleId(row.moduleId) || !member(row.ownerEvidence, ['observed', 'unknown']) || row.reachability !== 'unknown'
      || !time(row.activeOwners) || !time(row.closedOwners) || !time(row.lastSeenAt) || !time(row.unverifiedBindings)) throw new Error('模块保护证据不完整，状态未知。');
  }
  for (const row of value.rows) {
    if (!object(row) || typeof row.accountRef !== 'string' || !/^account-[0-9a-f]{20}$/.test(row.accountRef) || !moduleId(row.moduleId)
      || typeof row.moduleRef !== 'string' || !/^module-[0-9a-f]{20}$/.test(row.moduleRef)
      || !member(row.authority, ['binance', 'bybit', 'okx', 'gate-crossex', 'aster', 'hyperliquid', 'rh-lighter', 'unknown']) || !member(row.environment, ['mainnet', 'testnet', 'demo', 'unknown'])
      || !object(row.lease) || !member(row.lease.state, ['active', 'expired', 'missing', 'unknown']) || !time(row.lease.until) || !(row.lease.moduleId === null || moduleId(row.lease.moduleId))
      || !object(row.owner) || !member(row.owner.state, ['active', 'closed', 'missing', 'unknown']) || !time(row.owner.lastSeenAt) || !(row.owner.ref === null || typeof row.owner.ref === 'string' && /^owner-[0-9a-f]{20}$/.test(row.owner.ref))
      || !object(row.pending) || !count(row.pending.sending) || !count(row.pending.unknown) || !time(row.pending.oldestAt) || !time(row.pending.latestAt)
      || !(row.isolation === null || object(row.isolation) && member(row.isolation.reason, ['legacy-conflict', 'identity-conflict', 'manual-isolation', 'unknown']) && time(row.isolation.since))
      || !Array.isArray(row.unverifiedModules) || row.unverifiedModules.length > 5 || row.unverifiedModules.some(value => !moduleId(value))
      || !Array.isArray(row.reasons) || row.reasons.some(reason => typeof reason !== 'string')) throw new Error('账户保护证据不完整，状态未知。');
  }
  return value as unknown as WriterDiagnostics;
}
