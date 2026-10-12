import { D } from './money.mjs';

export function resolveFee(config, quote, role = 'taker') {
  if (!['maker', 'taker'].includes(role)) throw new RangeError('手续费角色无效');
  const schedule = config.feeSchedule ?? [];
  const specific = schedule.find(item => item.exchange === quote.exchange && item.symbol === quote.symbol);
  const venue = schedule.find(item => item.exchange === quote.exchange && !item.symbol);
  const item = specific ?? venue;
  return item
    ? { bps: item[`${role}Bps`], source: item.source, updatedAt: item.updatedAt ?? null }
    : { bps: config.feeBps, source: 'legacy-feeBps', updatedAt: null };
}

export function feeSnapshot(config, long, short) {
  const longFee = resolveFee(config, long), shortFee = resolveFee(config, short);
  // Simulated market executions are taker on both entry and exit.
  return { long: { entry: { ...longFee }, exit: { ...longFee } }, short: { entry: { ...shortFee }, exit: { ...shortFee } } };
}

export function roundTripFeeBps(snapshot) {
  return D(snapshot.long.entry.bps).plus(snapshot.long.exit.bps).plus(snapshot.short.entry.bps).plus(snapshot.short.exit.bps).toNumber();
}
