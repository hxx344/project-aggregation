import { createHash } from 'node:crypto';
import type { openDatabase } from './sqlite.ts';
import { connectionSchema } from './validation.ts';
import type { Credentials } from './validation.ts';
import { POSITIONS_CATALOG } from './positions-catalog.ts';
import type { PositionsExchangeId, ScopeDefinition } from './positions-catalog.ts';
import type { HubPositions, Position, PositionsScope } from './positions-types.ts';
import { POSITIONS_FAILED } from './positions-values.ts';
import { readBinancePositions, readBybitPositions, readOkxPositions, readAsterPositions } from './positions-readers.ts';
import type { BinanceScope, BybitScope } from './positions-readers.ts';
import { readVariationalPythonPositions } from './variational-python-client.ts';

type Database = Pick<ReturnType<typeof openDatabase>, 'prepare'>;
type ConnectionRow = { exchange: string; encrypted: string };
type SourceAccount = { id: string; name: string; exchange: PositionsExchangeId; key: string; row?: ConnectionRow };
type Unseal = (encrypted: string, context: string) => Promise<unknown>;
type Read = (credentials: Credentials, scope: string, signal: AbortSignal) => Promise<Position[]>;
type Entry = { revision: string; scope: PositionsScope; attemptedAt: number; touchedAt: number; pending?: Promise<void>; abort?: AbortController };
const TTL = 30_000;
const STALE_AFTER = 90_000;
const DEADLINE = 25_000;
const revisionOf = (value: string) => createHash('sha256').update(value).digest('hex');

async function defaultRead(credentials: Credentials, scope: string, signal: AbortSignal): Promise<Position[]> {
  switch (credentials.exchange) {
    case 'binance': return readBinancePositions(credentials, fetch, signal, scope as BinanceScope);
    case 'bybit': return readBybitPositions(credentials, scope as BybitScope, fetch, signal);
    case 'okx': return readOkxPositions(credentials, scope as 'SWAP' | 'FUTURES', fetch, signal);
    case 'aster': return readAsterPositions(credentials, fetch, signal);
    case 'variational': return readVariationalPythonPositions(credentials, signal);
  }
}

async function sourceAccounts(database: Database, owner: string): Promise<SourceAccount[]> {
  const [stored, settings] = await Promise.all([
    database.prepare('SELECT exchange,encrypted FROM connections WHERE owner = ?').bind(owner).all<ConnectionRow>(),
    database.prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner, 'aster-accounts').first<{ value: string }>(),
  ]);
  const accounts: SourceAccount[] = POSITIONS_CATALOG.filter(item => item.id !== 'aster').map(item => ({
    id: 'default', name: '默认账号', exchange: item.id, key: item.id, row: stored.results.find(row => row.exchange === item.id),
  }));
  const aster = new Map<string, string>();
  if (settings) {
    const values: unknown = JSON.parse(settings.value);
    if (!Array.isArray(values) || values.length > 10) throw new Error(POSITIONS_FAILED);
    for (const value of values) {
      if (!value || typeof value !== 'object' || !/^(default|[a-f0-9-]{36})$/i.test(value.id) || typeof value.name !== 'string' || value.name.length > 40) throw new Error(POSITIONS_FAILED);
      aster.set(value.id, value.name);
    }
  }
  for (const row of stored.results) {
    const id = row.exchange === 'aster' ? 'default' : row.exchange.startsWith('aster:') ? row.exchange.slice(6) : null;
    if (id && /^(default|[a-f0-9-]{36})$/i.test(id) && !aster.has(id)) aster.set(id, id === 'default' ? '默认账号' : 'Aster 账号');
  }
  if (!aster.size) aster.set('default', '默认账号');
  for (const [id, name] of aster) {
    const key = id === 'default' ? 'aster' : 'aster:' + id;
    accounts.push({ id, name, exchange: 'aster', key, row: stored.results.find(row => row.exchange === key) });
  }
  return accounts;
}

/** Process-local snapshots contain normalized public data only. Each poll reads current vault revisions. */
export function createPositionsService(options: { now?: () => number; ttl?: number; deadline?: number; concurrency?: number; read?: Read } = {}) {
  const now = options.now ?? Date.now, ttl = options.ttl ?? TTL;
  const entries = new Map<string, Entry>();
  let active = 0;
  const queue: (() => void)[] = [];
  const limit = Math.max(1, Math.min(3, options.concurrency ?? 3));
  async function limited(work: () => Promise<void>) {
    if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
    else active++;
    try { await work(); } finally { const next = queue.shift(); if (next) next(); else active--; }
  }
  const cacheKey = (owner: string, key: string, scope: string) => JSON.stringify([owner, key, scope]);
  function empty(scope: ScopeDefinition, configured: boolean): PositionsScope {
    return { id: scope.id, label: scope.label, status: !configured ? 'unconfigured' : scope.unsupported ? 'unsupported' : 'loading',
      refreshing: false, fetchedAt: null, error: configured ? scope.unsupported ?? null : null, positions: [] };
  }
  async function current(database: Database, owner: string, account: SourceAccount, revision: string) {
    const row = await database.prepare('SELECT encrypted FROM connections WHERE owner = ? AND exchange = ?').bind(owner, account.key).first<{ encrypted: string }>();
    return !!row && revisionOf(row.encrypted) === revision;
  }
  function refresh(database: Database, owner: string, account: SourceAccount, entry: Entry, key: string, unseal: Unseal) {
    if (entry.pending) return;
    entry.scope.refreshing = true;
    entry.pending = limited(async () => {
      if (entries.get(key) !== entry || !await current(database, owner, account, entry.revision)) return;
      const abort = new AbortController(); entry.abort = abort;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const work = async () => {
          const c = connectionSchema.parse(await unseal(account.row!.encrypted, owner + ':' + account.key));
          if (c.exchange !== account.exchange || !await current(database, owner, account, entry.revision)) throw new Error(POSITIONS_FAILED);
          return (options.read ?? defaultRead)(c, entry.scope.id, abort.signal);
        };
        const positions = await Promise.race([work(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(new Error(POSITIONS_FAILED)); }, options.deadline ?? DEADLINE);
        })]);
        if (entries.get(key) !== entry || !await current(database, owner, account, entry.revision)) return;
        entry.scope = { ...entry.scope, positions, status: 'live', refreshing: false, fetchedAt: new Date(now()).toISOString(), error: null };
      } catch {
        if (entries.get(key) === entry && await current(database, owner, account, entry.revision).catch(() => false)) {
          entry.scope = { ...entry.scope, status: 'error', refreshing: false, error: POSITIONS_FAILED };
        }
      } finally {
        clearTimeout(timer); entry.attemptedAt = now(); entry.scope.refreshing = false; entry.abort = undefined;
      }
    }).catch(() => {
      if (entries.get(key) === entry) entry.scope = { ...entry.scope, status: 'error', refreshing: false, error: POSITIONS_FAILED };
    }).finally(() => { entry.pending = undefined; });
  }
  return {
    async read(database: Database, owner: string, unseal: Unseal): Promise<HubPositions> {
      const accounts = await sourceAccounts(database, owner);
      const keep = new Set<string>();
      const exchanges = POSITIONS_CATALOG.map(exchange => ({ id: exchange.id, name: exchange.name,
        accounts: accounts.filter(account => account.exchange === exchange.id).map(account => {
          const revision = account.row ? revisionOf(account.row.encrypted) : null;
          return { id: account.id, name: account.name, configured: !!account.row, revision, scopes: exchange.scopes.map(scope => {
            const key = cacheKey(owner, account.key, scope.id); keep.add(key);
            let entry = entries.get(key);
            if (entry && entry.revision !== revision) { entry.abort?.abort(); entries.delete(key); entry = undefined; }
            if (!revision || scope.unsupported) return empty(scope, !!revision);
            if (!entry) {
              entry = { revision, scope: empty(scope, true), attemptedAt: -Infinity, touchedAt: now() }; entries.set(key, entry);
            }
            entry.touchedAt = now();
            if (!entry.pending && now() - entry.attemptedAt >= ttl) refresh(database, owner, account, entry, key, unseal);
            const result = { ...entry.scope, positions: entry.scope.positions.map(item => ({ ...item })) };
            if (result.status === 'live' && result.fetchedAt && now() - Date.parse(result.fetchedAt) >= STALE_AFTER) result.status = 'stale';
            return result;
          }) };
        }),
      }));
      for (const [key, entry] of entries) {
        if ((JSON.parse(key)[0] === owner && !keep.has(key)) || now() - entry.touchedAt > 15 * 60_000) { entry.abort?.abort(); entries.delete(key); }
      }
      // Never return the old account snapshot if a connection changed while the
      // catalog query was yielding. The next poll rebuilds from current revisions.
      const latest = await database.prepare('SELECT exchange,encrypted FROM connections WHERE owner = ?').bind(owner).all<ConnectionRow>();
      for (const account of accounts) {
        const row = latest.results.find(item => item.exchange === account.key);
        if ((row?.encrypted ?? null) !== (account.row?.encrypted ?? null)) throw new Error(POSITIONS_FAILED);
      }
      return { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), exchanges };
    },
    async idle() { while ([...entries.values()].some(entry => entry.pending)) await Promise.allSettled([...entries.values()].map(entry => entry.pending)); },
  };
}

export const hubPositionsService = createPositionsService();
