// Shared fixture: two simulated venues listing CLUSDT, a fake wall clock and a
// throwaway data directory per test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, type Store } from '../src/store.ts';
import { createExecutor, type Budgets, type Executor, type ExecutorOptions } from '../src/executor.ts';
import type { SimulatedVenue } from '../src/sim-venue.ts';
import type { SimulatedAster } from '../src/sim-aster.ts';
import { SIM_BINDINGS, createSimulatedVenues } from '../src/simulation.ts';

export const SESSION = 'test-session-0001';
export const START = Date.UTC(2026, 10, 12, 1, 0, 0);

export interface Harness {
  dir: string;
  file: string;
  clock: { now: number };
  binance: SimulatedVenue;
  bybit: SimulatedVenue;
  aster: SimulatedAster;
  store: Store;
  ex: Executor;
  /** Moves the clock forward in lease-safe steps, renewing the lease like the entry heartbeat does. */
  advance(ms: number): void;
  /** A second executor instance on the same database file, as after a restart. */
  restart(options?: { budgets?: Partial<Budgets> }): Executor;
  dispose(): void;
}

export const FAST: Partial<Budgets> = { callTimeoutMs: 50 };

/** control is called once per executor instance, so each restart gets its own registry writer. */
export function createHarness({ budgets = {}, control }: { budgets?: Partial<Budgets>; control?: (clock: { now: number }) => ExecutorOptions['control'] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pa-executor-'));
  const file = join(dir, 'executor.sqlite');
  const clock = { now: START };
  const now = () => clock.now;
  const { binance, bybit, aster } = createSimulatedVenues(now);
  const stores: Store[] = [];
  const make = (extra: Partial<Budgets> = {}) => {
    const store = openStore(file);
    stores.push(store);
    return { store, ex: createExecutor({ store, connectors: [binance, bybit], transfers: aster, now, budgets: { ...FAST, ...budgets, ...extra }, control: control?.(clock) }) };
  };
  const first = make();
  first.ex.acquire();
  const harness: Harness = {
    dir, file, clock, binance, bybit, aster, store: first.store, ex: first.ex,
    advance(ms) {
      let left = ms;
      while (left > 0) { const step = Math.min(left, 10_000); clock.now += step; left -= step; harness.ex.acquire(); }
    },
    restart(options = {}) {
      const next = make(options.budgets);
      harness.store = next.store; harness.ex = next.ex;
      return next.ex;
    },
    dispose() {
      for (const store of stores) store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

export function bindAccounts(ex: Executor): void {
  for (const binding of SIM_BINDINGS) ex.registerAccount(binding);
}

export const openIntent = (overrides: { quantity?: [string, string]; orderType?: 'market' | 'limit'; limitPrice?: string; timeoutMs?: number; action?: 'open' | 'close' } = {}) => ({
  market: 'oil', preset: 'cross-exchange', symbol: 'CLUSDT', action: overrides.action ?? 'open', timeoutMs: overrides.timeoutMs ?? 60_000,
  legs: [
    { venue: 'binance', side: 'long', quantity: overrides.quantity?.[0] ?? '1', orderType: overrides.orderType ?? 'market', ...(overrides.limitPrice ? { limitPrice: overrides.limitPrice } : {}) },
    { venue: 'bybit', side: 'short', quantity: overrides.quantity?.[1] ?? '1', orderType: 'market' },
  ],
});

/** Bybit native chase lead, Binance market hedge. */
export const chaseIntent = ({ quantity = '1', timeoutMs = 60_000, symbol = 'CLUSDT' }: { quantity?: string; timeoutMs?: number; symbol?: string } = {}) => ({
  market: 'oil', preset: 'cross-exchange', symbol, action: 'open', timeoutMs,
  legs: [{ venue: 'bybit', side: 'long', quantity, orderType: 'chase' }, { venue: 'binance', side: 'short', quantity, orderType: 'market' }],
});

export async function previewAndConfirm(h: Harness, intent: unknown = openIntent()) {
  const preview = await h.ex.preview(intent, SESSION);
  const requestId = randomUUID();
  const result = h.ex.confirm({ previewId: preview.id, requestId, confirmLive: true }, SESSION);
  return { preview, requestId, jobId: result.job.id, result };
}

/** Runs ticks until the job is final or the budget runs out; each tick moves the clock by stepMs. */
export async function settle(h: Harness, jobId: string, { ticks = 20, stepMs = 1_000 } = {}) {
  for (let i = 0; i < ticks; i++) {
    await h.ex.tick();
    const view = h.ex.jobView(jobId);
    if (['completed', 'failed', 'stopped', 'attention'].includes(view.status)) return view;
    h.advance(stepMs);
  }
  return h.ex.jobView(jobId);
}
