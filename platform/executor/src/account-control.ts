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

export interface RegistryIdentity { authority: Venue; environment: ControlEnvironment; accountId: string }
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
}

export function createAccountControl({ writer, environment, lost }: { writer: AccountWriterPort; environment: ControlEnvironment; lost: (message: string) => never }): AccountControl {
  if (!CONTROL_ENVIRONMENTS.includes(environment)) throw new ContractError(500, 'control_environment', '模拟传输只允许以 testnet 或 demo 身份登记账户写入');
  const tickets = new Map<string, { revision: string; binding: AccountBinding; ticket: WriterTicket }>();
  const identity = (binding: AccountBinding): RegistryIdentity => ({ authority: binding.venue, environment, accountId: binding.accountId });
  const keyOf = (binding: AccountBinding): string => `${binding.venue}:${binding.accountId}`;

  function guarded<T>(binding: AccountBinding | null, action: () => T): T {
    try { return action(); }
    catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'REGISTRY_UNAVAILABLE';
      if (writer.retired || writer.closed || FATAL.has(code)) lost(`账户写入登记已失效（${code}），本实例停止写入；请重启后核对`);
      // A changed binding invalidates the cached ticket; the next call rebinds and claims again.
      if (binding && ['BINDING_CHANGED', 'BINDING_REQUIRED', 'INVALID_TICKET'].includes(code)) tickets.delete(keyOf(binding));
      const name = binding ? `${VENUE_NAMES[binding.venue]} 账户` : '账户';
      throw new ControlRefusal(code, `${name}写入登记拒绝（${code}），本次未发送`);
    }
  }
  function ticketFor(binding: AccountBinding): WriterTicket {
    const key = keyOf(binding), revision = `${binding.credentialVersion}:${binding.accountMode}`, cached = tickets.get(key);
    if (cached && cached.revision === revision) return cached.ticket;
    return guarded(binding, () => {
      writer.bind(`platform:${binding.venue}`, identity(binding), binding.credentialVersion);
      const ticket = writer.claim([identity(binding)]);
      tickets.set(key, { revision, binding, ticket });
      return ticket;
    });
  }
  const groupId = (jobId: string): string => `platform:${jobId}`;

  return {
    admit(binding, budgetMs) {
      const ticket = ticketFor(binding);
      guarded(binding, () => writer.assertOwned(ticket, budgetMs));
      const pending = guarded(binding, () => writer.unresolved(ticket));
      if (pending.length) throw new ControlRefusal('ACCOUNT_UNRESOLVED', `${VENUE_NAMES[binding.venue]} 账户有 ${pending.length} 项写入登记尚未核对，暂不发送`);
    },
    prepareCreate(binding, jobId, request) {
      const ticket = ticketFor(binding);
      // Deterministic from the persisted request, so it never carries credentials, timestamps or nonces.
      const base = { groupId: groupId(jobId), action: 'create', venue: binding.venue, clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, positionSide: request.positionSide };
      const payload = request.type === 'chase'
        ? { ...base, type: request.type, quantity: request.quantity, reduceOnly: request.reduceOnly, strategy: 'chase', maxChasePrice: request.maxChasePrice }
        : { ...base, type: request.type, quantity: request.quantity, limitPrice: request.limitPrice, timeInForce: request.timeInForce ?? 'gtc', reduceOnly: request.reduceOnly };
      return guarded(binding, () => writer.prepare(ticket, createOperationId(request.clientOrderId), payload));
    },
    prepareCancel(binding, jobId, request, seq, strategyId) {
      const ticket = ticketFor(binding);
      const payload = strategyId === undefined
        ? { groupId: groupId(jobId), action: 'cancel', venue: binding.venue, intentAction: 'cancel', intentTarget: { symbol: request.symbol, clientOrderId: request.clientOrderId } }
        : { groupId: groupId(jobId), action: 'cancel', venue: binding.venue, strategy: 'chase', intentAction: 'cancel', intentTarget: { symbol: request.symbol, remoteId: strategyId } };
      return guarded(binding, () => writer.prepare(ticket, cancelOperationId(request.clientOrderId, seq), payload));
    },
    assertSend(operation, budgetMs) { guarded(null, () => writer.assertOwned(operation, budgetMs)); },
    finish(operation, outcome) {
      try { guarded(null, () => writer.finish(operation, outcome)); }
      catch (error) { if (!(error instanceof ControlRefusal)) throw error; }
    },
    anyPending() { return guarded(null, () => writer.pendingOperationIds().length > 0); },
    pending(binding) { const ticket = ticketFor(binding); return guarded(binding, () => writer.unresolved(ticket)).map(row => row.operationId); },
    resolve(binding, operationId, outcome) { const ticket = ticketFor(binding); guarded(binding, () => writer.resolve(operationId, ticket, outcome)); },
    keepAlive() {
      for (const { binding, ticket } of [...tickets.values()]) {
        try { guarded(binding, () => writer.assertOwned(ticket, KEEP_ALIVE_BUDGET_MS)); }
        catch (error) { if (!(error instanceof ControlRefusal)) throw error; }
      }
    },
  };
}
