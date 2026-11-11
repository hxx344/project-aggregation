// Seeded simulated venues shared by the entry point, the load measurement and
// the tests. Venue state lives in memory and is lost when the process exits.
import { SimulatedVenue } from './sim-venue.ts';
import { SimulatedAster } from './sim-aster.ts';
import { SimulatedAsterTrading } from './sim-aster-trading.ts';

export const SIM_ACCOUNTS = { binance: 'BN1001', bybit: 'BY2002' } as const;

/** One ASTER main account with the two sub-accounts of a pair; the long side starts richer, so an enabled pair has something to balance. */
export const SIM_TRANSFER_PAIR = { id: 'sim-pair', mainAccountId: `0x${'a'.repeat(40)}`, long: `0x${'b'.repeat(40)}`, short: `0x${'c'.repeat(40)}` } as const;

export function createSimulatedVenues(clock: () => number): { binance: SimulatedVenue; bybit: SimulatedVenue; aster: SimulatedAster; asterTrading: SimulatedAsterTrading } {
  const binance = new SimulatedVenue('binance', clock);
  const bybit = new SimulatedVenue('bybit', clock);
  const rules = { kind: 'linear-perpetual' as const, settleAsset: 'USDT' as const, contractSize: '1', tickSize: '0.01', maxQuantity: '10000', maxMarketQuantity: '1000', minNotional: '5', catalogVersion: 'sim-1' };
  binance.listInstrument({ ...rules, symbol: 'CLUSDT', quantityStep: '0.01', minQuantity: '0.01' }, { bid: '70.00', ask: '70.02' });
  binance.listInstrument({ ...rules, symbol: 'BZUSDT', quantityStep: '0.01', minQuantity: '0.01' }, { bid: '74.10', ask: '74.12' });
  binance.listInstrument({ ...rules, symbol: 'ANTHROPICUSDT', quantityStep: '0.001', minQuantity: '0.001' }, { bid: '410.5', ask: '410.9' });
  bybit.listInstrument({ ...rules, symbol: 'CLUSDT', quantityStep: '0.1', minQuantity: '0.1' }, { bid: '70.05', ask: '70.07' });
  bybit.listInstrument({ ...rules, symbol: 'BZUSDT', quantityStep: '0.1', minQuantity: '0.1' }, { bid: '74.15', ask: '74.17' });
  binance.openAccount(SIM_ACCOUNTS.binance, { CLUSDT: 'one-way', BZUSDT: 'one-way', ANTHROPICUSDT: 'one-way' });
  bybit.openAccount(SIM_ACCOUNTS.bybit, { CLUSDT: 'one-way', BZUSDT: 'one-way' });
  const aster = new SimulatedAster(clock);
  aster.openSubAccount(SIM_TRANSFER_PAIR.mainAccountId, SIM_TRANSFER_PAIR.long, { available: '600' });
  aster.openSubAccount(SIM_TRANSFER_PAIR.mainAccountId, SIM_TRANSFER_PAIR.short, { available: '400' });
  // The pair's hedge: long BTCUSDT on the long side, the same short on the short side, so the totals start equal.
  const asterTrading = new SimulatedAsterTrading(clock);
  asterTrading.listRule({ symbol: 'BTCUSDT' }, '60000');
  asterTrading.openAccount(SIM_TRANSFER_PAIR.long);
  asterTrading.openAccount(SIM_TRANSFER_PAIR.short);
  asterTrading.setPosition(SIM_TRANSFER_PAIR.long, 'BTCUSDT', 'LONG', '0.05');
  asterTrading.setPosition(SIM_TRANSFER_PAIR.short, 'BTCUSDT', 'SHORT', '-0.05');
  return { binance, bybit, aster, asterTrading };
}

export const SIM_BINDINGS = [
  { venue: 'binance', environment: 'simulated', accountId: SIM_ACCOUNTS.binance, accountMode: 'standard', credentialVersion: 1 },
  { venue: 'bybit', environment: 'simulated', accountId: SIM_ACCOUNTS.bybit, accountMode: 'unified', credentialVersion: 1 },
] as const;
