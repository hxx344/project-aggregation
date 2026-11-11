// Shared account-writer registry (server/execution/account-writer.mjs, the
// workbench's execution-control.sqlite). Every venue write is recorded there
// first, so no two modules or processes write one account at the same time.
// The registry pins an account to the first module that claims it, forever:
// only testnet or demo identities may be claimed while transport is simulated.
import { ContractError, VENUE_NAMES, type AccountBinding, type Venue } from './contracts.ts';
import type { ChaseRequest, OrderRequest } from './connector.ts';

export type ControlEnvironment = 'testnet' | 'demo';
export const CONTROL_ENVIRONMENTS: readonly ControlEnvironment[] = ['testnet', 'demo'];
/** The registry refuses ownership checks whose budget exceeds its 60 s lease minus a 10 s safety margin. */
export const MAX_OWNED_BUDGET_MS = 50_000;
const KEEP_ALIVE_BUDGET_MS = 35_000;
const ASTER_LABEL = 'ASTER 账户';
/**
 * The registry's own constant (`ASTER_WRITE_EXPIRY_MS` in account-writer.mjs, a test keeps them equal): an unknown ASTER
 * write of this module stops gating a margin transfer this long after its last update, and an unknown transfer stops
 * gating any write. A connector whose signed requests stay valid longer must not be run with the registry.
 */
export const REGISTRY_ASTER_EXPIRY_MS = 120_000;

export interface RegistryIdentity { authority: Venue | 'aster'; environment: ControlEnvironment; accountId: string }
export interface WriterTicket { readonly claims: readonly unknown[]; readonly bindings: readonly unknown[] }
export interface WriterOperation extends WriterTicket { readonly operationId: string }
export type WriteOutcome = 'confirmed' | 'rejected' | 'unknown';
/** The subset of AccountWriter this executor relies on. */
export interface AccountWriterPort {
  readonly retired: boolean;
  readonly closed: boolean;
  bind(connectionId: string, identity: RegistryIdentity, revision: number): unknown;
  claim(identities: RegistryIdentity[]): WriterTicket;
  assertOwned(ticket: WriterTicket, budgetMs: number): unknown;
  prepare(ticket: WriterTicket, operationId: string, payload: Record<string, unknown>): WriterOperation;
  finish(operation: WriterOperation, outcome: WriteOutcome): unknown;
  resolve(operationId: string, ticket: WriterTicket, outcome: 'confirmed' | 'rejected'): unknown;
  unresolved(ticket: WriterTicket): { operationId: string; state: string }[];
  pendingOperationIds(): string[];
}

/** After any of these the registry writer can never write again; the process must restart and recover. */
const FATAL = new Set(['OWNERSHIP_LOST', 'LEASE_EXPIRED', 'WRITER_RETIRED', 'WRITER_CLOSED', 'CLOCK_ROLLBACK', 'INVALID_CLOCK', 'REGISTRY_REPLACED', 'REGISTRY_MISSING', 'AUTHORITY_RETIRED', 'UNSUPPORTED_SCHEMA', 'UNSUPPORTED_RECOVERY_SCHEMA', 'INVALID_RECOVERY_STATE']);
/** Refusals that can clear on their own within a job's deadline. */
const TRANSIENT = new Set(['ACCOUNT_UNRESOLVED', 'REGISTRY_BUSY', 'OWNER_ALIVE']);

export class ControlRefusal extends ContractError {
  readonly registryCode: string;
  readonly transient: boolean;
  constructor(registryCode: string, message: string) {
    super(409, 'account_control', message);
    this.registryCode = registryCode; this.transient = TRANSIENT.has(registryCode);
  }
}

/** Prefixes of the ASTER writes; parseOperationId of the two-leg jobs never matches them. */
export const TRANSFER_OPERATION_PREFIX = 'platform:transfer:';
export const ADL_OPERATION_PREFIX = 'platform:adl:';
export const ADL_CANCEL_OPERATION_PREFIX = 'platform:adl-cancel:';
/** A reduction cancel is registered once per attempt, keyed by the attempt's strictly increasing millisecond stamp. */
export const adlCancelOperationId = (clientOrderId: string, stamp: number): string => `${ADL_CANCEL_OPERATION_PREFIX}${clientOrderId}:${stamp}`;
export function parseAdlOperationId(operationId: string): { kind: 'create'; clientOrderId: string } | { kind: 'cancel'; clientOrderId: string; stamp: number } | null {
  const create = /^platform:adl:([A-Za-z0-9-]{1,64})$/.exec(operationId);
  if (create) return { kind: 'create', clientOrderId: create[1] };
  const cancel = /^platform:adl-cancel:([A-Za-z0-9-]{1,64}):([1-9][0-9]{0,14})$/.exec(operationId);
  return cancel ? { kind: 'cancel', clientOrderId: cancel[1], stamp: Number(cancel[2]) } : null;
}
export const createOperationId = (clientOrderId: string): string => `platform:create:${clientOrderId}`;
export const cancelOperationId = (clientOrderId: string, seq: number): string => `platform:cancel:${clientOrderId}:${seq}`;
export function parseOperationId(operationId: string): { kind: 'create'; clientOrderId: string } | { kind: 'cancel'; clientOrderId: string; seq: number } | null {
  const create = /^platform:create:([A-Za-z0-9-]{1,64})$/.exec(operationId);
  if (create) return { kind: 'create', clientOrderId: create[1] };
  const cancel = /^platform:cancel:([A-Za-z0-9-]{1,64}):([1-9][0-9]{0,8})$/.exec(operationId);
  return cancel ? { kind: 'cancel', clientOrderId: cancel[1], seq: Number(cancel[2]) } : null;
}

export interface AccountControl {
  /** Claims the account if needed, checks ownership and that no earlier write of this module on it is unresolved. */
  admit(binding: AccountBinding, budgetMs: number): void;
  prepareCreate(binding: AccountBinding, jobId: string, request: OrderRequest | ChaseRequest): WriterOperation;
  /** strategyId: the cancel stops a chase strategy, which the venue knows only by that id. */
  prepareCancel(binding: AccountBinding, jobId: string, request: Pick<OrderRequest, 'symbol' | 'clientOrderId'>, seq: number, strategyId?: string): WriterOperation;
  /** Final check inside the connector's beforeSend. */
  assertSend(operation: WriterOperation, budgetMs: number): void;
  /** Releases the shared operation after the local result is durable; a refusal leaves it for settle. */
  finish(operation: WriterOperation, outcome: WriteOutcome): void;
  /** Read-only and claim-free, so merely running never pins an account. */
  anyPending(): boolean;
  pending(binding: AccountBinding): string[];
  resolve(binding: AccountBinding, operationId: string, outcome: 'confirmed' | 'rejected'): void;
  /** Renews every held lease; never throws a refusal. */
  keepAlive(): void;
  // ---- ASTER (margin transfers and ADL reductions; accounts are 0x addresses) ----
  /** Registers a margin transfer of mainAccountId's sub-accounts under the registry's margin-transfer intent. */
  prepareTransfer(transfer: AsterTransferIntent): WriterOperation;
  prepareAdlOrder(accountId: string, batchId: string, order: AsterAdlOrder): WriterOperation;
  prepareAdlCancel(accountId: string, batchId: string, target: { symbol: string; clientOrderId: string }, stamp: number): WriterOperation;
  /** Unresolved ASTER operation ids of this module, read without claiming anything. */
  asterPending(): string[];
  /** accountIds: every account of the operation (a transfer's main, source and destination; an ADL batch's account). */
  asterResolve(accountIds: readonly string[], operationId: string, outcome: 'confirmed' | 'rejected'): void;
}
export interface AsterTransferIntent { id: string; mainAccountId: string; source: string; destination: string; amount: string }
export interface AsterAdlOrder { clientOrderId: string; symbol: string; side: 'buy' | 'sell'; positionSide: string; quantity: string }
const ASTER_PREFIXES = [TRANSFER_OPERATION_PREFIX, ADL_OPERATION_PREFIX, ADL_CANCEL_OPERATION_PREFIX];
export const isAsterOperation = (operationId: string): boolean => ASTER_PREFIXES.some(prefix => operationId.startsWith(prefix));

export function createAccountControl({ writer, environment, lost }: { writer: AccountWriterPort; environment: ControlEnvironment; lost: (message: string) => never }): AccountControl {
  if (!CONTROL_ENVIRONMENTS.includes(environment)) throw new ContractError(500, 'control_environment', '模拟传输只允许以 testnet 或 demo 身份登记账户写入');
  const tickets = new Map<string, { revision: string; ticket: WriterTicket }>();
  const identity = (binding: AccountBinding): RegistryIdentity => ({ authority: binding.venue, environment, accountId: binding.accountId });
  const keyOf = (binding: AccountBinding): string => `${binding.venue}:${binding.accountId}`;
  const asterIdentity = (accountId: string): RegistryIdentity => ({ authority: 'aster', environment, accountId: accountId.toLowerCase() });
  const asterKey = (accountIds: readonly string[]): string => `aster:${[...new Set(accountIds.map(id => id.toLowerCase()))].sort().join(',')}`;

  /** key: the cached ticket a binding refusal invalidates; label names the account in the refusal. */
  function guarded<T>(key: string | null, action: () => T, label = '账户'): T {
    try { return action(); }
    catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'REGISTRY_UNAVAILABLE';
      if (writer.retired || writer.closed || FATAL.has(code)) lost(`账户写入登记已失效（${code}），本实例停止写入；请重启后核对`);
      // A changed binding invalidates the cached ticket; the next call rebinds and claims again.
      if (key && ['BINDING_CHANGED', 'BINDING_REQUIRED', 'INVALID_TICKET'].includes(code)) tickets.delete(key);
      throw new ControlRefusal(code, `${label}写入登记拒绝（${code}），本次未发送`);
    }
  }
  const venueGuard = <T>(binding: AccountBinding, action: () => T): T => guarded(keyOf(binding), action, `${VENUE_NAMES[binding.venue]} 账户`);
  function ticketFor(binding: AccountBinding): WriterTicket {
    const key = keyOf(binding), revision = `${binding.credentialVersion}:${binding.accountMode}`, cached = tickets.get(key);
    if (cached && cached.revision === revision) return cached.ticket;
    return venueGuard(binding, () => {
      writer.bind(`platform:${binding.venue}`, identity(binding), binding.credentialVersion);
      const ticket = writer.claim([identity(binding)]);
      tickets.set(key, { revision, ticket });
      return ticket;
    });
  }
  /**
   * One ticket per set of ASTER accounts. Each account is bound on its own connection (revision fixed: the transfer and
   * ADL connectors carry no credential version), so sets that share an account share its binding and claim.
   */
  function asterTicket(accountIds: readonly string[]): WriterTicket {
    const key = asterKey(accountIds), cached = tickets.get(key);
    if (cached) return cached.ticket;
    return guarded(key, () => {
      const identities = [...new Set(accountIds.map(id => id.toLowerCase()))].map(asterIdentity);
      for (const item of identities) writer.bind(`platform:aster:${item.accountId}`, item, 1);
      const ticket = writer.claim(identities);
      tickets.set(key, { revision: '1', ticket });
      return ticket;
    }, ASTER_LABEL);
  }
  const groupId = (jobId: string): string => `platform:${jobId}`;

  return {
    admit(binding, budgetMs) {
      const ticket = ticketFor(binding);
      venueGuard(binding, () => writer.assertOwned(ticket, budgetMs));
      const pending = venueGuard(binding, () => writer.unresolved(ticket));
      if (pending.length) throw new ControlRefusal('ACCOUNT_UNRESOLVED', `${VENUE_NAMES[binding.venue]} 账户有 ${pending.length} 项写入登记尚未核对，暂不发送`);
    },
    prepareCreate(binding, jobId, request) {
      const ticket = ticketFor(binding);
      // Deterministic from the persisted request, so it never carries credentials, timestamps or nonces.
      const base = { groupId: groupId(jobId), action: 'create', venue: binding.venue, clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, positionSide: request.positionSide };
      const payload = request.type === 'chase'
        ? { ...base, type: request.type, quantity: request.quantity, reduceOnly: request.reduceOnly, strategy: 'chase', maxChasePrice: request.maxChasePrice }
        : { ...base, type: request.type, quantity: request.quantity, limitPrice: request.limitPrice, timeInForce: request.timeInForce ?? 'gtc', reduceOnly: request.reduceOnly };
      return venueGuard(binding, () => writer.prepare(ticket, createOperationId(request.clientOrderId), payload));
    },
    prepareCancel(binding, jobId, request, seq, strategyId) {
      const ticket = ticketFor(binding);
      const payload = strategyId === undefined
        ? { groupId: groupId(jobId), action: 'cancel', venue: binding.venue, intentAction: 'cancel', intentTarget: { symbol: request.symbol, clientOrderId: request.clientOrderId } }
        : { groupId: groupId(jobId), action: 'cancel', venue: binding.venue, strategy: 'chase', intentAction: 'cancel', intentTarget: { symbol: request.symbol, remoteId: strategyId } };
      return venueGuard(binding, () => writer.prepare(ticket, cancelOperationId(request.clientOrderId, seq), payload));
    },
    assertSend(operation, budgetMs) { guarded(null, () => writer.assertOwned(operation, budgetMs)); },
    finish(operation, outcome) {
      try { guarded(null, () => writer.finish(operation, outcome)); }
      catch (error) { if (!(error instanceof ControlRefusal)) throw error; }
    },
    anyPending() { return guarded(null, () => writer.pendingOperationIds().some(id => parseOperationId(id) !== null)); },
    pending(binding) { const ticket = ticketFor(binding); return venueGuard(binding, () => writer.unresolved(ticket)).map(row => row.operationId).filter(id => parseOperationId(id) !== null); },
    resolve(binding, operationId, outcome) { const ticket = ticketFor(binding); venueGuard(binding, () => writer.resolve(operationId, ticket, outcome)); },
    keepAlive() {
      for (const [key, { ticket }] of [...tickets.entries()]) {
        try { guarded(key, () => writer.assertOwned(ticket, KEEP_ALIVE_BUDGET_MS)); }
        catch (error) { if (!(error instanceof ControlRefusal)) throw error; }
      }
    },
    prepareTransfer({ id, mainAccountId, source, destination, amount }) {
      const accounts = [source, destination, mainAccountId], ticket = asterTicket(accounts);
      const [from, to, master] = accounts.map(asterIdentity);
      // The registry checks this exact shape (account-writer.mjs marginMetadata); it records the intent and is never sent.
      const payload = { marginTransfer: { version: 1, method: 'POST', path: '/fapi/v3/subAccountTransfer', params: { fromAccountAddress: from.accountId, toAccountAddress: to.accountId, asset: 'USD1', amount, kindType: 'FUTURE_FUTURE' }, source: from, destination: to, master } };
      return guarded(asterKey(accounts), () => writer.prepare(ticket, `${TRANSFER_OPERATION_PREFIX}${id}`, payload), ASTER_LABEL);
    },
    prepareAdlOrder(accountId, batchId, order) {
      const ticket = asterTicket([accountId]);
      const payload = { groupId: `platform:adl:${batchId}`, action: 'create', venue: 'aster', clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, positionSide: order.positionSide, quantity: order.quantity, type: 'market', reduceOnly: true };
      return guarded(asterKey([accountId]), () => writer.prepare(ticket, `${ADL_OPERATION_PREFIX}${order.clientOrderId}`, payload), ASTER_LABEL);
    },
    prepareAdlCancel(accountId, batchId, target, stamp) {
      const ticket = asterTicket([accountId]);
      const payload = { groupId: `platform:adl:${batchId}`, action: 'cancel', venue: 'aster', intentAction: 'cancel', intentTarget: { symbol: target.symbol, clientOrderId: target.clientOrderId } };
      return guarded(asterKey([accountId]), () => writer.prepare(ticket, adlCancelOperationId(target.clientOrderId, stamp), payload), ASTER_LABEL);
    },
    asterPending() { return guarded(null, () => writer.pendingOperationIds().filter(isAsterOperation)); },
    asterResolve(accountIds, operationId, outcome) { const ticket = asterTicket(accountIds); guarded(asterKey(accountIds), () => writer.resolve(operationId, ticket, outcome), ASTER_LABEL); },
  };
}
