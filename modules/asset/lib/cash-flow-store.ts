import { acquireSyncLock } from './sync-lock.ts';
import { amendCashFlows, CASH_FLOW_KEY, parseCashFlow, readCashFlowAudit } from './cash-flows.ts';
import type { openDatabase } from './sqlite.ts';
type Database = Pick<ReturnType<typeof openDatabase>, 'prepare' | 'transaction'>;

export async function loadCashFlows(database: Database, owner: string) {
  const row = await database.prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner, CASH_FLOW_KEY).first<{ value: string }>();
  return readCashFlowAudit(row?.value);
}
export async function saveCashFlow(database: Database, owner: string, value: unknown, now = Date.now()) {
  const input = parseCashFlow(value, now), lease = await acquireSyncLock(database, owner);
  try {
    const audit = await loadCashFlows(database, owner), next = amendCashFlows(audit, input, now);
    lease.write(() => database.prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value')
      .bind(owner, CASH_FLOW_KEY, JSON.stringify(next)).execute());
    return next;
  } finally { await lease.release(); }
}
