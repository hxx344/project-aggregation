import { connectionSchema } from './validation.ts';
import type { Credentials } from './validation.ts';
import { POSITIONS_CATALOG } from './positions-catalog.ts';
import type { ScopeDefinition } from './positions-catalog.ts';
import type { Position } from './positions-types.ts';
import { defaultRead, sourceAccounts, revisionOf } from './hub-positions.ts';
import type { Database, SourceAccount, Unseal, ConnectionRow } from './hub-positions.ts';
import { cycleSupported } from './positions-cycle-readers.ts';
import { CYCLE_LOOKBACK_MS } from './positions-cycle.ts';
import { MAX_REQUESTS } from './positions-history.ts';
import { readOilFills } from './hub-fills-readers.ts';
import type { FillsRequest } from './hub-fills-readers.ts';
import { FillConflict, fillsNewestFirst, mergeFills, replayFills } from './hub-fills-replay.ts';
import type { FillsScope, HubFills, ReadFill } from './hub-fills-types.ts';

const TTL = 5 * 60_000, RETRY = 60_000, IDLE = 15 * 60_000, DEADLINE = 45_000, OVERLAP = 10 * 60_000;
const SKEW_RETRY = 30_000, MAX_AUTO_RETRIES = 10;
const FAILED = '成交读取失败，请检查连接、读取权限及服务器时间；已保留上次数据';
const CONFLICT = '成交记录存在冲突，暂时无法更新';
const UNSUPPORTED = '此交易所或产品范围暂不支持原油成交读取';
type ReadPositions = (credentials: Credentials, scope: string, signal: AbortSignal, fetcher: typeof fetch) => Promise<Position[]>;
type ReadFills = (credentials: Credentials, scope: string, request: FillsRequest, options: { signal: AbortSignal; fetcher: typeof fetch }) => Promise<ReadFill[]>;
type Entry = {
  revision: string; scope: FillsScope; raw: ReadFill[]; touchedAt: number; retryAt: number; cursor: number | null;
  snapshotOkAt?: number; snapshotHealthy?: boolean; pending?: Promise<void>; abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>; retryScheduled: boolean; automaticRetries: number;
};
// Bump whenever readOilFills ids/normalization or mergeFills identity change: stored raw fills are merged with new reads.
const FILL_CACHE_FORMAT = 1;
type Stored = Pick<Entry, 'scope' | 'raw' | 'cursor' | 'retryAt' | 'snapshotOkAt' | 'snapshotHealthy'> & { version: number };
// One scope across all owners and service instances, not one slot per account.
let queue: Promise<void> = Promise.resolve();
function serial(work: () => Promise<void>) {
  const job = queue.then(work);
  queue = job.catch(() => {});
  return job;
}
const cacheKey = (owner: string, account: string, scope: string) => JSON.stringify([owner, account, scope]);
const iso = (time: number) => new Date(time).toISOString();
function empty(scope: ScopeDefinition, configured: boolean, supported: boolean): FillsScope {
  return { id: scope.id, label: scope.label, status: !configured ? 'unconfigured' : supported ? 'loading' : 'unsupported',
    refreshing: false, fetchedAt: null, coverageStart: null, coverageEnd: null, truncated: false,
    error: configured && !supported ? UNSUPPORTED : null, fills: [] };
}
async function current(database: Database, owner: string, account: SourceAccount, revision: string) {
  const row = await database.prepare('SELECT encrypted FROM connections WHERE owner = ? AND exchange = ?').bind(owner, account.key).first<{ encrypted: string }>();
  return !!row && revisionOf(row.encrypted) === revision;
}
function parseStored(value: string, definition: ScopeDefinition): Stored | null {
  try {
    const data = JSON.parse(value) as Stored;
    const finite = (item: unknown) => typeof item === 'number' && Number.isFinite(item);
    if (data?.version !== FILL_CACHE_FORMAT || data.scope?.id !== definition.id || !Array.isArray(data.raw) || !Array.isArray(data.scope.fills)
      || data.cursor !== null && !finite(data.cursor) || !finite(data.retryAt)) return null;
    return data;
  } catch { return null; }
}
export function validFillsQuery(url: string) {
  const params = new URL(url).searchParams;
  return [...params.keys()].every(key => key === 'schemaVersion') && params.getAll('schemaVersion').length <= 1
    && (!params.has('schemaVersion') || params.get('schemaVersion') === '1');
}

/** Credentials never enter the cache. Replaced/deleted credentials abort work and invalidate cache at every poll.
 * Each successful refresh is stored in fill_cache (account fills in plain text, like ledger snapshots) under its
 * credential revision, so a restart or an entry idle for 15m (evicted from memory) serves the stored fills at once
 * and resumes incrementally from the stored cursor. Binance mode evidence older than 15m is not restored.
 * Successes refresh after 5m, failures after 60s.
 * Snapshot uncertainty schedules at most 10 consecutive automatic retries, 30s apart, then waits for a read.
 * Each refresh has a 45s total deadline, <=80 HTTP requests (including positions), no in-request retries. */
export function createFillsService(options: { now?: () => number; deadline?: number; read?: ReadPositions; fills?: ReadFills; fetcher?: typeof fetch } = {}) {
  const now = options.now ?? Date.now, entries = new Map<string, Entry>(), jobs = new Set<Promise<void>>();
  let closed = false;
  // A failed cache write only costs the next cold read a full history read.
  async function save(database: Database, owner: string, account: SourceAccount, entry: Entry) {
    const { scope, raw, cursor, retryAt, snapshotOkAt, snapshotHealthy } = entry;
    const stored: Stored = { version: FILL_CACHE_FORMAT, scope: { ...scope, refreshing: false }, raw, cursor, retryAt, snapshotOkAt, snapshotHealthy };
    await database.prepare('INSERT INTO fill_cache(owner,account,scope,revision,data,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,account,scope) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at')
      .bind(owner, account.key, scope.id, entry.revision, JSON.stringify(stored), now()).run().catch(() => {});
  }
  async function forget(database: Database, owner: string, account: string, scope: string, revision: string) {
    await database.prepare('DELETE FROM fill_cache WHERE owner = ? AND account = ? AND scope = ? AND revision = ?').bind(owner, account, scope, revision).run().catch(() => {});
  }
  /** Stored scopes for configured accounts that are not in memory; rows of replaced or removed credentials are deleted. */
  async function restore(database: Database, owner: string, accounts: SourceAccount[]) {
    const restored = new Map<string, Stored>();
    const rows = await database.prepare('SELECT account,scope,revision FROM fill_cache WHERE owner = ?').bind(owner)
      .all<{ account: string; scope: string; revision: string }>().catch(() => ({ results: [] }));
    for (const row of rows.results) {
      const account = accounts.find(item => item.key === row.account);
      const definition = POSITIONS_CATALOG.find(item => item.id === account?.exchange)?.scopes.find(item => item.id === row.scope);
      if (!account?.row || revisionOf(account.row.encrypted) !== row.revision || !definition || !cycleSupported(account.exchange, row.scope)) {
        await forget(database, owner, row.account, row.scope, row.revision); continue;
      }
      // A hidden Binance mode never gets an entry; skip it rather than parse its row on every poll.
      const key = cacheKey(owner, row.account, row.scope);
      if (entries.has(key) || inactive(owner, account, row.scope, row.revision)) continue;
      const data = await database.prepare('SELECT data FROM fill_cache WHERE owner = ? AND account = ? AND scope = ? AND revision = ?')
        .bind(owner, row.account, row.scope, row.revision).first<{ data: string }>().catch(() => null);
      const stored = data && parseStored(data.data, definition);
      if (stored) restored.set(key, { ...stored, scope: { ...stored.scope, label: definition.label } });
      else await forget(database, owner, row.account, row.scope, row.revision);
    }
    return restored;
  }
  function remove(key: string, entry: Entry) {
    clearTimeout(entry.timer); entry.timer = undefined; entry.retryScheduled = false;
    entry.abort?.abort(); entry.scope.refreshing = false;
    if (entries.get(key) === entry) entries.delete(key);
  }
  // One unref'ed lifecycle timer per entry serves either a skew retry or idle eviction.
  function arm(database: Database, owner: string, account: SourceAccount, entry: Entry, key: string, unseal: Unseal) {
    clearTimeout(entry.timer); entry.timer = undefined;
    if (closed || entries.get(key) !== entry || entry.pending) return;
    const expires = entry.touchedAt + IDLE;
    const due = entry.retryScheduled ? Math.min(expires, entry.retryAt) : expires;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (closed || entries.get(key) !== entry) return;
      if (now() >= entry.touchedAt + IDLE) { remove(key, entry); return; }
      if (entry.retryScheduled && now() >= entry.retryAt) refresh(database, owner, account, entry, key, unseal, true);
      else arm(database, owner, account, entry, key, unseal);
    }, Math.max(0, due - now()));
    entry.timer.unref?.();
  }
  function inactive(owner: string, account: SourceAccount, scope: string, revision: string) {
    if (account.exchange !== 'binance' || !['um', 'pm-um', 'cm', 'pm-cm'].includes(scope)) return false;
    const own = entries.get(cacheKey(owner, account.key, scope.startsWith('pm-') ? 'pm-um' : 'um'));
    const other = entries.get(cacheKey(owner, account.key, scope.startsWith('pm-') ? 'um' : 'pm-um'));
    return !(own?.revision === revision && own.snapshotOkAt !== undefined)
      && other?.revision === revision && other.snapshotHealthy === true && other.snapshotOkAt !== undefined && now() - other.snapshotOkAt < IDLE;
  }
  function refresh(database: Database, owner: string, account: SourceAccount, entry: Entry, key: string, unseal: Unseal, automatic = false) {
    if (closed || entry.pending) return;
    clearTimeout(entry.timer); entry.timer = undefined; entry.retryScheduled = false;
    entry.automaticRetries = automatic ? entry.automaticRetries + 1 : 0;
    const abort = entry.abort = new AbortController();
    entry.scope.refreshing = true;
    const valid = async () => {
      if (closed || entries.get(key) !== entry || abort.signal.aborted) return false;
      if (now() >= entry.touchedAt + IDLE || !await current(database, owner, account, entry.revision)) {
        remove(key, entry); return false;
      }
      return !closed && entries.get(key) === entry && !abort.signal.aborted;
    };
    const job = serial(async () => {
      if (!await valid() || inactive(owner, account, entry.scope.id, entry.revision)) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const work = async () => {
          const credentials = connectionSchema.parse(await unseal(account.row!.encrypted, owner + ':' + account.key));
          if (credentials.exchange !== account.exchange || !await valid()) throw new Error(FAILED);
          let requests = 0;
          const fetcher: typeof fetch = async (input, init) => {
            if (abort.signal.aborted || ++requests > MAX_REQUESTS) throw new Error(FAILED);
            return (options.fetcher ?? fetch)(input, { ...init, signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) });
          };
          const snapshotStart = now();
          let positions: Position[] | null = null;
          try {
            positions = await (options.read ?? defaultRead)(credentials, entry.scope.id, abort.signal, fetcher);
            if (!await valid()) throw new Error(FAILED);
            entry.snapshotOkAt = snapshotStart; entry.snapshotHealthy = true;
          } catch { entry.snapshotHealthy = false; if (abort.signal.aborted) throw new Error(FAILED); }
          if (!await valid()) throw new Error(FAILED);
          // This local completion time only anchors older windows; the newest query has no local upper bound.
          const snapshotAt = Math.max(snapshotStart, now());
          const lookback = snapshotAt - CYCLE_LOOKBACK_MS;
          const start = Math.max(lookback, entry.cursor === null ? lookback : entry.cursor - OVERLAP);
          const incoming = await (options.fills ?? readOilFills)(credentials, entry.scope.id, { start, end: snapshotAt }, { signal: abort.signal, fetcher });
          const raw = mergeFills(entry.raw, incoming, lookback);
          if (raw.some(fill => Date.parse(fill.time) > now() + 60_000)) throw new Error(FAILED);
          const replayed = replayFills(raw, positions, snapshotStart, account.exchange);
          return { raw, replayed, snapshotAt, positions, lookback };
        };
        const result = await Promise.race([work(), new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error(FAILED));
          abort.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => abort.abort(), options.deadline ?? DEADLINE);
          if (abort.signal.aborted) onAbort();
        })]);
        if (!await valid()) return;
        const { raw, replayed, snapshotAt, positions, lookback } = result;
        const truncated = raw.length > 2000 || (entry.scope.truncated && Date.parse(entry.scope.coverageStart ?? '') > lookback);
        entry.raw = raw.slice(0, 2000);
        const fills = replayed.fills.slice(0, 2000);
        entry.scope = { ...entry.scope, fills, truncated, refreshing: false,
          status: positions === null ? entry.scope.fetchedAt ? 'stale' : 'error' : 'live',
          error: positions === null ? '持仓快照读取失败，成交开平仓方向暂不可用' : null,
          fetchedAt: positions === null ? entry.scope.fetchedAt : iso(now()),
          coverageStart: truncated && fills.length ? fills[fills.length - 1].time : iso(lookback),
          // Coverage includes exchange-clock fills ahead of local snapshot completion (bounded above by now+60s).
          coverageEnd: iso(Math.max(snapshotAt, raw.length ? Date.parse(raw[0].time) : snapshotAt)) };
        if (!replayed.skew && positions !== null) entry.cursor = snapshotAt;
        entry.retryAt = now() + (replayed.skew ? SKEW_RETRY : positions === null ? RETRY : TTL);
        entry.retryScheduled = replayed.skew && entry.automaticRetries < MAX_AUTO_RETRIES;
        if (entries.get(key) === entry && !abort.signal.aborted) await save(database, owner, account, entry);
      } catch (error) {
        // A conflicting stored history must not outlive this process; the next cold read starts over.
        if (error instanceof FillConflict) await forget(database, owner, account.key, entry.scope.id, entry.revision);
        if (entries.get(key) === entry && await current(database, owner, account, entry.revision).catch(() => false)) {
          entry.scope = { ...entry.scope, status: error instanceof FillConflict ? 'error' : entry.scope.fetchedAt ? 'stale' : 'error',
            error: error instanceof FillConflict ? CONFLICT : FAILED };
          entry.retryAt = now() + RETRY;
        }
      } finally { clearTimeout(timer); if (onAbort) abort.signal.removeEventListener('abort', onAbort); }
    }).catch(() => {
      if (entries.get(key) === entry) { entry.scope.status = entry.scope.fetchedAt ? 'stale' : 'error'; entry.scope.error = FAILED; entry.retryAt = now() + RETRY; }
    }).finally(() => {
      entry.pending = undefined; entry.abort = undefined; jobs.delete(job);
      entry.scope.refreshing = entry.retryScheduled;
      arm(database, owner, account, entry, key, unseal);
    });
    entry.pending = job; jobs.add(job);
  }
  return {
    async read(database: Database, owner: string, unseal: Unseal): Promise<HubFills> {
      if (closed) throw new Error(FAILED);
      const accounts = await sourceAccounts(database, owner), tick = now(), keep = new Set<string>();
      for (const [key, entry] of entries) {
        const [entryOwner, accountKey] = JSON.parse(key);
        const account = accounts.find(item => item.key === accountKey);
        if (tick - entry.touchedAt >= IDLE || (entryOwner === owner && (!account?.row || revisionOf(account.row.encrypted) !== entry.revision))) {
          remove(key, entry);
        }
      }
      const restored = await restore(database, owner, accounts);
      if (closed) throw new Error(FAILED);
      const exchanges: HubFills['exchanges'] = POSITIONS_CATALOG.map(exchange => ({ id: exchange.id, name: exchange.name,
        accounts: accounts.filter(account => account.exchange === exchange.id).map(account => {
          const revision = account.row ? revisionOf(account.row.encrypted) : null;
          // Probe PM first; a successful PM snapshot suppresses the queued classic probe and its fapi history.
          const definitions = [...exchange.scopes].sort((a, b) => Number(b.id === 'pm-um') - Number(a.id === 'pm-um'));
          const scopes = definitions.flatMap(definition => {
            const key = cacheKey(owner, account.key, definition.id); keep.add(key);
            const supported = cycleSupported(exchange.id, definition.id);
            if (!revision) return [empty(definition, false, supported)];
            if (inactive(owner, account, definition.id, revision)) return [];
            if (!supported) return [empty(definition, true, false)];
            let entry = entries.get(key);
            if (!entry) {
              // Old mode evidence would pin a Binance account to both modes; a clock set back must not postpone refresh.
              const stored = restored.get(key), recent = stored?.snapshotOkAt !== undefined && tick - stored.snapshotOkAt < IDLE;
              entry = stored ? { revision, scope: stored.scope, raw: stored.raw, touchedAt: tick, retryAt: Math.min(stored.retryAt, tick + TTL), cursor: stored.cursor,
                ...(recent ? { snapshotOkAt: stored.snapshotOkAt, snapshotHealthy: stored.snapshotHealthy } : {}), retryScheduled: false, automaticRetries: 0 }
                : { revision, scope: empty(definition, true, true), raw: [], touchedAt: tick, retryAt: -Infinity, cursor: null,
                  retryScheduled: false, automaticRetries: 0 };
              entries.set(key, entry);
            }
            entry.touchedAt = tick;
            if (!entry.pending && tick >= entry.retryAt) refresh(database, owner, account, entry, key, unseal, entry.retryScheduled);
            else arm(database, owner, account, entry, key, unseal);
            const scope = { ...entry.scope, refreshing: !!entry.pending || entry.retryScheduled,
              fills: entry.scope.fills.filter(fill => Date.parse(fill.time) >= tick - CYCLE_LOOKBACK_MS).map(fill => ({ ...fill })) };
            if (scope.coverageStart && Date.parse(scope.coverageStart) < tick - CYCLE_LOOKBACK_MS) {
              scope.coverageStart = scope.coverageEnd && Date.parse(scope.coverageEnd) < tick - CYCLE_LOOKBACK_MS ? scope.coverageEnd : iso(tick - CYCLE_LOOKBACK_MS);
            }
            if (scope.status === 'live' && scope.fetchedAt && tick - Date.parse(scope.fetchedAt) >= IDLE) scope.status = 'stale';
            return [scope];
          });
          scopes.sort((a, b) => exchange.scopes.findIndex(item => item.id === a.id) - exchange.scopes.findIndex(item => item.id === b.id));
          return { id: account.id, name: account.name, configured: !!revision, revision, scopes };
        }),
      }));
      for (const [key, entry] of entries) if (JSON.parse(key)[0] === owner && !keep.has(key)) remove(key, entry);
      const latest = await database.prepare('SELECT exchange,encrypted FROM connections WHERE owner = ?').bind(owner).all<ConnectionRow>();
      for (const account of accounts) {
        const row = latest.results.find(item => item.exchange === account.key);
        if ((row?.encrypted ?? null) !== (account.row?.encrypted ?? null)) {
          for (const [key, entry] of entries) if (JSON.parse(key)[0] === owner && JSON.parse(key)[1] === account.key) remove(key, entry);
          throw new Error(FAILED);
        }
      }
      // Gate connections exist in the asset ledger but not in the positions catalog.
      const gate = latest.results.find(item => item.exchange === 'gate');
      if (gate) exchanges.push({ id: 'gate', name: 'Gate', accounts: [{
        id: 'default', name: '默认账号', configured: true, revision: revisionOf(gate.encrypted),
        scopes: [empty({ id: 'portfolio', label: '账户资产' }, true, false)],
      }] });
      const scopes = exchanges.flatMap(exchange => exchange.accounts.flatMap(account => account.scopes));
      const retained = new Set(scopes.flatMap(scope => scope.fills).sort(fillsNewestFirst).slice(0, 5000));
      for (const scope of scopes) {
        const fills = scope.fills.filter(fill => retained.has(fill));
        if (fills.length !== scope.fills.length) { scope.truncated = true; scope.coverageStart = fills.at(-1)?.time ?? null; scope.fills = fills; }
      }
      return { schemaVersion: 1, generatedAt: iso(tick), lookbackStart: iso(tick - CYCLE_LOOKBACK_MS), exchanges };
    },
    async idle() { while (jobs.size) await Promise.allSettled([...jobs]); },
    close() { closed = true; for (const [key, entry] of entries) remove(key, entry); },
  };
}
export const hubFillsService = createFillsService();
