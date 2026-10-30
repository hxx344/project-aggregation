// Test double for lib/store.ts dependencies with external effects: exchange reads, credential
// sealing, positions cache and the database file. Loaded only through the hooks in store-sync-lock.test.ts.
import { openDatabase } from '../../lib/sqlite.ts';
import type { Balance, FxStatus } from '../../lib/types.ts';

type Pending = { wallet: string; resolve: (total: number) => void; reject: (error: Error) => void };
export const control = {
  /** Aster reads for these wallets wait for the test; others answer at once with `values`. */
  held: new Set<string>(),
  values: new Map<string, number>(),
  pending: [] as Pending[],
  usdc: 1,
};

let database: ReturnType<typeof openDatabase> | undefined;
export const db = () => database ??= openDatabase(':memory:');

let sealed = 0;
export async function seal(value: unknown, owner: string) { return JSON.stringify({ owner, value, version: ++sealed }); }
export async function unseal(value: string, owner: string) {
  const data = JSON.parse(value);
  if (data.owner !== owner) throw new Error('decrypt failed');
  return data.value;
}

const failed = async (): Promise<never> => { throw new Error('not configured in this test'); };
export const syncBybit = failed, syncBinance = failed, syncOkx = failed, syncGate = failed, syncVariational = failed;
export async function quotes() {
  const at = new Date().toISOString();
  return { VIRTUAL: { price: 1, at, source: 'test' }, USDC: { price: control.usdc, at, source: 'test' } };
}
export async function yuanQuote(): Promise<{ rate: number; status: FxStatus }> {
  return { rate: 7.25, status: { source: 'Frankfurter', fetchedAt: new Date().toISOString(), rateDate: null, error: null } };
}
export const validateAsterWallet = (c: { walletAddress: string }) => ({ address: c.walletAddress });
export function syncAster(c: { walletAddress: string }): Promise<{ total: number; details: Balance[] }> {
  const answer = (total: number) => ({ total, details: [] });
  if (!control.held.has(c.walletAddress)) return Promise.resolve(answer(control.values.get(c.walletAddress) ?? 0));
  return new Promise((resolve, reject) => control.pending.push({ wallet: c.walletAddress, resolve: total => resolve(answer(total)), reject }));
}
export const hubPositionsService = { peek: async () => null };
